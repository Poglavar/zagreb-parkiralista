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
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { ASSESSMENT_SCHEMA } from "./lib/assessment-schema.mjs";
import { getVariant, systemPromptFor, userPromptFor } from "./lib/prompt-variants.mjs";
import { loadOsmTags } from "./lib/osm-tags.mjs";
import { renderSegmentOrtho, segmentBbox3765, ORTHO_SOURCES, ORTHO_RENDER_SIZE } from "./lib/ortho.mjs";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";
import { reportProgress } from "./lib/progress.mjs";

// The shared ledger lives in a sibling checkout, so a repo without it still runs
// unaccounted rather than failing to start. Same pattern as analyze-openrouter.mjs.
let recordSubscriptionRun = null;
try {
  ({ recordSubscriptionRun } = await import("../../../agents/lib/llm-cost/index.mjs"));
} catch {
  console.warn("[llm-cost] shared ledger unavailable; consumption recorded locally only");
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    images: resolveFrom(import.meta.url, "../out/street-view-images.json"),
    out: resolveFrom(import.meta.url, "../out/claude-cli-analyses.json"),
    model: "sonnet",
    effort: null,
    workers: 3,
    limit: null,
    segmentId: null,
    variant: "sv",          // prompt variant; see lib/prompt-variants.mjs
    databaseUrl: process.env.DATABASE_URL,
    orthoSource: "cdof2022"
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--variant") args.variant = argv[++i];
    else if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--ortho-source") args.orthoSource = argv[++i];
    else if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--effort") args.effort = argv[++i];
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-claude-cli.mjs --candidates path --images path --out path [--segment-id id] [--limit N] [--workers 3] [--model sonnet] [--effort high]");
      console.log("Runs parking assessment through the local Claude Code CLI (subscription-billed, no API key).");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function buildCliPrompt(segment, captureItems, variant, extras = {}) {
  const imageLines = captureItems.map(({ capture, absolutePath }) =>
    `Image ${capture.capture_id} (Station ${(capture.station_index || 0) + 1}, ${capture.direction}): ${absolutePath}`
  );
  // The orthophoto is listed last and labelled, so the model reads the street-level
  // evidence first and the aerial as supporting geometry — the order the prompt asks it
  // to weigh them in.
  if (extras.orthoPath) {
    imageLines.push(`Orthophoto (top-down aerial) of this segment: ${extras.orthoPath}`);
  }
  return [
    systemPromptFor(variant),
    "",
    "First use the Read tool to view EVERY image file listed below, in order:",
    ...imageLines,
    "",
    userPromptFor(variant, segment, extras)
  ].join("\n");
}

function runClaudeCli(prompt, model, maxTurns, effort) {
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
  // Reasoning effort (low|medium|high|xhigh|max). Omitted = CLI default for the model.
  if (effort) cliArgs.push("--effort", effort);

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

export async function analyzeWithClaudeCli({
  candidates, images, out, model, effort, workers, limit, segmentId,
  variant: variantName = "sv", databaseUrl, orthoSource = "cdof2022"
}) {
  const variant = getVariant(variantName);
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
  log(`claude-cli analysis: ${queue.length} segments to process, model=${model}, effort=${effort || "default"}, workers=${workers}`);
  log(`Prompt variant: ${variant.name} — ${variant.label} (prompt_version ${variant.promptVersion})`);

  // Extra inputs, loaded up front so a per-segment failure to fetch them is visible as a
  // count rather than as a silently weaker prompt on some segments.
  let osmBySegment = new Map();
  if (variant.needsOsm) {
    if (!databaseUrl) throw new Error(`variant "${variant.name}" needs OSM tags — pass --database-url or set DATABASE_URL`);
    osmBySegment = await loadOsmTags(databaseUrl, queue.map((q) => q.segment.segment_id));
    log(`OSM tags loaded for ${osmBySegment.size}/${queue.length} segments`);
  }

  const orthoDir = path.join(path.dirname(out), "ortho");
  if (variant.needsOrtho) await mkdir(orthoDir, { recursive: true });
  let orthoOk = 0;
  let orthoFail = 0;

  // One annotated aerial crop per segment, cached on disk so re-running a variant (or
  // running two variants that both want it) does not re-hit the WMS.
  async function orthoFor(segment) {
    if (!variant.needsOrtho) return null;
    const file = path.join(orthoDir, `${segment.segment_id}.jpg`);
    if (await fileExists(file)) {
      orthoOk += 1;
      // Recompute the geometry metadata rather than storing zeros: the prompt quotes the
      // scale to the model, and "0.00 m per pixel" would be a confident falsehood about
      // the one thing the aerial is there to supply. segmentBbox3765 is pure, so this is
      // free and exactly matches what the cached image was rendered from.
      const bbox = segmentBbox3765(segment.geometry?.coordinates || []);
      return {
        path: file,
        label: ORTHO_SOURCES[orthoSource]?.label || "orthophoto",
        extentM: bbox.extentM,
        metresPerPixel: bbox.extentM / ORTHO_RENDER_SIZE,
        cached: true
      };
    }
    try {
      const rendered = await renderSegmentOrtho(segment, { source: orthoSource });
      await writeFile(file, rendered.buffer);
      orthoOk += 1;
      return { path: file, label: rendered.label, metresPerPixel: rendered.metresPerPixel, extentM: rendered.extentM };
    } catch (err) {
      // Not fatal: the prompt says so explicitly and the model falls back to street level.
      // Counted, though, because a variant that quietly lost its extra input on half the
      // segments is not the variant being measured.
      orthoFail += 1;
      log(`  ortho FAIL for segment ${segment.segment_id}: ${err.message}`);
      return null;
    }
  }

  let processed = 0;
  let totalNominal = results.reduce((s, r) => s + (r.nominal_cost_usd || 0), 0);
  const startedAt = Date.now();

  const flush = async () => {
    await writeJson(out, {
      generated_at: new Date().toISOString(),
      model,
      effort,
      provider: "anthropic",
      engine: "claude-cli",
      // Recorded so a run's numbers can always be traced to what the model was shown.
      // Comparing variants is the whole point, and a result file that does not say which
      // one produced it is not comparable to anything.
      variant: variant.name,
      prompt_version: variant.promptVersion,
      extra_inputs: {
        osm_tags_for_segments: variant.needsOsm ? osmBySegment.size : 0,
        ortho_ok: orthoOk,
        ortho_failed: orthoFail
      },
      billing: { total_nominal_cost_usd: Number(totalNominal.toFixed(6)), note: "billed to Claude subscription, not API" },
      results
    });
  };

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < queue.length) {
      const item = queue[nextIndex++];
      const segId = item.segment.segment_id;
      const ortho = await orthoFor(item.segment);
      const prompt = buildCliPrompt(item.segment, item.availableCaptures, variant, {
        osmTags: osmBySegment.get(String(segId).replace(/-s\d+$/, "")),
        ortho,
        orthoPath: ortho?.path
      });
      // Opus 5 spends more turns deliberating (re-reading images) than earlier models;
      // 10 + 2/capture produced error_max_turns on ~20% of segments. The budget is a
      // stall guard, not a cost control — a segment that fails on it wastes every token
      // it burned — so it is sized generously.
      const maxTurns = 20 + item.availableCaptures.length * 4;
      const t0 = Date.now();
      try {
        const wrapper = await runClaudeCli(prompt, model, maxTurns, effort);
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
        // Subscription consumption to the shared cross-repo ledger: tokens recorded, no
        // money, the CLI's nominal figure kept as the metered equivalent. A ledger
        // failure is loud but never takes the run down.
        if (recordSubscriptionRun) {
          try {
            recordSubscriptionRun({
              repo: "zagreb-parkiralista", script: "analyze-claude-cli",
              model: resolvedModel, usage, equivalentUsd: nominal || null,
              meta: { segment_id: segId, variant: variant.name, images: item.availableCaptures.length }
            });
          } catch (e) {
            log(`  [llm-cost] not recorded: ${e.message}`);
          }
        }
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
