// Downloads completed OpenAI batch results and converts them to analyses JSON.
// Supports multi-chunk trackers from the chunked submit script.
import { pathToFileURL } from "url";
import { readFile } from "fs/promises";
import { calculateOpenAiUsageCost, summarizeOpenAiCosts } from "./lib/billing.mjs";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    tracker: resolveFrom(import.meta.url, "../out/openai-batch-status.json"),
    batchId: null,
    resultsJsonl: null,
    out: null,
    keyEnv: "OPENAI_API_KEY",
    status: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tracker") args.tracker = argv[++i];
    else if (argv[i] === "--batch-id") args.batchId = argv[++i];
    else if (argv[i] === "--results-jsonl") args.resultsJsonl = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--status") args.status = true;
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/import-openai-batch.mjs [--tracker path] [--status] [--out path]");
      console.log("");
      console.log("Checks all batch chunks, downloads completed results, writes analyses JSON.");
      console.log("  --status   Show status of all chunks and exit.");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function extractOutputText(body) {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  const collected = [];
  for (const outputItem of body.output || []) {
    for (const contentItem of outputItem.content || []) {
      if (typeof contentItem.text === "string") collected.push(contentItem.text);
    }
  }
  return collected.join("\n").trim();
}

export function parseBatchResultsJsonl(jsonlText) {
  const lines = jsonlText.trim().split("\n").filter(Boolean);
  const results = [];
  for (const line of lines) {
    const entry = JSON.parse(line);
    const segmentId = (entry.custom_id || "").replace(/^segment-/, "");
    if (entry.error) {
      results.push({ segment_id: segmentId, ok: false, error: entry.error.message || JSON.stringify(entry.error) });
      continue;
    }
    const response = entry.response;
    if (!response || response.status_code !== 200) {
      results.push({ segment_id: segmentId, ok: false, error: `HTTP ${response?.status_code || "unknown"}` });
      continue;
    }
    const body = response.body;
    const rawText = extractOutputText(body);
    let assessment;
    try { assessment = JSON.parse(rawText); } catch {
      results.push({ segment_id: segmentId, ok: false, error: `Failed to parse JSON: ${rawText.slice(0, 200)}` });
      continue;
    }
    results.push({
      segment_id: segmentId, ok: true, response_id: body.id || null,
      model: body.model || null, usage: body.usage || null,
      raw_text: rawText, assessment
    });
  }
  return results;
}

async function fetchBatchStatus(apiKey, batchId) {
  const resp = await fetch(`https://api.openai.com/v1/batches/${batchId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!resp.ok) throw new Error(`Batch status fetch failed: ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function downloadOutputFile(apiKey, fileId) {
  const resp = await fetch(`https://api.openai.com/v1/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!resp.ok) throw new Error(`File download failed: ${resp.status}: ${await resp.text()}`);
  return resp.text();
}

export async function importOpenAiBatch({ tracker, batchId, resultsJsonl, out, keyEnv, status }) {
  // Single batch ID mode (backwards compat)
  if (batchId || resultsJsonl) {
    return importSingleBatch({ batchId, resultsJsonl, out, keyEnv, status, tracker });
  }

  if (!(await fileExists(tracker))) {
    throw new Error(`Tracker not found: ${tracker}. Run submit-openai-batch.mjs first.`);
  }

  const trackerData = await readJson(tracker);

  // Old single-batch tracker format
  if (trackerData.batch_id && !trackerData.chunks) {
    return importSingleBatch({ batchId: trackerData.batch_id, out, keyEnv, status, tracker });
  }

  // Multi-chunk tracker
  const chunks = trackerData.chunks || [];
  if (!chunks.length) {
    throw new Error("Tracker has no chunks.");
  }

  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`Missing ${keyEnv} in the environment.`);

  console.log(`Tracker: ${chunks.length} chunks, ${trackerData.total_requests} total requests\n`);

  let allCompleted = true;
  let totalCostUsd = 0;
  const chunkStatuses = [];

  for (const chunk of chunks) {
    const batch = await fetchBatchStatus(apiKey, chunk.batch_id);
    const rc = batch.request_counts || {};
    const costLine = batch.status === "completed" ? "" : "";
    console.log(`  Chunk ${chunk.chunk_index + 1}: ${batch.status} — ${rc.completed || 0}/${rc.total || chunk.request_count} completed, ${rc.failed || 0} failed`);
    chunkStatuses.push({ ...chunk, api_status: batch.status, request_counts: rc, output_file_id: batch.output_file_id });

    if (batch.status !== "completed") allCompleted = false;
  }
  console.log("");

  if (status) return;

  if (!allCompleted) {
    const pending = chunkStatuses.filter((c) => !["completed", "failed", "expired", "cancelled"].includes(c.api_status));
    const failed = chunkStatuses.filter((c) => ["failed", "expired", "cancelled"].includes(c.api_status));
    if (pending.length) console.log(`${pending.length} chunk(s) still processing. Run again later.`);
    if (failed.length) console.log(`${failed.length} chunk(s) failed. These can be resubmitted.`);
    if (!pending.length && failed.length) {
      console.log("All remaining chunks have failed. Importing completed chunks only.");
    } else if (pending.length) {
      return;
    }
  }

  // Download and merge results from completed chunks
  const allResults = [];
  for (const chunk of chunkStatuses) {
    if (chunk.api_status !== "completed" || !chunk.output_file_id) continue;
    console.log(`Downloading chunk ${chunk.chunk_index + 1} results...`);
    const jsonlText = await downloadOutputFile(apiKey, chunk.output_file_id);
    const results = parseBatchResultsJsonl(jsonlText);

    // Calculate cost for this chunk
    const model = results.find((r) => r.ok)?.model || "gpt-5.4";
    const costItems = results.filter((r) => r.ok && r.usage).map((r) => calculateOpenAiUsageCost({ model: r.model || model, usage: r.usage, batchMode: true }));
    const chunkCost = summarizeOpenAiCosts(costItems);
    totalCostUsd += chunkCost.estimated_cost_usd.total;
    console.log(`  ${results.filter((r) => r.ok).length} ok, ${results.filter((r) => !r.ok).length} failed — chunk cost: $${chunkCost.estimated_cost_usd.total.toFixed(4)}`);

    allResults.push(...results);
  }

  const okCount = allResults.filter((r) => r.ok).length;
  const failCount = allResults.filter((r) => !r.ok).length;
  console.log(`\nTotal: ${allResults.length} results — ${okCount} ok, ${failCount} failed`);
  console.log(`Total cost: $${totalCostUsd.toFixed(4)}`);

  const model = allResults.find((r) => r.ok)?.model || null;
  const path = await import("path");
  const outPath = out || path.default.join(path.default.dirname(tracker), "openai-analyses.json");

  await writeJson(outPath, {
    generated_at: new Date().toISOString(),
    model,
    batch_mode: true,
    chunk_count: chunkStatuses.filter((c) => c.api_status === "completed").length,
    billing: {
      total_cost_usd: Number(totalCostUsd.toFixed(6)),
      actual_usage_summary: summarizeOpenAiCosts(
        allResults.filter((r) => r.ok && r.usage).map((r) => calculateOpenAiUsageCost({ model: r.model || model, usage: r.usage, batchMode: true }))
      )
    },
    results: allResults
  });
  console.log(`Wrote analyses to ${outPath}`);
}

async function importSingleBatch({ batchId, resultsJsonl, out, keyEnv, status, tracker }) {
  let jsonlText;

  if (resultsJsonl) {
    if (!(await fileExists(resultsJsonl))) throw new Error(`Results JSONL not found: ${resultsJsonl}`);
    jsonlText = await readFile(resultsJsonl, "utf8");
  } else {
    const apiKey = process.env[keyEnv];
    if (!apiKey) throw new Error(`Missing ${keyEnv}`);
    const batch = await fetchBatchStatus(apiKey, batchId);
    console.log(`Batch: ${batch.id} — ${batch.status}`);
    if (batch.request_counts) console.log(`Requests: ${batch.request_counts.completed}/${batch.request_counts.total}`);
    if (status) return;
    if (batch.status !== "completed") {
      console.log(batch.status === "failed" ? "Batch failed." : "Still processing.");
      return;
    }
    jsonlText = await downloadOutputFile(apiKey, batch.output_file_id);
  }

  const results = parseBatchResultsJsonl(jsonlText);
  const model = results.find((r) => r.ok)?.model || null;
  const costItems = results.filter((r) => r.ok && r.usage).map((r) => calculateOpenAiUsageCost({ model: r.model || model, usage: r.usage, batchMode: true }));
  const costSummary = summarizeOpenAiCosts(costItems);
  console.log(`${results.filter((r) => r.ok).length} ok, ${results.filter((r) => !r.ok).length} failed — cost: $${costSummary.estimated_cost_usd.total.toFixed(4)}`);

  const path = await import("path");
  const outPath = out || path.default.join(path.default.dirname(tracker), "openai-analyses.json");
  await writeJson(outPath, { generated_at: new Date().toISOString(), model, batch_mode: true, billing: { actual_usage_summary: costSummary }, results });
  console.log(`Wrote analyses to ${outPath}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await importOpenAiBatch(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
