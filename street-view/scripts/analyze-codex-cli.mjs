// Sends segment images to OpenAI through the LOCAL Codex CLI (`codex exec`)
// for parking assessment. Same prompt + schema as the other engines, but usage
// bills against the logged-in ChatGPT subscription instead of an API key.
// Images are attached natively via repeated `-i` flags, and --output-schema
// forces the final message into (a strict-mode variant of) ASSESSMENT_SCHEMA.
//
// Output shape matches analyze-openai/analyze-anthropic/analyze-claude-cli so
// build-parking-areas and ingest-to-db consume it unchanged. cost_usd is 0
// (nothing is actually billed); token usage is recorded per segment.
//
// Progressive + resumable: results are flushed to --out after every segment,
// and segments already ok in an existing output file are skipped on restart.
import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
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
    out: resolveFrom(import.meta.url, "../out/codex-cli-analyses.json"),
    model: null,           // null = the codex config default (ChatGPT-account model set)
    effort: "medium",      // config default "max" is overkill for classification
    workers: 3,
    limit: null,
    segmentId: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--effort") args.effort = argv[++i];
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-codex-cli.mjs --candidates path --images path --out path [--segment-id id] [--limit N] [--workers 3] [--model name] [--effort medium]");
      console.log("Runs parking assessment through the local Codex CLI (ChatGPT-subscription billed, no API key).");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

// OpenAI structured-output strict mode demands every property listed in
// `required` — ASSESSMENT_SCHEMA keeps some optional (e.g. road_geometry.notes),
// so codex gets a strictified copy.
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

function buildCodexPrompt(segment, captureItems) {
  const imageLines = captureItems.map(({ capture }, idx) =>
    `Image ${idx + 1}: capture ${capture.capture_id} (Station ${(capture.station_index || 0) + 1}, ${capture.direction})`
  );
  return [
    SYSTEM_PROMPT,
    "",
    "The attached images, in order:",
    ...imageLines,
    "",
    buildUserPrompt(segment),
    "",
    "IMPORTANT: station_index in your output is ZERO-BASED — the images' \"Station 1\" is station_index 0."
  ].join("\n");
}

function runCodexCli(prompt, imagePaths, schemaPath, outPath, model, effort) {
  // Strip OpenAI API keys so codex bills the ChatGPT subscription, not a key.
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_KEY;

  const cliArgs = ["exec"];
  for (const img of imagePaths) cliArgs.push("-i", img);
  cliArgs.push(
    "--output-schema", schemaPath,
    "-o", outPath,
    "--ephemeral",
    "--skip-git-repo-check",
    "-s", "read-only",
    "-c", `model_reasoning_effort="${effort}"`,
    "--color", "never"
  );
  if (model) cliArgs.push("-m", model);
  cliArgs.push(prompt);

  return new Promise((resolve, reject) => {
    // stdin MUST be ignored: codex exec treats a piped-open stdin as "prompt
    // will arrive on stdin" and waits for EOF forever.
    const proc = spawn("codex", cliArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("codex CLI timed out after 600s"));
    }, 600_000);

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`codex exited ${code}: ${(stderr || stdout).slice(-400)}`));
      }
      let assessment;
      try {
        assessment = JSON.parse(await readFile(outPath, "utf8"));
      } catch (err) {
        return reject(new Error(`codex final message unparseable: ${err.message}: ${stdout.slice(-300)}`));
      }
      // "tokens used\n23,723" and the "model:" header appear in the
      // human-readable event stream — which codex writes to STDERR when
      // stdout is not a TTY, so scan both streams.
      const combined = stdout + "\n" + stderr;
      const tokensMatch = combined.match(/tokens used\s*\n\s*([\d,]+)/i);
      const modelMatch = combined.match(/^model:\s*(\S+)/m);
      resolve({
        assessment,
        totalTokens: tokensMatch ? Number(tokensMatch[1].replace(/,/g, "")) : null,
        resolvedModel: modelMatch ? modelMatch[1] : null
      });
    });
  });
}

export async function analyzeWithCodexCli({ candidates, images, out, model, effort, workers, limit, segmentId }) {
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
  log(`codex-cli analysis: ${queue.length} segments to process, model=${model || "(config default)"}, effort=${effort}, workers=${workers}`);

  // One shared temp dir for the schema + per-segment output files.
  const workDir = await mkdtemp(path.join(tmpdir(), "codex-sv-"));
  const schemaPath = path.join(workDir, "assessment-schema.json");
  await writeFile(schemaPath, JSON.stringify(strictify(ASSESSMENT_SCHEMA), null, 2));

  let processed = 0;
  let totalTokens = results.reduce((s, r) => s + (r.usage?.total_tokens || 0), 0);
  const startedAt = Date.now();

  const flush = async () => {
    await writeJson(out, {
      generated_at: new Date().toISOString(),
      model: model || "codex-config-default",
      provider: "openai",
      engine: "codex-cli",
      billing: { total_tokens: totalTokens, note: "billed to ChatGPT subscription, not API" },
      results
    });
  };

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < queue.length) {
      const item = queue[nextIndex++];
      const segId = item.segment.segment_id;
      const prompt = buildCodexPrompt(item.segment, item.availableCaptures);
      const outPath = path.join(workDir, `seg-${segId}.json`);
      const t0 = Date.now();
      try {
        const { assessment, totalTokens: segTokens, resolvedModel } = await runCodexCli(
          prompt,
          item.availableCaptures.map((c) => c.absolutePath),
          schemaPath, outPath, model, effort
        );
        totalTokens += segTokens || 0;
        results.push({
          segment_id: segId,
          ok: true,
          model: resolvedModel || model || "codex-config-default",
          usage: { total_tokens: segTokens },
          cost_usd: 0,
          assessment
        });
        processed += 1;
        const eta = Math.round(((Date.now() - startedAt) / processed) * (queue.length - processed) / 1000);
        log(`Segment ${segId}: ok in ${Math.round((Date.now() - t0) / 1000)}s, ${segTokens ?? "?"} tokens (${processed}/${queue.length}, eta ${eta}s)`);
      } catch (err) {
        results.push({ segment_id: segId, ok: false, error: err.message });
        processed += 1;
        log(`Segment ${segId}: FAIL — ${err.message}`);
      }
      reportProgress("sv-analyze-codex", {
        current: processed, total: queue.length,
        message: `segment ${segId}`,
        area: (out.match(/out\/([^/]+)\//) || [])[1] || null
      });
      await flush();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => worker()));
  await flush();
  await rm(workDir, { recursive: true, force: true });
  reportProgress("sv-analyze-codex", {
    current: processed, total: queue.length, message: "finished", done: true,
    area: (out.match(/out\/([^/]+)\//) || [])[1] || null
  });

  const okCount = results.filter((r) => r.ok).length;
  log(`Done: ${okCount}/${results.length} ok. Total ${totalTokens.toLocaleString()} tokens (subscription-covered). Wrote ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await analyzeWithCodexCli(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
