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

const ROAD_WIDTH_SOURCE = resolveFrom(import.meta.url, "../../../zagreb-road-widths/data/road-width-zagreb.json");
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
    chunkSize: 50,
    maxChunks: 1,
    model: "gpt-5.4",
    dryRun: true,
    step: null,
    help: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--area") args.area = argv[++i];
    else if (argv[i] === "--chunk-size") args.chunkSize = Number(argv[++i]);
    else if (argv[i] === "--max-chunks") args.maxChunks = Number(argv[++i]);
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--step") args.step = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/process-area.mjs --area "Trnje" [options]

Chains all pipeline steps for a city area:
  1. selection   Generate segment selection from zagreb-road-widths data
  2. candidates  Prepare Street View capture candidates
  3. metadata    Fetch Street View metadata (requires GOOGLE_MAPS_API_KEY)
  4. images      Fetch Street View images (requires GOOGLE_MAPS_API_KEY)
  5. batch-jsonl Generate OpenAI Batch API JSONL
  6. submit      Submit batch to OpenAI (requires OPENAI_API_KEY)
  7. import      Check/import batch results
  8. ingest      Ingest results to database (requires DATABASE_URL)

Options:
  --area NAME        Area name to process (matches l1/l2/l3 from zagreb-road-widths)
  --chunk-size N     Batch chunk size (default: 50)
  --max-chunks N     Max chunks to submit (default: 1)
  --model MODEL      OpenAI model (default: gpt-5.4)
  --write            Actually write to DB (default: dry run for ingest step)
  --step NAME        Run only a specific step (e.g. --step metadata)
  --help             Show this message

Requires GOOGLE_MAPS_API_KEY and OPENAI_API_KEY in the environment.
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

// Build output paths scoped to the area
function areaPaths(areaSlug) {
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
    analyses: path.join(base, "openai-analyses.json")
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
  const paths = areaPaths(areaSlug);

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

  // Step 5: Generate batch JSONL
  if (shouldRun("batch-jsonl")) {
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
  if (shouldRun("submit")) {
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
  if (shouldRun("import")) {
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
        "--provider", "openai",
        "--model", args.model
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
