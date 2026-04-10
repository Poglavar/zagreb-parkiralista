// Downloads completed OpenAI batch results and converts them to the same analyses JSON format as live processing.
import { pathToFileURL } from "url";
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
      console.log("Usage: node scripts/import-openai-batch.mjs [--batch-id id] [--results-jsonl path] [--out path] [--status]");
      console.log("");
      console.log("Reads batch ID from the tracker file (written by submit-openai-batch.mjs),");
      console.log("checks status, downloads results when complete, and writes analyses JSON.");
      console.log("");
      console.log("Options:");
      console.log("  --status          Check batch status and exit (do not download/import).");
      console.log("  --batch-id id     Override batch ID (skip tracker file).");
      console.log("  --results-jsonl   Import from a local JSONL file (skip API download).");
      console.log("  --out path        Output analyses JSON path (default: same dir as tracker).");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function extractOutputText(body) {
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text;
  }

  const collected = [];
  for (const outputItem of body.output || []) {
    for (const contentItem of outputItem.content || []) {
      if (typeof contentItem.text === "string") {
        collected.push(contentItem.text);
      }
    }
  }
  return collected.join("\n").trim();
}

export function parseBatchResultsJsonl(jsonlText) {
  const lines = jsonlText.trim().split("\n").filter(Boolean);
  const results = [];

  for (const line of lines) {
    const entry = JSON.parse(line);
    const customId = entry.custom_id || "";
    const segmentId = customId.replace(/^segment-/, "");

    if (entry.error) {
      results.push({
        segment_id: segmentId,
        ok: false,
        error: entry.error.message || JSON.stringify(entry.error)
      });
      continue;
    }

    const response = entry.response;
    if (!response || response.status_code !== 200) {
      results.push({
        segment_id: segmentId,
        ok: false,
        error: `HTTP ${response?.status_code || "unknown"}: ${JSON.stringify(response?.body || {})}`
      });
      continue;
    }

    const body = response.body;
    const rawText = extractOutputText(body);
    const model = body.model || null;
    const usage = body.usage || null;

    let assessment;
    try {
      assessment = JSON.parse(rawText);
    } catch {
      results.push({
        segment_id: segmentId,
        ok: false,
        error: `Failed to parse assessment JSON: ${rawText.slice(0, 200)}`
      });
      continue;
    }

    results.push({
      segment_id: segmentId,
      ok: true,
      response_id: body.id || null,
      model,
      usage,
      raw_text: rawText,
      assessment
    });
  }

  return results;
}

async function fetchBatchStatus(apiKey, batchId) {
  const response = await fetch(`https://api.openai.com/v1/batches/${batchId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch batch status: HTTP ${response.status}: ${errorText}`);
  }
  return response.json();
}

async function downloadOutputFile(apiKey, fileId) {
  const response = await fetch(`https://api.openai.com/v1/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to download output file: HTTP ${response.status}: ${errorText}`);
  }
  return response.text();
}

function printBatchStatus(batch) {
  console.log(`Batch: ${batch.id}`);
  console.log(`Status: ${batch.status}`);
  if (batch.request_counts) {
    const rc = batch.request_counts;
    console.log(`Requests: ${rc.completed || 0} completed, ${rc.failed || 0} failed, ${rc.total || 0} total`);
  }
  if (batch.created_at) {
    console.log(`Created: ${new Date(batch.created_at * 1000).toISOString()}`);
  }
  if (batch.completed_at) {
    console.log(`Completed: ${new Date(batch.completed_at * 1000).toISOString()}`);
  }
  if (batch.error_file_id) {
    console.log(`Error file: ${batch.error_file_id}`);
  }
}

export async function importOpenAiBatch({ tracker, batchId, resultsJsonl, out, keyEnv, status }) {
  let jsonlText;
  let model = null;

  if (resultsJsonl) {
    // Import from local file
    if (!(await fileExists(resultsJsonl))) {
      throw new Error(`Results JSONL not found: ${resultsJsonl}`);
    }
    const { readFile } = await import("fs/promises");
    jsonlText = await readFile(resultsJsonl, "utf8");
    console.log(`Reading results from local file: ${resultsJsonl}`);
  } else {
    // Resolve batch ID from tracker or argument
    if (!batchId) {
      if (!(await fileExists(tracker))) {
        throw new Error(`Tracker file not found: ${tracker}. Run submit-openai-batch.mjs first, or pass --batch-id.`);
      }
      const trackerData = await readJson(tracker);
      batchId = trackerData.batch_id;
      if (!batchId) {
        throw new Error("Tracker file does not contain a batch_id.");
      }
    }

    const apiKey = process.env[keyEnv];
    if (!apiKey) {
      throw new Error(`Missing ${keyEnv} in the environment.`);
    }

    // Check status
    const batch = await fetchBatchStatus(apiKey, batchId);
    printBatchStatus(batch);

    if (status) {
      return;
    }

    if (batch.status !== "completed") {
      if (batch.status === "failed" || batch.status === "expired" || batch.status === "cancelled") {
        throw new Error(`Batch ${batchId} ${batch.status}. Cannot import results.`);
      }
      console.log("");
      console.log("Batch is still processing. Run again later, or use --status to check progress.");
      return;
    }

    if (!batch.output_file_id) {
      throw new Error(`Batch ${batchId} completed but has no output_file_id.`);
    }

    console.log(`Downloading results from file ${batch.output_file_id}...`);
    jsonlText = await downloadOutputFile(apiKey, batch.output_file_id);
  }

  const results = parseBatchResultsJsonl(jsonlText);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  console.log(`Parsed ${results.length} results: ${okCount} ok, ${failCount} failed`);

  // Detect model from first successful result
  const firstOk = results.find((r) => r.ok);
  if (firstOk) {
    model = firstOk.model;
  }

  // Compute cost summary (batch mode = 50% discount)
  const costItems = results
    .filter((r) => r.ok && r.usage)
    .map((r) => calculateOpenAiUsageCost({ model: r.model || model, usage: r.usage, batchMode: true }));
  const costSummary = summarizeOpenAiCosts(costItems);

  if (costSummary.estimated_cost_usd.total > 0) {
    console.log(`Batch cost estimate (50% discount applied): $${costSummary.estimated_cost_usd.total.toFixed(4)}`);
  }

  // Resolve output path: --out flag, or same directory as tracker
  const path = await import("path");
  const outPath = out || path.default.join(path.default.dirname(tracker), "openai-analyses.json");

  await writeJson(outPath, {
    generated_at: new Date().toISOString(),
    model,
    batch_id: batchId || null,
    batch_mode: true,
    billing: {
      actual_usage_summary: costSummary
    },
    results
  });

  console.log(`Wrote analyses to ${outPath}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await importOpenAiBatch(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
