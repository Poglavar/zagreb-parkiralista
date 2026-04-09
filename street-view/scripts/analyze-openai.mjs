// This script sends multi-image segment bundles to OpenAI and records structured parking assessments.
import { readFile } from "fs/promises";
import { pathToFileURL } from "url";
import { ASSESSMENT_SCHEMA, SYSTEM_PROMPT, buildUserPrompt } from "./lib/assessment-schema.mjs";
import {
  calculateOpenAiUsageCost,
  estimateOpenAiImageInputCost,
  parseSizeString,
  summarizeOpenAiCosts,
  summarizeOpenAiImageEstimate
} from "./lib/billing.mjs";
import { fileExists, readJson, resolveFrom, writeJson, writeText } from "./lib/io.mjs";
import { waitForRequestGap } from "./lib/rate-limit.mjs";

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    images: resolveFrom(import.meta.url, "../out/street-view-images.json"),
    out: resolveFrom(import.meta.url, "../out/openai-analyses.json"),
    keyEnv: "OPENAI_API_KEY",
    model: "gpt-5.4",
    delayMs: 1000,
    imageDetail: "auto",
    batchJsonl: null,
    segmentId: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (argv[i] === "--image-detail") args.imageDetail = argv[++i];
    else if (argv[i] === "--batch-jsonl") args.batchJsonl = argv[++i];
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-openai.mjs [--batch-jsonl path] [--model gpt-5.4] [--delay-ms 1000] [--image-detail auto|low|high] [--segment-id id]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const collected = [];
  for (const outputItem of payload.output || []) {
    for (const contentItem of outputItem.content || []) {
      if (typeof contentItem.text === "string") {
        collected.push(contentItem.text);
      }
    }
  }
  return collected.join("\n").trim();
}

async function imageToDataUrl(filePath) {
  const buffer = await readFile(filePath);
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

function buildRequestBody(segment, imageDataUrls, model, imageDetail) {
  const content = [{ type: "input_text", text: buildUserPrompt(segment) }];
  imageDataUrls.forEach((imageUrl, index) => {
    content.push({ type: "input_text", text: `Image ${index + 1}` });
    content.push({ type: "input_image", image_url: imageUrl, detail: imageDetail });
  });

  return {
    model,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: SYSTEM_PROMPT }]
      },
      {
        role: "user",
        content
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "street_view_parking_assessment",
        strict: true,
        schema: ASSESSMENT_SCHEMA
      }
    }
  };
}

export async function analyzeWithOpenAi({ candidates, images, out, keyEnv, model, delayMs, imageDetail, batchJsonl, segmentId }) {
  const candidateData = await readJson(candidates);
  const imageManifest = await readJson(images);
  const imageByCaptureId = new Map(
    (imageManifest.images || [])
      .filter((item) => item.ok && item.image_path)
      .map((item) => [item.capture_id, item.image_path])
  );

  const segmentsWithImages = [];
  for (const segment of candidateData.segments) {
    if (segmentId && String(segment.segment_id) !== String(segmentId)) {
      continue;
    }
    const availableCaptures = [];
    for (const capture of segment.captures) {
      const relativePath = imageByCaptureId.get(capture.capture_id);
      if (!relativePath) continue;
      const absolutePath = resolveFrom(import.meta.url, "..", relativePath.replace(/^out\//, "out/"));
      if (await fileExists(absolutePath)) {
        availableCaptures.push({ capture, absolutePath });
      }
    }
    if (availableCaptures.length > 0) {
      segmentsWithImages.push({ segment, availableCaptures });
    }
  }

  const captureSize = parseSizeString(candidateData.capture_settings?.size);
  const totalImageCount = segmentsWithImages.reduce((sum, item) => sum + item.availableCaptures.length, 0);
  const runImageEstimate = captureSize
    ? estimateOpenAiImageInputCost({
        model,
        imageCount: totalImageCount,
        width: captureSize.width,
        height: captureSize.height,
        detail: imageDetail,
        batchMode: Boolean(batchJsonl)
      })
    : null;

  console.log(
    `OpenAI analysis run: ${segmentsWithImages.length} segments, ${totalImageCount} images, detail=${imageDetail}, ${delayMs}ms spacing, ${summarizeOpenAiImageEstimate(runImageEstimate)} before text/output tokens.`
  );

  if (batchJsonl) {
    const lines = [];
    for (const item of segmentsWithImages) {
      const imageDataUrls = [];
      for (const captureItem of item.availableCaptures) {
        imageDataUrls.push(await imageToDataUrl(captureItem.absolutePath));
      }
      const body = buildRequestBody(item.segment, imageDataUrls, model, imageDetail);
      lines.push(
        JSON.stringify({
          custom_id: `segment-${item.segment.segment_id}`,
          method: "POST",
          url: "/v1/responses",
          body
        })
      );
    }
    await writeText(batchJsonl, lines.join("\n") + "\n");
    console.log(`Wrote ${lines.length} Batch API requests to ${batchJsonl}`);
    return;
  }

  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${keyEnv} in the environment.`);
  }

  const results = [];
  for (const [index, item] of segmentsWithImages.entries()) {
    await waitForRequestGap(delayMs, index);
    const imageDataUrls = [];
    for (const captureItem of item.availableCaptures) {
      imageDataUrls.push(await imageToDataUrl(captureItem.absolutePath));
    }

    const body = buildRequestBody(item.segment, imageDataUrls, model, imageDetail);
    const perSegmentEstimate = captureSize
      ? estimateOpenAiImageInputCost({
          model,
          imageCount: item.availableCaptures.length,
          width: captureSize.width,
          height: captureSize.height,
          detail: imageDetail
        })
      : null;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      results.push({
        segment_id: item.segment.segment_id,
        ok: false,
        image_count: item.availableCaptures.length,
        estimated_image_input_cost_usd: perSegmentEstimate?.estimated_image_input_cost_usd || null,
        error: `HTTP ${response.status}: ${errorText}`
      });
      continue;
    }

    const payload = await response.json();
    const rawText = extractOutputText(payload);
    const usageCost = calculateOpenAiUsageCost({ model, usage: payload.usage });
    results.push({
      segment_id: item.segment.segment_id,
      ok: true,
      image_count: item.availableCaptures.length,
      response_id: payload.id,
      model,
      image_detail: imageDetail,
      usage: payload.usage || null,
      estimated_image_input_cost_usd: perSegmentEstimate?.estimated_image_input_cost_usd || null,
      cost_usd: usageCost?.estimated_cost_usd || null,
      raw_text: rawText,
      assessment: JSON.parse(rawText)
    });
    const totalCostLabel = usageCost ? `$${usageCost.estimated_cost_usd.total.toFixed(6)}` : "unknown";
    console.log(
      `Analyzed segment ${item.segment.segment_id} | images=${item.availableCaptures.length} | actual approx cost=${totalCostLabel}`
    );
  }

  const actualCostSummary = summarizeOpenAiCosts(results.map((item) => calculateOpenAiUsageCost({ model, usage: item.usage })));

  await writeJson(out, {
    generated_at: new Date().toISOString(),
    model,
    candidates,
    images,
    throttle_delay_ms: delayMs,
    image_detail: imageDetail,
    billing: {
      image_input_estimate: runImageEstimate,
      actual_usage_summary: actualCostSummary
    },
    results
  });

  console.log(`Wrote OpenAI analyses to ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await analyzeWithOpenAi(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
