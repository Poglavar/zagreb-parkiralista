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
import { analyzeWithOpenRouter } from "./analyze-openrouter.mjs";
import { recordImagery } from "./record-imagery.mjs";

// Segments come from the shared roads API (road_width_segment in geodata), which is the
// single source of truth and carries osm_id + street_name. We used to read
// zagreb-ulice's road-width-zagreb.json directly over a cross-repo relative path — that
// was an intermediate artifact of this very table, and it had no osm_id, so the pipeline
// keyed everything to a volatile row number. ROAD_WIDTH_FALLBACK is only for working
// offline; the API is authoritative.
const ROADS_API = process.env.ROADS_API_BASE
  || (process.env.NODE_ENV === "production" ? "https://api.zagreb.lol/api/roads" : "http://localhost:3001/api/roads");
const ROAD_WIDTH_FALLBACK = resolveFrom(import.meta.url, "../../../zagreb-ulice/sirine/data/road-width-zagreb.json");
const CADASTRE_ENV = resolveFrom(import.meta.url, "../../../cadastre-data/api/.env");

// Prefer the shared roads API; fall back to the local JSON only if it is unreachable, and
// say so loudly, because the fallback carries no osm_id.
async function loadRoadWidthSource() {
  const url = `${ROADS_API}/width-segments`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const n = data.segmentLines?.length || 0;
    if (!n) throw new Error("no segmentLines in response");
    const withOsm = data.segmentLines.filter((s) => s.osm != null).length;
    console.log(`[${ts()}] Road segments from ${url}: ${n} (${withOsm} with osm_id)`);
    return { sourceData: data, sourceLabel: url };
  } catch (err) {
    console.warn(`[${ts()}] WARNING: roads API unreachable (${err.message}) — falling back to ${ROAD_WIDTH_FALLBACK}, which has no osm_id.`);
    const { readJson: rj } = await import("./lib/io.mjs");
    return { sourceData: await rj(ROAD_WIDTH_FALLBACK), sourceLabel: ROAD_WIDTH_FALLBACK };
  }
}

// The engines that can answer "is there parking here", and what each costs you.
// The two CLI engines drive a locally logged-in Claude Code / Codex and bill the
// subscription, so cost_usd is 0; openai-batch and openrouter bill a metered API key and
// their per-segment cost is recorded.
const ENGINES = {
  "claude-cli":   { provider: "anthropic", defaultModel: "sonnet",             billing: "Claude subscription" },
  "codex-cli":    { provider: "openai",    defaultModel: null,                 billing: "ChatGPT subscription" },
  "openrouter":   { provider: "openrouter", defaultModel: "moonshotai/kimi-k3", billing: "metered — OPENROUTER_API_KEY" },
  "openai-batch": { provider: "openai",    defaultModel: "gpt-5.4",            billing: "metered — OPENAI_API_KEY (50% batch discount)" }
};
const PROVIDER_BY_ENGINE = Object.fromEntries(
  Object.entries(ENGINES).map(([k, v]) => [k, v.provider]));

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    area: null,
    benchmark: false,      // select exactly the segments carrying a human verdict
    osmBenchmark: false,   // select segments where OSM carries a per-side parking claim
    engine: "claude-cli",  // claude-cli (subscription-billed, default) | openai-batch
    chunkSize: 50,
    maxChunks: 1,
    model: null,           // default depends on engine: sonnet / gpt-5.4
    effort: null,          // reasoning effort for the CLI engines; null = engine default
    workers: 3,
    limit: null,
    variant: "sv",         // prompt variant (lib/prompt-variants.mjs) — sv | sv-osm | sv-ortho | sv-osm-ortho
    maxCostUsd: null,      // metered engines only; stops the run cleanly at the ceiling
    dryRun: true,
    step: null,
    through: null,         // run every step from the start up to and including this one
    runId: null,           // default derived from area + model, see deriveRunId()
    notes: null,
    help: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--area") args.area = argv[++i];
    else if (argv[i] === "--benchmark") { args.benchmark = true; args.area = args.area || "benchmark"; }
    else if (argv[i] === "--osm-benchmark") { args.osmBenchmark = true; args.area = args.area || "osm-benchmark"; }
    else if (argv[i] === "--run-id") args.runId = argv[++i];
    else if (argv[i] === "--notes") args.notes = argv[++i];
    else if (argv[i] === "--engine") args.engine = argv[++i];
    else if (argv[i] === "--chunk-size") args.chunkSize = Number(argv[++i]);
    else if (argv[i] === "--max-chunks") args.maxChunks = Number(argv[++i]);
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--effort") args.effort = argv[++i];
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--variant") args.variant = argv[++i];
    else if (argv[i] === "--max-cost-usd") args.maxCostUsd = Number(argv[++i]);
    else if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--step") args.step = argv[++i];
    else if (argv[i] === "--through") args.through = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }

  if (!ENGINES[args.engine]) {
    throw new Error(`Unknown engine: ${args.engine} (use ${Object.keys(ENGINES).join(", ")})`);
  }
  // codex-cli deliberately gets a null default model — it uses the codex config
  // default (ChatGPT accounts only allow that model set).
  if (!args.model) args.model = ENGINES[args.engine].defaultModel;

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
     openrouter:           analyze     OpenRouter API — METERED, real money per segment
     openai-batch:         batch-jsonl / submit / import  (requires OPENAI_API_KEY)
  6. ingest      Observations + coverage + imagery to the database (requires DATABASE_URL)

Options:
  --area NAME        Area name to process (mjesni odbor, gradska cetvrt, or l1/l2/l3 label)
  --osm-benchmark    Process a fixed sample of segments whose OSM way carries a definite
                     per-side parking:left/right/both claim AND whose imagery is already
                     downloaded (0 billable Street View requests). Ground truth for
                     scripts/score-run.mjs --against osm. Stratified: up to 60 segments
                     with an OSM "parking yes" side (orientation-tagged ones first, so
                     the manner/sizing comparison has data) + up to 60 with only "no"
                     sides. Deterministic order, so every engine sees the same set.
  --benchmark        Process exactly the segments that carry a human verdict — the set
                     score-run.mjs can actually score. Use this to compare models.
  --variant NAME     What the model is shown (claude-cli only for now):
                       sv            Street View images only (default, baseline)
                       sv-osm        + the street's OSM tags as text
                       sv-ortho      + an annotated orthophoto crop of the segment
                       sv-osm-ortho  + both
                     The variant is part of the run id and the analyses filename, so
                     variants of the same model never overwrite each other.
  --engine NAME      claude-cli (default), codex-cli, openrouter, openai-batch
  --model MODEL      Model override (default per engine, see below)
  --run-id ID        Name this run (default: <area>-<model>). Runs never overwrite each
                     other, so use this to keep two runs of the same model side by side.
  --notes TEXT       Free-text note stored on the run
  --effort LEVEL     Reasoning effort for the CLI engines: low|medium|high|xhigh|max
                     (gpt-5.3-codex-spark rejects "max" — it takes up to xhigh)
  --workers N        Parallel calls for the per-segment engines (default: 3)
  --limit N          Analyze at most N segments (for cost testing)
  --max-cost-usd N   Spend ceiling for --engine openrouter; stops cleanly, stays resumable
  --chunk-size N     Batch chunk size (default: 50, openai-batch only)
  --max-chunks N     Max chunks to submit (default: 1, openai-batch only)
  --write            Actually write to DB (default: dry run for ingest step)
  --step NAME        Run ONLY this step (e.g. --step analyze). Fails if its inputs are
                     missing, so it is for resuming, not for starting.
  --through NAME     Run every step up to and including NAME, skipping ones already done.
                     --through images = fetch imagery and stop before any LLM call.
  --help             Show this message

Engines and what they cost you:
${Object.entries(ENGINES).map(([name, e]) =>
  `  ${name.padEnd(14)} default model: ${String(e.defaultModel || "(codex config)").padEnd(22)} ${e.billing}`).join("\n")}

The analyses file is named per (engine, model), so running two models over the same area
produces two files and two runs rather than the second silently resuming the first.

Requires GOOGLE_MAPS_API_KEY (steps 3-4). OPENAI_API_KEY for openai-batch,
OPENROUTER_API_KEY for openrouter; the CLI engines need neither.
DATABASE_URL is loaded from cadastre-data/api/.env for the ingest step.

Examples:
  # Opus over a mjesni odbor, subscription-billed, write to DB
  node scripts/process-area.mjs --area "Zrinjevac" --model opus --write

  # Which model is best? Run each over the benchmark set, then score them.
  node scripts/process-area.mjs --benchmark --model opus --write
  node scripts/process-area.mjs --benchmark --engine codex-cli --model gpt-5.3-codex-spark --write
  node scripts/process-area.mjs --benchmark --engine openrouter --model moonshotai/kimi-k3 \\
      --max-cost-usd 2 --write
  node scripts/score-run.mjs

  # What is left to do, nearest first
  node scripts/list-areas.mjs
`);
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Build output paths scoped to the area. The analyses filename carries the engine AND the
// model. The model part matters: both CLI engines resume by skipping segments already
// present in the output file, so when the filename was engine-only, running Opus over an
// area and then Sonnet over the same area made the second run skip every segment as
// "already done" and silently hand back a copy of the first model's answers. Comparing
// models was impossible without noticing. One file per (engine, model) fixes it.
function areaPaths(areaSlug, engine, model, variant = "sv") {
  const base = resolveFrom(import.meta.url, `../out/${areaSlug}`);
  const engineTag = engine === "openai-batch" ? "openai" : engine;
  const modelTag = slugify(model || "default");
  // The variant is part of the identity: two variants of the same model must not share an
  // analyses file, or the second resume-skips the first and silently copies its answers.
  const variantTag = variant && variant !== "sv" ? `-${slugify(variant)}` : "";
  return {
    base,
    selection: path.join(base, "selected-segments.geojson"),
    candidates: path.join(base, "candidates.json"),
    metadata: path.join(base, "street-view-metadata.json"),
    images: path.join(base, "street-view-images.json"),
    imageDir: path.join(base, "images"),
    batchJsonl: path.join(base, `openai-batch-${modelTag}.jsonl`),
    tracker: path.join(base, `openai-batch-status-${modelTag}.json`),
    analyses: path.join(base, `${engineTag}-analyses-${modelTag}${variantTag}.json`)
  };
}

// A run is "this model, over this area". Deriving it rather than demanding it keeps the
// common case a one-liner; re-running the same model over the same area re-ingests into
// the same run (ON CONFLICT updates it), which is what you want when resuming. Pass
// --run-id explicitly to keep two runs of the same model side by side (e.g. a prompt A/B).
function deriveRunId(areaSlug, engine, model, variant = "sv") {
  const variantTag = variant && variant !== "sv" ? `-${slugify(variant)}` : "";
  return `${areaSlug}-${slugify(model || engine)}${variantTag}`;
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

// The benchmark set: exactly the segments a human has ruled on.
//
// This is the right target for comparing models. A whole mjesni odbor is mostly streets
// with no ground truth, so running four models over one costs four times the work to
// learn nothing extra — the score can only ever be computed on the handful of segments
// that carry a verdict. Selecting those directly gives the same statistical power for a
// fraction of the calls, and every segment in it has imagery already.
async function selectBenchmarkSegments(databaseUrl) {
  if (!databaseUrl) throw new Error("--benchmark needs a database: DATABASE_URL or cadastre-data/api/.env");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    // Verdicts on 'manual-<uuid>' spaces are polygons a human drew by hand in the review
    // UI. They have no road segment behind them, so there is no geometry to place capture
    // stations along and no way for a model to be asked about them — they cannot be part
    // of a model benchmark. Excluded here rather than left to fail later as a confusing
    // "missing segment ids" error.
    const { rows } = await pool.query(`
      SELECT regexp_replace(v.segment_id, '-s[0-9]+$', '') AS sid,
             COUNT(*)::int AS verdicts,
             BOOL_OR(v.segment_id LIKE 'manual-%') AS is_manual
      FROM parking.verdict v
      WHERE v.review_status <> 'suspect'
      GROUP BY 1 ORDER BY 1
    `);
    const usable = rows.filter((r) => !r.is_manual && /^\d+$/.test(r.sid));
    const skipped = rows.length - usable.length;
    if (usable.length === 0) {
      throw new Error("No human verdicts on real road segments yet, so there is nothing to benchmark against. Review some streets first.");
    }
    const verdictCount = usable.reduce((a, r) => a + r.verdicts, 0);
    log(`  Benchmark set: ${usable.length} segments carrying ${verdictCount} human verdicts`);
    if (skipped > 0) {
      log(`  NOTE: ${skipped} hand-drawn (manual-*) verdict space(s) excluded — they have no road geometry to re-analyse.`);
    }
    return usable.map((r) => ({
      segmentId: String(r.sid),
      label: `BENCHMARK ${r.sid}`,
      notes: "Segment with a human verdict — model comparison benchmark"
    }));
  } finally {
    await pool.end();
  }
}

// The OSM benchmark set: segments whose OSM way carries a definite per-side parking
// claim (parking:left/right/both = lane|street_side|on_kerb|half_on_kerb|shoulder|no;
// 'separate' is excluded — it means the parking is mapped as its own polygon, so the
// kerb itself proves nothing) and whose imagery is already on disk, so the whole run
// costs zero billable Street View requests.
//
// Stratified and deterministic: up to 60 segments with at least one "yes" side —
// orientation-tagged ones first, because orientation is what scores the manner/sizing
// call — plus up to 60 with only "no" sides, both in md5(segment_id) order. Every
// engine run over this selection therefore sees exactly the same segments, which is
// the point of a benchmark.
async function selectOsmBenchmarkSegments(databaseUrl) {
  if (!databaseUrl) throw new Error("--osm-benchmark needs a database: DATABASE_URL or cadastre-data/api/.env");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(`
      WITH way AS (
        SELECT DISTINCT ON (osm_id) osm_id, tags
        FROM public.osm_road WHERE current ORDER BY osm_id, version DESC
      ),
      claim AS (
        SELECT r.id AS sid,
               bool_or(d.v IN ('lane','street_side','on_kerb','half_on_kerb','shoulder')) AS has_yes,
               bool_or(d.v = 'no') AS has_no,
               bool_or(d.o IS NOT NULL) AS has_orientation
        FROM public.road_width_segment r
        JOIN way w ON w.osm_id = r.osm_id
        CROSS JOIN LATERAL (VALUES
          (coalesce(w.tags->>'parking:left',  w.tags->>'parking:both'),
           coalesce(w.tags->>'parking:left:orientation',  w.tags->>'parking:both:orientation')),
          (coalesce(w.tags->>'parking:right', w.tags->>'parking:both'),
           coalesce(w.tags->>'parking:right:orientation', w.tags->>'parking:both:orientation'))
        ) AS d(v, o)
        WHERE d.v IS NOT NULL AND d.v <> 'separate'
        GROUP BY r.id
      ),
      imaged AS (
        SELECT c.* FROM claim c
        JOIN parking.segment_imagery si ON si.segment_id = c.sid::text AND si.image_count > 0
      )
      (SELECT sid, 'osm yes side' AS stratum FROM imaged WHERE has_yes
         ORDER BY has_orientation DESC, md5(sid::text) LIMIT 60)
      UNION ALL
      (SELECT sid, 'osm no side only' FROM imaged WHERE NOT has_yes AND has_no
         ORDER BY md5(sid::text) LIMIT 60)
    `);
    if (rows.length === 0) {
      throw new Error("No OSM-claimed segments with downloaded imagery found — fetch imagery for an area with parking:* tags first.");
    }
    const yes = rows.filter((r) => r.stratum === "osm yes side").length;
    log(`  OSM benchmark set: ${rows.length} segments (${yes} with an OSM parking side, ${rows.length - yes} with only "no" sides), imagery already on disk`);
    return rows.map((r) => ({
      segmentId: String(r.sid),
      label: `OSM-BENCHMARK ${r.sid}`,
      notes: `OSM per-side parking claim (${r.stratum}) — model-vs-OSM benchmark`
    }));
  } finally {
    await pool.end();
  }
}

// Resolve an area name against parking.road_segment_mo — the materialised spatial join
// onto ppv.boundary_jms. Preferred over the l1/l2/l3 label match because those arrays
// mix the gradska cetvrt and the mjesni odbor with no marker for which is which, and
// spell some names two ways. This resolves either level cleanly, so "Zrinjevac" (an MO,
// 23 segments) and "Donji Grad" (a cetvrt, 429) both work.
async function selectSegmentsFromMo(databaseUrl, areaName) {
  if (!databaseUrl) return null;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(`
      SELECT road_segment_id, mo_naziv, gc_naziv, ring_index
      FROM parking.road_segment_mo
      WHERE lower(mo_naziv) = lower($1) OR lower(gc_naziv) = lower($1)
      ORDER BY road_segment_id
    `, [areaName]);
    if (rows.length === 0) return null;
    // Five names (Brezovica, Donja/Gornja Dubrava, Maksimir, Trnje) are BOTH a mjesni
    // odbor and a gradska četvrt. The OR above then returns the whole četvrt, which is
    // how a "65-segment" area once processed 739 segments and 1,704 billable images in
    // one gulp. Ambiguity resolves to the SMALLER unit: exact MO rows win when present.
    // (To process such a četvrt in full, run its MOs individually — the spiral does.)
    const moRows = rows.filter((r) => r.mo_naziv.toLowerCase() === areaName.toLowerCase());
    const useRows = moRows.length > 0 ? moRows : rows;
    const level = moRows.length > 0 ? "mjesni odbor" : "gradska četvrt";
    log(`  Resolved "${areaName}" as ${level} via parking.road_segment_mo (ring ${useRows[0].ring_index}, ${useRows.length} segments)`);
    return useRows.map((r) => ({
      segmentId: String(r.road_segment_id),
      label: `${areaName} ${r.road_segment_id}`,
      notes: `Auto-selected for ${level} ${areaName} (${r.gc_naziv})`
    }));
  } catch (err) {
    // Not fatal: the l1/l2/l3 path still works, it is just coarser.
    log(`  NOTE: mjesni-odbor lookup unavailable (${err.message}); falling back to l1/l2/l3 labels.`);
    return null;
  } finally {
    await pool.end();
  }
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
  const paths = areaPaths(areaSlug, args.engine, args.model, args.variant);
  const runId = args.runId || deriveRunId(areaSlug, args.engine, args.model, args.variant);

  log(`Processing area: ${areaName} (slug: ${areaSlug})`);
  log(`Engine: ${args.engine}, model: ${args.model || "(engine default)"}, run_id: ${runId}`);
  log(`Output directory: ${paths.base}`);
  log(`Analyses file: ${path.basename(paths.analyses)}`);

  // --step runs exactly one step; --through runs everything up to and including one.
  //
  // --through exists because a single step is rarely what someone means. "Fetch the images
  // for this area" needs selection, candidates and metadata first, and asking for --step
  // images on a fresh area just fails on a missing candidates.json. Steps already done are
  // skipped by their own output check, so --through is idempotent and cheap to repeat.
  const STEP_ORDER = ["selection", "candidates", "metadata", "images", "batch-jsonl", "submit", "import", "analyze", "ingest"];
  if (args.through && !STEP_ORDER.includes(args.through)) {
    throw new Error(`--through must be one of: ${STEP_ORDER.join(", ")}`);
  }
  if (args.step && args.through) {
    throw new Error("--step and --through are mutually exclusive");
  }
  const throughIndex = args.through ? STEP_ORDER.indexOf(args.through) : -1;
  const shouldRun = (step) => {
    if (args.step) return args.step === step;
    if (throughIndex >= 0) {
      const i = STEP_ORDER.indexOf(step);
      return i >= 0 && i <= throughIndex;
    }
    return true;
  };

  // Step 1: Generate segment selection
  if (shouldRun("selection")) {
    const ok = await runStep("selection", "Generate segment selection", paths.selection, async () => {
      const { sourceData, sourceLabel } = await loadRoadWidthSource();
      // Benchmark set first, then mjesni odbor / gradska cetvrt (clean hierarchy, deduped
      // names), then the older l1/l2/l3 label match so existing area names keep working.
      const selectionItems = args.benchmark
        ? await selectBenchmarkSegments(await loadDatabaseUrlAsync())
        : args.osmBenchmark
        ? await selectOsmBenchmarkSegments(await loadDatabaseUrlAsync())
        : (await selectSegmentsFromMo(await loadDatabaseUrlAsync(), areaName)
           || selectSegmentsForArea(sourceData, areaName));
      if (selectionItems.length === 0) {
        throw new Error(`No segments found matching area "${areaName}". It matched no mjesni odbor, no gradska četvrt, and no l1/l2/l3 label. Run "node scripts/list-areas.mjs" to see the valid names.`);
      }
      log(`  Found ${selectionItems.length} segments for "${areaName}"`);
      const features = buildSelectedFeatures(sourceData, selectionItems);
      const { writeJson } = await import("./lib/io.mjs");
      await writeJson(paths.selection, {
        type: "FeatureCollection",
        metadata: {
          source: sourceLabel,
          area: areaName,
          generated_at: new Date().toISOString(),
          feature_count: features.length
        },
        features
      });
    });
    if (!ok) return false;
  }

  // Step 2: Prepare candidates
  if (shouldRun("candidates")) {
    const ok = await runStep("candidates", "Prepare candidates", paths.candidates, async () => {
      await prepareCandidates({ input: paths.selection, out: paths.candidates, size: "640x640", fov: 90, pitch: 0, radius: 30 });
    });
    if (!ok) return false;
  }

  // Step 3: Fetch Street View metadata
  if (shouldRun("metadata")) {
    const ok = await runStep("metadata", "Fetch Street View metadata", paths.metadata, async () => {
      if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY not set in environment");
      await fetchStreetViewMetadata({ input: paths.candidates, out: paths.metadata, keyEnv: "GOOGLE_MAPS_API_KEY", delayMs: 1000, segmentId: null, captureId: null });
    });
    if (!ok) return false;
  }

  // Step 4: Fetch Street View images
  if (shouldRun("images")) {
    const ok = await runStep("images", "Fetch Street View images", paths.images, async () => {
      if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY not set in environment");
      await fetchStreetViewImages({ candidates: paths.candidates, metadata: paths.metadata, out: paths.images, imageDir: paths.imageDir, keyEnv: "GOOGLE_MAPS_API_KEY", delayMs: 1000, segmentId: null, captureId: null });
    });
    if (!ok) return false;

    // Record what the area now has, so the status map reflects the fetch. Deliberately
    // OUTSIDE runStep: it must run even when the fetch itself was skipped as already
    // done, because that is exactly the case where the JPEGs exist and the database has
    // never heard of them. Re-running an area is how you repair it.
    //
    // Not gated on --write either: this is an inventory of the street, not the output of
    // a model, so there is no dry-run worth having. A fetch that stays invisible on the
    // map is the bug this whole step exists to close.
    const ok2 = await runStep("images", "Record imagery in the database", null, async () => {
      await recordImagery({
        candidates: paths.candidates,
        metadata: paths.metadata,
        images: paths.images,
        source: "google_street_view",
        databaseUrl: await loadDatabaseUrlAsync(),
        dryRun: false,
        log
      });
    });
    if (!ok2) return false;
  }

  // Step 5 (claude-cli / codex-cli engines): analyze through a local CLI.
  // Subscription-billed, resumable (both engines flush after every segment and
  // skip already-ok ones on restart), replaces batch-jsonl/submit/import.
  if (args.engine !== "openai-batch" && (shouldRun("analyze") || shouldRun("batch-jsonl") || shouldRun("submit") || shouldRun("import"))) {
    if (args.step && args.step !== "analyze") {
      log(`NOTE: step "${args.step}" belongs to the openai-batch engine; running "analyze" instead (engine=${args.engine}).`);
    }
    const label = {
      "claude-cli": "Analyze via Claude Code CLI",
      "codex-cli": "Analyze via Codex CLI",
      "openrouter": "Analyze via OpenRouter"
    }[args.engine];
    const ok = await runStep("analyze", label, null, async () => {
      const analyzeOpts = {
        candidates: paths.candidates,
        images: paths.images,
        out: paths.analyses,
        model: args.model,
        effort: args.effort,
        workers: args.workers,
        limit: args.limit,
        segmentId: null
      };
      if (args.engine === "claude-cli") {
        await analyzeWithClaudeCli({
          ...analyzeOpts,
          variant: args.variant,
          databaseUrl: await loadDatabaseUrlAsync()
        });
      }
      else if (args.engine === "openrouter") {
        await analyzeWithOpenRouter({ ...analyzeOpts, keyEnv: "OPENROUTER_API_KEY", maxCostUsd: args.maxCostUsd });
      } else {
        // codex config defaults to reasoning effort "max", which gpt-5.3-codex-spark
        // rejects outright (it takes low|medium|high|xhigh). medium is also the right
        // level for a perception task, so pass it explicitly rather than inheriting.
        await analyzeWithCodexCli({ ...analyzeOpts, effort: args.effort || "medium" });
      }
    });
    if (!ok) return false;
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
    if (!ok) return false;
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
    if (!ok) return false;
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
    if (!ok) return false;
  }

  // Step 8: Ingest to database
  if (shouldRun("ingest")) {
    const ok = await runStep("ingest", "Ingest to database", null, async () => {
      const databaseUrl = await loadDatabaseUrlAsync();
      if (!databaseUrl) throw new Error("DATABASE_URL not found in environment or cadastre-data/api/.env");

      // Fork to ingest-to-db.mjs via child_process to keep its parseArgs() intact
      const { execFileSync } = await import("child_process");
      const ingestScript = resolveFrom(import.meta.url, "./ingest-to-db.mjs");
      // --run-id and --area were missing here, which made `--write` throw every time:
      // ingest-to-db refuses to write without a run id, deliberately, because an
      // unlabelled run cannot be compared against or reviewed. Everything ingested
      // before this fix had to be done by hand.
      const ingestArgs = [
        ingestScript,
        "--candidates", paths.candidates,
        "--analyses", paths.analyses,
        "--images", paths.images,
        "--metadata", paths.metadata,
        "--database-url", databaseUrl,
        "--run-id", runId,
        "--area", areaName,
        "--provider", PROVIDER_BY_ENGINE[args.engine],
        "--model", args.model || "codex-config-default"
      ];
      if (args.notes) ingestArgs.push("--notes", args.notes);
      if (!args.dryRun) ingestArgs.push("--write");
      execFileSync("node", ingestArgs, { stdio: "inherit" });
    });
    if (!ok) return false;
  }

  log(`=== Pipeline complete for area: ${areaName} ===`);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((ok) => {
      // A failing step used to log "FAIL: …" and then return, which exits 0 — so every
      // caller saw success. The job manager duly showed a green "gotovo" for a run that
      // had fetched nothing. A failed step is a failed process.
      if (!ok) {
        console.error(`[${ts()}] Pipeline did not complete — see the FAIL line above.`);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`[${ts()}] FATAL: ${err.message}`);
      process.exit(1);
    });
}
