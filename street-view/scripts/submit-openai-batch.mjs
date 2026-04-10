// Uploads a Batch API JSONL file to OpenAI and creates an asynchronous batch job.
import { readFile } from "fs/promises";
import { pathToFileURL } from "url";
import { fileExists, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    jsonl: resolveFrom(import.meta.url, "../out/openai-batch.jsonl"),
    keyEnv: "OPENAI_API_KEY",
    tracker: resolveFrom(import.meta.url, "../out/openai-batch-status.json")
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--jsonl") args.jsonl = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--tracker") args.tracker = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/submit-openai-batch.mjs [--jsonl path] [--tracker path]");
      console.log("");
      console.log("Uploads the JSONL file to OpenAI and creates a batch job.");
      console.log("Writes batch metadata to the tracker file for import-openai-batch.mjs.");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

export async function submitOpenAiBatch({ jsonl, keyEnv, tracker }) {
  if (!(await fileExists(jsonl))) {
    throw new Error(`JSONL file not found: ${jsonl}. Run analyze-openai first.`);
  }

  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${keyEnv} in the environment.`);
  }

  // Count requests in the JSONL
  const jsonlContent = await readFile(jsonl, "utf8");
  const lineCount = jsonlContent.trim().split("\n").length;
  console.log(`Uploading ${lineCount} batch requests from ${jsonl}`);

  // Step 1: upload the file
  const formData = new FormData();
  formData.append("purpose", "batch");
  formData.append("file", new Blob([jsonlContent], { type: "application/jsonl" }), "batch.jsonl");

  const uploadResponse = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`File upload failed: HTTP ${uploadResponse.status}: ${errorText}`);
  }

  const uploadResult = await uploadResponse.json();
  const fileId = uploadResult.id;
  console.log(`Uploaded file: ${fileId} (${uploadResult.bytes} bytes)`);

  // Step 2: create the batch
  const batchResponse = await fetch("https://api.openai.com/v1/batches", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input_file_id: fileId,
      endpoint: "/v1/responses",
      completion_window: "24h"
    })
  });

  if (!batchResponse.ok) {
    const errorText = await batchResponse.text();
    throw new Error(`Batch creation failed: HTTP ${batchResponse.status}: ${errorText}`);
  }

  const batchResult = await batchResponse.json();
  console.log(`Batch created: ${batchResult.id}`);
  console.log(`Status: ${batchResult.status}`);
  console.log(`Completion window: ${batchResult.completion_window}`);

  // Save tracker for import step
  const trackerData = {
    submitted_at: new Date().toISOString(),
    batch_id: batchResult.id,
    input_file_id: fileId,
    request_count: lineCount,
    jsonl_source: jsonl,
    status: batchResult.status
  };

  await writeJson(tracker, trackerData);
  console.log(`Tracker saved to ${tracker}`);
  console.log("");
  console.log("Next steps:");
  console.log("  - Wait for the batch to complete (usually minutes to hours, max 24h).");
  console.log("  - Run: node scripts/import-openai-batch.mjs");
  console.log(`  - Or check status: node scripts/import-openai-batch.mjs --status`);

  return trackerData;
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
