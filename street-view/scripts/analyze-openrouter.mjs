// Sends segment images to any OpenRouter-hosted model for parking assessment —
// Kimi 3 by default, but the same code reaches Gemini, Qwen, Llama and the rest, which is
// the point: one engine, many vendors to compare against on identical segments.
//
// Same prompt + schema as the other engines, so build-parking-areas and ingest-to-db
// consume the output unchanged.
//
// COST. Unlike claude-cli and codex-cli, this bills a metered API key, so every segment's
// real cost is recorded. OpenRouter returns the authoritative figure in the generation
// record rather than making us guess from token counts and a price table that goes stale,
// so cost_usd here is what was actually charged, not an estimate.
//
// Progressive + resumable: results are flushed to --out after every segment, and segments
// already ok in an existing output file are skipped on restart.
import { readFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { ASSESSMENT_SCHEMA, SYSTEM_PROMPT, buildUserPrompt } from "./lib/assessment-schema.mjs";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";
import { reportProgress } from "./lib/progress.mjs";

// The shared ledger lives in a sibling checkout, so a repo without it still runs unaccounted
// rather than failing to start.
let recordSpend = null;
try {
  ({ record: recordSpend } = await import("../../../agents/lib/llm-cost/index.mjs"));
} catch {
  console.warn("[llm-cost] shared ledger unavailable; spend recorded locally only");
}

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const GENERATION_URL = "https://openrouter.ai/api/v1/generation";

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    images: resolveFrom(import.meta.url, "../out/street-view-images.json"),
    out: resolveFrom(import.meta.url, "../out/openrouter-analyses.json"),
    model: "moonshotai/kimi-k3",
    keyEnv: "OPENROUTER_API_KEY",
    workers: 3,
    limit: null,
    maxCostUsd: null,
    segmentId: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--max-cost-usd") args.maxCostUsd = Number(argv[++i]);
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-openrouter.mjs --candidates path --images path --out path [--model moonshotai/kimi-k3] [--limit N] [--max-cost-usd 5] [--workers 3]");
      console.log("Runs parking assessment through OpenRouter. METERED — needs OPENROUTER_API_KEY and costs real money per segment.");
      console.log("--max-cost-usd stops the run cleanly once spend passes the ceiling; the partial output stays resumable.");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

// OpenRouter passes json_schema through to whichever vendor is behind the model, and the
// strict validators among them demand every property be listed in `required`.
// ASSESSMENT_SCHEMA leaves some optional (road_geometry.notes), so send a strictified copy.
function strictify(node) {
  if (Array.isArray(node)) return node.map(strictify);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = strictify(v);
    if (out.type === "object" && out.properties) out.required = Object.keys(out.properties);
    return out;
  }
  return node;
}

async function imageDataUrl(absolutePath) {
  const buf = await readFile(absolutePath);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function buildMessages(segment, captureItems) {
  const content = [{
    type: "text",
    text: [
      buildUserPrompt(segment),
      "",
      "The images follow in this order:",
      ...captureItems.map(({ capture }, idx) =>
        `Image ${idx + 1}: capture ${capture.capture_id} (Station ${(capture.station_index || 0) + 1}, ${capture.direction})`),
      "",
      "IMPORTANT: station_index in your output is ZERO-BASED — the images' \"Station 1\" is station_index 0."
    ].join("\n")
  }];
  for (const { absolutePath } of captureItems) {
    content.push({ type: "image_url", image_url: { url: await imageDataUrl(absolutePath) } });
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content }
  ];
}

// OpenRouter's own accounting, fetched after the fact. Worth the extra round trip: it is
// the amount actually billed, including whatever the upstream vendor charged for image
// tokens, which a local token x price estimate routinely gets wrong.
async function fetchGenerationCost(generationId, apiKey) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await fetch(`${GENERATION_URL}?id=${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (resp.ok) {
        const body = await resp.json();
        const d = body.data || {};
        if (typeof d.total_cost === "number") {
          return {
            cost_usd: d.total_cost,
            native_tokens_prompt: d.native_tokens_prompt ?? null,
            native_tokens_completion: d.native_tokens_completion ?? null
          };
        }
      }
    } catch {
      // fall through to retry — the record lags the completion by a moment
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return null;
}

async function callOpenRouter(messages, model, apiKey) {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter attributes usage in its dashboard by these; makes the spend on this
      // project distinguishable from everything else on the key.
      "HTTP-Referer": "https://zagreb.lol/parkiralista",
      "X-Title": "zagreb-parkiralista street-view"
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "parking_assessment", strict: true, schema: strictify(ASSESSMENT_SCHEMA) }
      }
    })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${text.slice(0, 400)}`);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OpenRouter response was not JSON: ${text.slice(0, 300)}`);
  }
  // A 200 can still carry an error body (upstream vendor refused, model unavailable).
  // Without this check that surfaces later as an unparseable "assessment".
  if (body.error) throw new Error(`OpenRouter error: ${body.error.message || JSON.stringify(body.error).slice(0, 300)}`);

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenRouter returned no content: ${text.slice(0, 300)}`);

  let assessment;
  try {
    assessment = JSON.parse(content);
  } catch (err) {
    throw new Error(`Model output was not valid JSON: ${err.message}: ${String(content).slice(0, 300)}`);
  }

  return {
    assessment,
    generationId: body.id || null,
    usage: body.usage || null,
    resolvedModel: body.model || model
  };
}

export async function analyzeWithOpenRouter({ candidates, images, out, model, keyEnv, workers, limit, maxCostUsd, segmentId }) {
  const apiKey = process.env[keyEnv || "OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error(`Missing ${keyEnv || "OPENROUTER_API_KEY"} in the environment.`);

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
      if (await fileExists(absolutePath)) availableCaptures.push({ capture, absolutePath });
    }
    if (availableCaptures.length > 0) segmentsWithImages.push({ segment, availableCaptures });
  }

  // Resume: keep prior ok results, only process what's missing.
  let results = [];
  if (await fileExists(out)) {
    const prior = await readJson(out);
    results = (prior.results || []).filter((r) => r.ok);
    const done = new Set(results.map((r) => String(r.segment_id)));
    const before = segmentsWithImages.length;
    for (let i = segmentsWithImages.length - 1; i >= 0; i -= 1) {
      if (done.has(String(segmentsWithImages[i].segment.segment_id))) segmentsWithImages.splice(i, 1);
    }
    if (before !== segmentsWithImages.length) {
      log(`Resume: ${before - segmentsWithImages.length} segments already done in ${path.basename(out)}`);
    }
  }

  const queue = limit ? segmentsWithImages.slice(0, limit) : segmentsWithImages;
  log(`openrouter analysis: ${queue.length} segments to process, model=${model}, workers=${workers}`);
  log(`METERED ENGINE — this run bills ${keyEnv || "OPENROUTER_API_KEY"}. Cost is reported per segment below.`);
  if (maxCostUsd) log(`Spend ceiling: $${maxCostUsd.toFixed(2)} — the run stops cleanly once it is reached.`);

  let processed = 0;
  let totalCost = results.reduce((s, r) => s + (r.cost_usd || 0), 0);
  let costUnknown = 0;
  let stoppedOnBudget = false;
  const startedAt = Date.now();

  const flush = async () => {
    await writeJson(out, {
      generated_at: new Date().toISOString(),
      model,
      provider: "openrouter",
      engine: "openrouter",
      billing: {
        total_nominal_cost_usd: Number(totalCost.toFixed(6)),
        segments_with_unknown_cost: costUnknown,
        note: "metered via OpenRouter; cost_usd is the amount actually billed per generation"
      },
      results
    });
  };

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < queue.length) {
      // Checked every segment, not every N, so the ceiling actually bounds the spend.
      if (maxCostUsd && totalCost >= maxCostUsd) {
        stoppedOnBudget = true;
        return;
      }
      const item = queue[nextIndex++];
      const segId = item.segment.segment_id;
      const t0 = Date.now();
      try {
        const messages = await buildMessages(item.segment, item.availableCaptures);
        const { assessment, generationId, usage, resolvedModel } = await callOpenRouter(messages, model, apiKey);

        let cost = null;
        let native = null;
        if (generationId) {
          const gen = await fetchGenerationCost(generationId, apiKey);
          if (gen) {
            cost = gen.cost_usd;
            native = gen;
          }
        }
        if (typeof cost === "number") totalCost += cost;
        else costUnknown += 1;   // counted, never silently treated as free

        // Into the shared ledger, with OpenRouter's own billed figure rather than a computed one:
        // it charges what it charges, and a local token x price estimate routinely disagrees. A
        // generation whose cost never came back is left out rather than recorded as free.
        if (recordSpend && typeof cost === "number") {
          try {
            recordSpend({
              repo: "zagreb-parkiralista", script: "analyze-openrouter", model: resolvedModel || model,
              usage: {
                input_tokens: usage?.prompt_tokens ?? 0,
                output_tokens: usage?.completion_tokens ?? 0,
              },
              cost_usd: cost,
              meta: { segmentId: segId, generationId, via: "openrouter" },
            });
          } catch (error) {
            log(`  [llm-cost] not recorded: ${error.message}`);
          }
        }

        results.push({
          segment_id: segId,
          ok: true,
          model: resolvedModel,
          generation_id: generationId,
          usage: usage || native || null,
          cost_usd: cost,
          assessment
        });
        processed += 1;
        const eta = Math.round(((Date.now() - startedAt) / processed) * (queue.length - processed) / 1000);
        log(`Segment ${segId}: ok in ${Math.round((Date.now() - t0) / 1000)}s, ` +
            `${typeof cost === "number" ? `$${cost.toFixed(5)}` : "cost unknown"} ` +
            `(running $${totalCost.toFixed(4)}, ${processed}/${queue.length}, eta ${eta}s)`);
      } catch (err) {
        results.push({ segment_id: segId, ok: false, error: err.message });
        processed += 1;
        log(`Segment ${segId}: FAIL — ${err.message}`);
      }
      reportProgress("sv-analyze-openrouter", {
        current: processed, total: queue.length,
        message: `segment ${segId} · $${totalCost.toFixed(4)}`,
        area: (out.match(/out\/([^/]+)\//) || [])[1] || null
      });
      await flush();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => worker()));
  await flush();
  reportProgress("sv-analyze-openrouter", {
    current: processed, total: queue.length, message: "finished", done: true,
    area: (out.match(/out\/([^/]+)\//) || [])[1] || null
  });

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  log(`Done: ${okCount}/${results.length} ok. Total billed $${totalCost.toFixed(4)}. Wrote ${out}`);
  if (costUnknown > 0) {
    log(`NOTE: ${costUnknown} segment(s) have no cost record — the real total is HIGHER than the figure above.`);
  }
  if (stoppedOnBudget) {
    log(`STOPPED on the $${maxCostUsd.toFixed(2)} ceiling with ${queue.length - processed} segments unprocessed. Re-run to continue.`);
  }
  // Per-item failures must poison the verdict rather than being logged and forgotten.
  if (failCount > 0) {
    throw new Error(`${failCount} of ${results.length} segments failed — see ${path.basename(out)}. Re-run to retry only those.`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  await analyzeWithOpenRouter(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
