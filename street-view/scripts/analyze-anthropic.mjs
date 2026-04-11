// Sends segment images to Anthropic Claude for parking assessment. Same prompt as OpenAI, different API.
import { readFile } from "fs/promises";
import { pathToFileURL } from "url";
import { ASSESSMENT_SCHEMA, SYSTEM_PROMPT, buildUserPrompt } from "./lib/assessment-schema.mjs";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";
import { waitForRequestGap } from "./lib/rate-limit.mjs";

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    images: resolveFrom(import.meta.url, "../out/street-view-images.json"),
    out: resolveFrom(import.meta.url, "../out/anthropic-analyses.json"),
    keyEnv: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-6",
    delayMs: 1000,
    segmentId: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-anthropic.mjs --candidates path --images path [--segment-id id] [--model claude-sonnet-4-6]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

async function imageToBase64(filePath) {
  const buffer = await readFile(filePath);
  return buffer.toString("base64");
}

function buildAnthropicContent(segment, captureItems, imageDetail) {
  const content = [{ type: "text", text: buildUserPrompt(segment) }];

  for (const captureItem of captureItems) {
    const cap = captureItem.capture;
    const label = `Image: ${cap.capture_id} (Station ${(cap.station_index || 0) + 1}, ${cap.direction})`;
    content.push({ type: "text", text: label });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: captureItem.base64 }
    });
  }

  // Ask for JSON output matching our schema
  content.push({
    type: "text",
    text: `Respond with a JSON object matching this schema:\n${JSON.stringify(ASSESSMENT_SCHEMA, null, 2)}\n\nOutput ONLY the JSON, no other text.`
  });

  return content;
}

export async function analyzeWithAnthropic({ candidates, images, out, keyEnv, model, delayMs, segmentId }) {
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${keyEnv} in the environment.`);
  }

  const candidateData = await readJson(candidates);
  const imageManifest = await readJson(images);
  const imageByCaptureId = new Map(
    (imageManifest.images || [])
      .filter((item) => item.ok && item.image_path)
      .map((item) => [item.capture_id, item.image_path])
  );

  const segmentsWithImages = [];
  for (const segment of candidateData.segments) {
    if (segmentId && String(segment.segment_id) !== String(segmentId)) continue;
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

  console.log(`Anthropic analysis: ${segmentsWithImages.length} segments, model=${model}, ${delayMs}ms spacing`);

  const results = [];
  for (const [index, item] of segmentsWithImages.entries()) {
    await waitForRequestGap(delayMs, index);

    // Load images as base64
    for (const captureItem of item.availableCaptures) {
      captureItem.base64 = await imageToBase64(captureItem.absolutePath);
    }

    const content = buildAnthropicContent(item.segment, item.availableCaptures, "auto");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Segment ${item.segment.segment_id}: HTTP ${response.status}: ${errorText}`);
      results.push({ segment_id: item.segment.segment_id, ok: false, error: `HTTP ${response.status}: ${errorText}` });
      continue;
    }

    const payload = await response.json();
    const rawText = (payload.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    const usage = payload.usage || {};

    // Extract JSON from response (Claude might wrap in markdown code blocks)
    let jsonText = rawText;
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonText = jsonMatch[1].trim();

    let assessment;
    try {
      assessment = JSON.parse(jsonText);
    } catch {
      console.error(`Segment ${item.segment.segment_id}: failed to parse JSON`);
      results.push({ segment_id: item.segment.segment_id, ok: false, error: `JSON parse error: ${jsonText.slice(0, 200)}` });
      continue;
    }

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    // Anthropic pricing: Sonnet 4.6 $3/1M input, $15/1M output
    const costUsd = (inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15;

    results.push({
      segment_id: item.segment.segment_id,
      ok: true,
      response_id: payload.id,
      model,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      cost_usd: Number(costUsd.toFixed(6)),
      raw_text: rawText,
      assessment
    });

    console.log(`Segment ${item.segment.segment_id}: ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(4)}`);
  }

  const totalCost = results.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  await writeJson(out, {
    generated_at: new Date().toISOString(),
    model,
    provider: "anthropic",
    billing: { total_cost_usd: Number(totalCost.toFixed(6)) },
    results
  });

  console.log(`\nWrote ${results.length} results to ${out}`);
  console.log(`Total cost: $${totalCost.toFixed(4)}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await analyzeWithAnthropic(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
