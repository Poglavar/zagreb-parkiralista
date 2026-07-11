// Pipeline orchestrator: chains all street-view pipeline steps for a given area.
// Each step checks if its output already exists and skips if so (resume support).
import path from "path";
import { pathToFileURL } from "url";
import { resolveFrom, fileExists, readJson } from "./lib/io.mjs";
import { importRoadWidthSelection, buildSelectedFeatures } from "./import-road-width-selection.mjs";
import { prepareCandidates } from "./prepare-candidates.mjs";
import { fetchStreetViewMetadata } from "./fetch-street-view-metadata.mjs";
import { fetchStreetViewImages } from "./fetch-street-view-images.mjs";
import { analyzeWithOpenAi } from "./analyze-openai.mjs";
import { submitOpenAiBatch } from "./submit-openai-batch.mjs";
import { importOpenAiBatch } from "./import-openai-batch.mjs";
import { analyzeWithClaudeCli } from "./analyze-claude-cli.mjs";
import { analyzeWithCodexCli } from "./analyze-codex-cli.mjs";

// Repo was renamed from zagreb-road-widths to zagreb-ulice; data now lives under sirine/.
const ROAD_WIDTH_SOURCE = resolveFrom(import.meta.url, "../../../zagreb-ulice/sirine/data/road-width-zagreb.json");
const CADASTRE_ENV = resolveFrom(import.meta.url, "../../../cadastre-data/api/.env");

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    area: null,
    engine: "claude-cli",  // claude-cli (subscription-billed, default) | openai-batch
    chunkSize: 50,
    maxChunks: 1,
    model: null,           // default depends on engine: sonnet / gpt-5.4
    workers: 3,
    limit: null,
    dryRun: true,
    step: null,
    help: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--area") args.area = argv[++i];
    else if (argv[i] === "--engine") args.engine = argv[++i];
    else if (argv[i] === "--chunk-size") args.chunkSize = Number(argv[++i]);
    else if (argv[i] === "--max-chunks") args.maxChunks = Number(argv[++i]);
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--step") args.step = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }

  if (!["claude-cli", "codex-cli", "openai-batch"].includes(args.engine)) {
    throw new Error(`Unknown engine: ${args.engine} (use claude-cli, codex-cli or openai-batch)`);
  }
  // codex-cli deliberately gets no default model — it uses the codex config
  // default (ChatGPT accounts only allow that model set).
  if (!args.model && args.engine === "claude-cli") args.model = "sonnet";
  if (!args.model && args.engine === "openai-batch") args.model = "gpt-5.4";

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/process-area.mjs --area "Trnje" [options]

Chains all pipeline steps for a city area:
  1. selection   Generate segment selection from road-width data
  2. candidates  Prepare Street View capture candidates
  3. metadata    Fetch Street View metadata (requires GOOGLE_MAPS_API_KEY)
  4. images      Fetch Street View images (requires GOOGLE_MAPS_API_KEY)
  5. analysis — depends on --engine:
     claude-cli (default): analyze     Local Claude Code CLI, Claude-subscription billed
     codex-cli:            analyze     Local Codex CLI, ChatGPT-subscription billed
     openai-batch:         batch-jsonl / submit / import  (requires OPENAI_API_KEY)
  6. ingest      Ingest results to database (requires DATABASE_URL)

Options:
  --area NAME        Area name to process (matches l1/l2/l3 from road-width data)
  --engine NAME      claude-cli (default), codex-cli, or openai-batch
  --model MODEL      Model override (default: sonnet / codex config default / gpt-5.4)
  --workers N        Parallel CLI calls for claude-cli engine (default: 3)
  --limit N          Analyze at most N segments (claude-cli engine; for cost testing)
  --chunk-size N     Batch chunk size (default: 50, openai-batch only)
  --max-chunks N     Max chunks to submit (default: 1, openai-batch only)
  --write            Actually write to DB (default: dry run for ingest step)
  --step NAME        Run only a specific step (e.g. --step metadata, --step analyze)
  --help             Show this message

Requires GOOGLE_MAPS_API_KEY (steps 3-4); OPENAI_API_KEY only for --engine openai-batch.
DATABASE_URL is loaded from cadastre-data/api/.env for the ingest step.
`);
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Build output paths scoped to the area. The analyses filename carries the
// engine so a claude-cli run never collides with an earlier openai batch run.
function areaPaths(areaSlug, engine) {
  const base = resolveFrom(import.meta.url, `../out/${areaSlug}`);
  return {
    base,
    selection: path.join(base, "selected-segments.geojson"),
    candidates: path.join(base, "candidates.json"),
    metadata: path.join(base, "street-view-metadata.json"),
    images: path.join(base, "street-view-images.json"),
    imageDir: path.join(base, "images"),
    batchJsonl: path.join(base, "openai-batch.jsonl"),
    tracker: path.join(base, "openai-batch-status.json"),
    analyses: path.join(base,
      engine === "claude-cli" ? "claude-cli-analyses.json"
      : engine === "codex-cli" ? "codex-cli-analyses.json"
      : "openai-analyses.json")
  };
}

// Find segments matching area name across l1, l2, l3 fields
function selectSegmentsForArea(sourceData, areaName) {
  const needle = areaName.toLowerCase();
  const matches = [];

  for (const seg of sourceData.segmentLines || []) {
    const labels = [...(seg.l1 || []), ...(seg.l2 || []), ...(seg.l3 || [])];
    const hit = labels.some((l) => l.toLowerCase() === needle);
    if (hit) {
      matches.push({
        segmentId: String(seg.id),
        label: `${areaName} ${seg.id}`,
        notes: `Auto-selected for area ${areaName}`
      });
    }
  }

  return matches;
}

async function loadDatabaseUrlAsync() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const { readFile } = await import("fs/promises");
    const envContent = await readFile(CADASTRE_ENV, "utf8");
    const match = envContent.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // ignore
  }
  return null;
}

async function runStep(name, description, outputPath, fn) {
  log(`--- Step: ${description} ---`);
  if (outputPath && await fileExists(outputPath)) {
    log(`  SKIP: output already exists at ${path.basename(outputPath)}`);
    return true;
  }
  try {
    await fn();
    log(`  DONE: ${description}`);
    return true;
  } catch (err) {
    log(`  FAIL: ${description} — ${err.message}`);
    console.error(err);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.area) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const areaName = args.area;
  const areaSlug = slugify(areaName);
  const paths = areaPaths(areaSlug, args.engine);

  log(`Processing area: ${areaName} (slug: ${areaSlug})`);
  log(`Output directory: ${paths.base}`);

  const shouldRun = (step) => !args.step || args.step === step;

  // Step 1: Generate segment selection
  if (shouldRun("selection")) {
    const ok = await runStep("selection", "Generate segment selection", paths.selection, async () => {
      const sourceData = await readJson(ROAD_WIDTH_SOURCE);
      const selectionItems = selectSegmentsForArea(sourceData, areaName);
      if (selectionItems.length === 0) {
        throw new Error(`No segments found matching area "${areaName}". Check l1/l2/l3 labels in road-width data.`);
      }
      log(`  Found ${selectionItems.length} segments for "${areaName}"`);
      const features = buildSelectedFeatures(sourceData, selectionItems);
      const { writeJson } = await import("./lib/io.mjs");
      await writeJson(paths.selection, {
        type: "FeatureCollection",
        metadata: {
          source: ROAD_WIDTH_SOURCE,
          area: areaName,
          generated_at: new Date().toISOString(),
          feature_count: features.length
        },
        features
      });
    });
    if (!ok) return;
  }

  // Step 2: Prepare candidates
  if (shouldRun("candidates")) {
    const ok = await runStep("candidates", "Prepare candidates", paths.candidates, async () => {
      await prepareCandidates({ input: paths.selection, out: paths.candidates, size: "640x640", fov: 90, pitch: 0, radius: 30 });
    });
    if (!ok) return;
  }

  // Step 3: Fetch Street View metadata
  if (shouldRun("metadata")) {
    const ok = await runStep("metadata", "Fetch Street View metadata", paths.metadata, async () => {
      if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY not set in environment");
      await fetchStreetViewMetadata({ input: paths.candidates, out: paths.metadata, keyEnv: "GOOGLE_MAPS_API_KEY", delayMs: 1000, segmentId: null, captureId: null });
    });
    if (!ok) return;
  }

  // Step 4: Fetch Street View images
  if (shouldRun("images")) {
    const ok = await runStep("images", "Fetch Street View images", paths.images, async () => {
      if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY not set in environment");
      await fetchStreetViewImages({ candidates: paths.candidates, metadata: paths.metadata, out: paths.images, imageDir: paths.imageDir, keyEnv: "GOOGLE_MAPS_API_KEY", delayMs: 1000, segmentId: null, captureId: null });
    });
    if (!ok) return;
  }

  // Step 5 (claude-cli / codex-cli engines): analyze through a local CLI.
  // Subscription-billed, resumable (both engines flush after every segment and
  // skip already-ok ones on restart), replaces batch-jsonl/submit/import.
  if (args.engine !== "openai-batch" && (shouldRun("analyze") || shouldRun("batch-jsonl") || shouldRun("submit") || shouldRun("import"))) {
    if (args.step && args.step !== "analyze") {
      log(`NOTE: step "${args.step}" belongs to the openai-batch engine; running "analyze" instead (engine=${args.engine}).`);
    }
    const label = args.engine === "claude-cli" ? "Analyze via Claude Code CLI" : "Analyze via Codex CLI";
    const ok = await runStep("analyze", label, null, async () => {
      const analyzeOpts = {
        candidates: paths.candidates,
        images: paths.images,
        out: paths.analyses,
        model: args.model,
        workers: args.workers,
        limit: args.limit,
        segmentId: null
      };
      if (args.engine === "claude-cli") await analyzeWithClaudeCli(analyzeOpts);
      else await analyzeWithCodexCli({ ...analyzeOpts, effort: "medium" });
    });
    if (!ok) return;
  }

  // Step 5: Generate batch JSONL
  if (args.engine === "openai-batch" && shouldRun("batch-jsonl")) {
    const ok = await runStep("batch-jsonl", "Generate batch JSONL", paths.batchJsonl, async () => {
      await analyzeWithOpenAi({
        candidates: paths.candidates,
        images: paths.images,
        out: null,
        keyEnv: "OPENAI_API_KEY",
        model: args.model,
        delayMs: 1000,
        imageDetail: "auto",
        batchJsonl: paths.batchJsonl,
        live: false,
        segmentId: null
      });
    });
    if (!ok) return;
  }

  // Step 6: Submit batch
  if (args.engine === "openai-batch" && shouldRun("submit")) {
    const ok = await runStep("submit", "Submit OpenAI batch", null, async () => {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set in environment");
      // Don't skip if tracker exists — it tracks partial progress
      await submitOpenAiBatch({
        jsonl: paths.batchJsonl,
        keyEnv: "OPENAI_API_KEY",
        tracker: paths.tracker,
        chunkSize: args.chunkSize,
        maxChunks: args.maxChunks
      });
    });
    if (!ok) return;
  }

  // Step 7: Import batch results
  if (args.engine === "openai-batch" && shouldRun("import")) {
    const ok = await runStep("import", "Import batch results", paths.analyses, async () => {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set in environment");
      await importOpenAiBatch({
        tracker: paths.tracker,
        batchId: null,
        resultsJsonl: null,
        out: paths.analyses,
        keyEnv: "OPENAI_API_KEY",
        status: false
      });
    });
    if (!ok) return;
  }

  // Step 8: Ingest to database
  if (shouldRun("ingest")) {
    await runStep("ingest", "Ingest to database", null, async () => {
      const databaseUrl = await loadDatabaseUrlAsync();
      if (!databaseUrl) throw new Error("DATABASE_URL not found in environment or cadastre-data/api/.env");

      // Fork to ingest-to-db.mjs via child_process to keep its parseArgs() intact
      const { execFileSync } = await import("child_process");
      const ingestScript = resolveFrom(import.meta.url, "./ingest-to-db.mjs");
      const ingestArgs = [
        ingestScript,
        "--candidates", paths.candidates,
        "--analyses", paths.analyses,
        "--images", paths.images,
        "--database-url", databaseUrl,
        "--provider", args.engine === "claude-cli" ? "anthropic" : "openai",
        "--model", args.model || "codex-config-default"
      ];
      if (!args.dryRun) ingestArgs.push("--write");
      execFileSync("node", ingestArgs, { stdio: "inherit" });
    });
  }

  log(`=== Pipeline complete for area: ${areaName} ===`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[${ts()}] FATAL: ${err.message}`);
    process.exit(1);
  });
}
