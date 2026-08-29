// Spiral batch driver: processes mjesni odbori ring by ring outward from Trg bana
// Jelačića, running the full street-view pipeline (selection → … → analyze → ingest)
// for each area that still has unanalysed segments. One model, one engine, many areas —
// the "work through the queue" tool that list-areas.mjs only prints.
//
// Restart-safe by construction: every underlying step skips work whose output already
// exists, the analyzer resumes per segment, and the ingest upserts under a per-area
// run_id. Killing this and starting it again costs nothing but the segment in flight.
//
// The one real budget here is Google Street View image fetches (10,000 free/month,
// shared with other repos on the same key). Every area reports its newly-fetched count
// in its images manifest; this driver sums those and STOPS before the cap — a spiral
// that quietly billed its way through the free tier would be exactly the silent-cost
// failure the AI-processing rules exist to prevent.
//
// A file named STOP-SPIRAL in street-view/out/ makes it finish the current area and
// exit cleanly — the polite alternative to killing the job.
import { spawn } from "child_process";
import { readFile, access } from "fs/promises";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { resolveFrom } from "./lib/io.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolveFrom(import.meta.url, "../out");
const STOP_FILE = path.join(OUT_DIR, "STOP-SPIRAL");

function log(msg) {
  console.log(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`);
}

// Same rule as process-area.mjs, so out/<slug>/ paths line up.
function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
  const args = {
    engine: "codex-cli",
    model: "gpt-5.6-sol",
    effort: null,
    maxAreas: Infinity,
    maxMinutes: Infinity,
    maxNewImages: 2000,
    write: false,
    help: argv.length <= 2
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--engine") args.engine = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--effort") args.effort = argv[++i];
    else if (argv[i] === "--max-areas") args.maxAreas = Number(argv[++i]);
    else if (argv[i] === "--max-minutes") args.maxMinutes = Number(argv[++i]);
    else if (argv[i] === "--max-new-images") args.maxNewImages = Number(argv[++i]);
    else if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/run-spiral.mjs --write [--engine codex-cli] [--model gpt-5.6-sol]
                                 [--max-areas N] [--max-new-images 2000]

Processes mjesni odbori in concentric-ring order (city centre outwards), running the
full pipeline for every area that still has unanalysed segments. Without --write it
prints the plan and exits. Needs DATABASE_URL in the environment (source .env first).

  --max-new-images N   Stop before cumulative newly-fetched (billable) Street View
                       images exceed N (default 2000). Areas whose imagery is already
                       on disk cost 0 against this.
  --max-areas N        Stop after N areas (default: work the whole queue).
  --max-minutes N      Stop after the first area that finishes past N minutes of
                       runtime (a time budget, checked between areas — the last
                       area may overshoot by its own duration).

Stop gracefully: touch out/STOP-SPIRAL — finishes the current area, then exits.
Progress: run-job log, plus each area's own step logs under out/<slug>/.`);
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

// The queue, from the same code that prints it for humans.
async function loadQueue(databaseUrl) {
  const { listAreas } = await import("./list-areas.mjs");
  const rows = await listAreas({ databaseUrl, level: "mo", limit: 0, all: true, json: true });
  return rows
    .map((r) => ({
      area: r.area, ring: Number(r.ring),
      segments: Number(r.segments), analysed: Number(r.analysed), withImages: Number(r.with_images)
    }))
    .filter((r) => r.analysed < r.segments)
    .sort((a, b) => a.ring - b.ring);
}

function runProcessArea(area, { engine, model, effort, write }) {
  const cliArgs = [path.join(SCRIPTS_DIR, "process-area.mjs"), "--area", area, "--engine", engine];
  if (model) cliArgs.push("--model", model);
  if (effort) cliArgs.push("--effort", effort);
  if (write) cliArgs.push("--write");
  return new Promise((resolve) => {
    // Inherit stdio: the per-step logs ARE the detailed progress trail, and this runs
    // under run-job where stdout is the ledger someone tails.
    const proc = spawn("node", cliArgs, { stdio: "inherit", cwd: path.dirname(SCRIPTS_DIR) });
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });
}

async function newlyFetchedFor(slug) {
  const manifest = path.join(OUT_DIR, slug, "street-view-images.json");
  try {
    const data = JSON.parse(await readFile(manifest, "utf8"));
    return data?.billing?.newly_fetched ?? 0;
  } catch {
    return 0;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set. Source the repo .env first (on valhalla it points at prod through the do-pg-tunnel).");
  }

  const queue = await loadQueue(process.env.DATABASE_URL);
  const todoSegments = queue.reduce((s, a) => s + (a.segments - a.analysed), 0);
  log(`Spiral queue: ${queue.length} areas with unanalysed segments (${todoSegments} segments to go), engine=${args.engine}, model=${args.model}`);
  log(`Budget: stop before ${args.maxNewImages} newly-fetched Street View images; max ${args.maxAreas === Infinity ? "all" : args.maxAreas} areas.`);

  if (!args.write) {
    for (const a of queue.slice(0, 25)) {
      log(`  would process ring ${String(a.ring).padStart(3)}  ${a.area} — ${a.segments - a.analysed}/${a.segments} unanalysed, ${a.withImages}/${a.segments} imaged`);
    }
    if (queue.length > 25) log(`  … and ${queue.length - 25} more areas`);
    log("Dry run — pass --write to actually process.");
    return;
  }

  let areasDone = 0;
  let newImages = 0;
  let consecutiveFailures = 0;
  const startedAt = Date.now();

  for (const a of queue) {
    if (areasDone >= args.maxAreas) { log(`Area cap reached (${args.maxAreas}) — stopping.`); break; }
    if ((Date.now() - startedAt) / 60000 >= args.maxMinutes) { log(`Time budget reached (${Math.round((Date.now() - startedAt) / 60000)}/${args.maxMinutes} min) — stopping.`); break; }
    if (await fileExists(STOP_FILE)) { log(`STOP-SPIRAL found — stopping before ${a.area}. Delete it to resume.`); break; }

    log(`=== ring ${a.ring} · ${a.area} — ${a.segments - a.analysed}/${a.segments} unanalysed (${areasDone + 1}${Number.isFinite(args.maxAreas) ? `/${args.maxAreas}` : ""}, ${newImages}/${args.maxNewImages} images spent) ===`);
    const code = await runProcessArea(a.area, args);
    const fetched = await newlyFetchedFor(slugify(a.area));
    newImages += fetched;

    if (code !== 0) {
      consecutiveFailures += 1;
      log(`AREA FAILED (exit ${code}): ${a.area} — continuing (${consecutiveFailures} consecutive).`);
      // Three areas failing in a row is a systemic problem (auth, DB, quota), not three
      // coincidences — stop loudly instead of grinding the rest of the queue into errors.
      if (consecutiveFailures >= 3) { log("3 consecutive area failures — aborting the spiral."); process.exitCode = 1; break; }
    } else {
      consecutiveFailures = 0;
      areasDone += 1;
      const mins = Math.round((Date.now() - startedAt) / 60000);
      log(`=== done ${a.area}: +${fetched} billable images (cum ${newImages}) · ${areasDone} areas in ${mins} min ===`);
    }

    if (newImages >= args.maxNewImages) {
      log(`Street View image budget reached (${newImages}/${args.maxNewImages}) — stopping. Raise --max-new-images to continue.`);
      break;
    }
  }

  log(`Spiral finished: ${areasDone} areas processed, ${newImages} newly-fetched images.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
