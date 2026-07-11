// Sends segment images to Claude through the LOCAL Claude Code CLI (`claude -p`)
// for parking assessment. Same prompt + schema as the OpenAI/Anthropic-API paths,
// but usage bills against the logged-in Claude subscription (Max) instead of an
// API key. The CLI reads the image files itself via its Read tool, and
// --json-schema forces the reply into ASSESSMENT_SCHEMA (structured_output).
//
// Output shape matches analyze-openai/analyze-anthropic so build-parking-areas
// and ingest-to-db consume it unchanged. cost_usd is 0 (nothing is actually
// billed); the API-equivalent price is logged as nominal_cost_usd per segment.
//
// Progressive + resumable: results are flushed to --out after every segment,
// and segments already ok in an existing output file are skipped on restart.
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import { ASSESSMENT_SCHEMA, SYSTEM_PROMPT, buildUserPrompt } from "./lib/assessment-schema.mjs";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";
import { reportProgress } from "./lib/progress.mjs";

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    images: resolveFrom(import.meta.url, "../out/street-view-images.json"),
    out: resolveFrom(import.meta.url, "../out/claude-cli-analyses.json"),
    model: "sonnet",
    workers: 3,
    limit: null,
    segmentId: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-claude-cli.mjs --candidates path --images path --out path [--segment-id id] [--limit N] [--workers 3] [--model sonnet]");
      console.log("Runs parking assessment through the local Claude Code CLI (subscription-billed, no API key).");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function buildCliPrompt(segment, captureItems) {
  const imageLines = captureItems.map(({ capture, absolutePath }) =>
    `Image ${capture.capture_id} (Station ${(capture.station_index || 0) + 1}, ${capture.direction}): ${absolutePath}`
  );
  return [
    SYSTEM_PROMPT,
    "",
    "First use the Read tool to view EVERY image file listed below, in order:",
    ...imageLines,
    "",
    buildUserPrompt(segment)
  ].join("\n");
}

function runClaudeCli(prompt, model, maxTurns) {
  // Strip Anthropic API keys so the CLI bills the subscription, not a key.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_KEY;
  delete env.CLAUDE_API_KEY;

  const cliArgs = [
    "-p", prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(ASSESSMENT_SCHEMA),
    "--allowedTools", "Read",
    "--permission-mode", "dontAsk",
    "--max-turns", String(maxTurns),
    "--model", model,
    "--no-session-persistence"
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", cliArgs, { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("claude CLI timed out after 600s"));
    }, 600_000);

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      let wrapper;
      try {
        const lines = stdout.trim().split("\n");
        wrapper = JSON.parse(lines[lines.length - 1]);
      } catch {
        return reject(new Error(`claude CLI exited ${code}, unparseable output: ${(stderr || stdout).slice(0, 300)}`));
      }
      if (wrapper.is_error || !wrapper.structured_output) {
        return reject(new Error(`claude CLI ${wrapper.subtype || `exit ${code}`}: ${String(wrapper.result || "no structured_output").slice(0, 300)}`));
      }
      resolve(wrapper);
    });
  });
}

export async function analyzeWithClaudeCli({ candidates, images, out, model, workers, limit, segmentId }) {
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
      log(`Resume: ${before - segmentsWithImages.length} segments already done in ${out}`);
    }
  }

  const queue = limit ? segmentsWithImages.slice(0, limit) : segmentsWithImages;
  log(`claude-cli analysis: ${queue.length} segments to process, model=${model}, workers=${workers}`);

  let processed = 0;
  let totalNominal = results.reduce((s, r) => s + (r.nominal_cost_usd || 0), 0);
  const startedAt = Date.now();

  const flush = async () => {
    await writeJson(out, {
      generated_at: new Date().toISOString(),
      model,
      provider: "anthropic",
      engine: "claude-cli",
      billing: { total_nominal_cost_usd: Number(totalNominal.toFixed(6)), note: "billed to Claude subscription, not API" },
      results
    });
  };

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < queue.length) {
      const item = queue[nextIndex++];
      const segId = item.segment.segment_id;
      const prompt = buildCliPrompt(item.segment, item.availableCaptures);
      const maxTurns = 10 + item.availableCaptures.length * 2;
      const t0 = Date.now();
      try {
        const wrapper = await runClaudeCli(prompt, model, maxTurns);
        const usage = wrapper.usage || {};
        const nominal = wrapper.total_cost_usd || 0;
        totalNominal += nominal;
        const resolvedModel = Object.keys(wrapper.modelUsage || {})[0] || model;
        results.push({
          segment_id: segId,
          ok: true,
          model: resolvedModel,
          usage: {
            input_tokens: usage.input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            output_tokens: usage.output_tokens
          },
          cost_usd: 0,
          nominal_cost_usd: Number(nominal.toFixed(6)),
          assessment: wrapper.structured_output
        });
        processed += 1;
        const eta = Math.round(((Date.now() - startedAt) / processed) * (queue.length - processed) / 1000);
        log(`Segment ${segId}: ok in ${Math.round((Date.now() - t0) / 1000)}s, nominal $${nominal.toFixed(3)} (${processed}/${queue.length}, eta ${eta}s)`);
      } catch (err) {
        results.push({ segment_id: segId, ok: false, error: err.message });
        processed += 1;
        log(`Segment ${segId}: FAIL — ${err.message}`);
      }
      reportProgress("sv-analyze-claude", {
        current: processed, total: queue.length,
        message: `segment ${segId}`,
        area: (out.match(/out\/([^/]+)\//) || [])[1] || null
      });
      await flush();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => worker()));
  await flush();
  reportProgress("sv-analyze-claude", {
    current: processed, total: queue.length, message: "finished", done: true,
    area: (out.match(/out\/([^/]+)\//) || [])[1] || null
  });

  const okCount = results.filter((r) => r.ok).length;
  log(`Done: ${okCount}/${results.length} ok. Total nominal cost $${totalNominal.toFixed(4)} (subscription-covered). Wrote ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await analyzeWithClaudeCli(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
