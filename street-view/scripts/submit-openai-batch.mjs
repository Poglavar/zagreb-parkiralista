// Uploads Batch API JSONL to OpenAI in chunks, creating one batch job per chunk.
// Tracks each chunk separately so partial failures don't waste the whole budget.
import { readFile } from "fs/promises";
import { pathToFileURL } from "url";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    jsonl: resolveFrom(import.meta.url, "../out/openai-batch.jsonl"),
    keyEnv: "OPENAI_API_KEY",
    tracker: resolveFrom(import.meta.url, "../out/openai-batch-status.json"),
    chunkSize: 50,
    maxChunks: 1
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--jsonl") args.jsonl = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--tracker") args.tracker = argv[++i];
    else if (argv[i] === "--chunk-size") args.chunkSize = Number(argv[++i]);
    else if (argv[i] === "--max-chunks") args.maxChunks = Number(argv[++i]);
    else if (argv[i] === "--all") args.maxChunks = Infinity;
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/submit-openai-batch.mjs [--jsonl path] [--chunk-size 50] [--max-chunks 1] [--all] [--tracker path]");
      console.log("");
      console.log("Splits the JSONL into chunks and submits batches.");
      console.log("Default: submits 1 chunk. Use --max-chunks N or --all to submit more.");
      console.log("Re-run to submit more chunks (already-submitted are skipped).");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

async function uploadAndCreateBatch(apiKey, lines, chunkIndex, totalChunks) {
  const content = lines.join("\n") + "\n";
  const label = `chunk ${chunkIndex + 1}/${totalChunks} (${lines.length} requests)`;

  // Upload file
  const formData = new FormData();
  formData.append("purpose", "batch");
  formData.append("file", new Blob([content], { type: "application/jsonl" }), `batch-chunk-${chunkIndex}.jsonl`);

  const uploadResp = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  });

  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`Upload failed for ${label}: ${uploadResp.status}: ${err}`);
  }

  const uploadResult = await uploadResp.json();
  console.log(`  Uploaded ${label}: ${uploadResult.id} (${(uploadResult.bytes / 1024 / 1024).toFixed(1)} MB)`);

  // Create batch
  const batchResp = await fetch("https://api.openai.com/v1/batches", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input_file_id: uploadResult.id,
      endpoint: "/v1/responses",
      completion_window: "24h"
    })
  });

  if (!batchResp.ok) {
    const err = await batchResp.text();
    throw new Error(`Batch creation failed for ${label}: ${batchResp.status}: ${err}`);
  }

  const batchResult = await batchResp.json();
  console.log(`  Batch created: ${batchResult.id} — ${batchResult.status}`);

  return {
    chunk_index: chunkIndex,
    batch_id: batchResult.id,
    input_file_id: uploadResult.id,
    request_count: lines.length,
    status: batchResult.status,
    submitted_at: new Date().toISOString()
  };
}

export async function submitOpenAiBatch({ jsonl, keyEnv, tracker, chunkSize, maxChunks }) {
  if (!(await fileExists(jsonl))) {
    throw new Error(`JSONL file not found: ${jsonl}. Run analyze-openai first.`);
  }

  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${keyEnv} in the environment.`);
  }

  const allLines = (await readFile(jsonl, "utf8")).trim().split("\n");
  const totalRequests = allLines.length;

  // Split into chunks
  const chunks = [];
  for (let i = 0; i < allLines.length; i += chunkSize) {
    chunks.push(allLines.slice(i, i + chunkSize));
  }

  console.log(`Total: ${totalRequests} requests → ${chunks.length} chunks of up to ${chunkSize}`);
  console.log("");

  // Load existing tracker to resume (skip already-submitted chunks)
  let existing = [];
  if (await fileExists(tracker)) {
    try {
      const prev = await readJson(tracker);
      existing = prev.chunks || [];
    } catch { /* ignore */ }
  }
  const submittedChunkIndexes = new Set(existing.map((c) => c.chunk_index));

  const results = [...existing];
  let submitted = 0;
  let skipped = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    if (submittedChunkIndexes.has(i)) {
      skipped += 1;
      continue;
    }

    if (submitted >= maxChunks) {
      console.log(`Reached --max-chunks ${maxChunks}. ${chunks.length - i} chunks remaining. Re-run to continue.`);
      break;
    }

    try {
      const result = await uploadAndCreateBatch(apiKey, chunks[i], i, chunks.length);
      results.push(result);
      submitted += 1;

      // Save tracker after each successful chunk so progress isn't lost
      await writeJson(tracker, {
        jsonl_source: jsonl,
        total_requests: totalRequests,
        chunk_size: chunkSize,
        chunk_count: chunks.length,
        chunks: results
      });
    } catch (err) {
      console.error(`\nChunk ${i + 1} failed: ${err.message}`);
      console.log(`Stopping. ${submitted} chunks submitted, ${chunks.length - i - 1} remaining.`);
      console.log("Fix the issue and re-run — already-submitted chunks will be skipped.");
      // Save progress so far
      await writeJson(tracker, {
        jsonl_source: jsonl,
        total_requests: totalRequests,
        chunk_size: chunkSize,
        chunk_count: chunks.length,
        chunks: results
      });
      break;
    }
  }

  console.log("");
  console.log(`Done: ${submitted} submitted, ${skipped} skipped (already submitted)`);
  console.log(`Tracker: ${tracker}`);
  console.log("");
  console.log("Next: node scripts/import-openai-batch.mjs --tracker " + tracker);
}

async function main() {
  const args = parseArgs(process.argv);
  await submitOpenAiBatch(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
