// Localhost-only processing-status server for zagreb-parkiralista.
// Serves the dashboard (status.html) and /status.json, which aggregates:
//   - live heartbeats from data/status/*.json (written by instrumented scripts)
//   - a `ps` scan as fallback so un-instrumented / older runs still show up
//   - derived pipeline state from the filesystem (tiles, composites, images…)
//   - review-workflow counts from Postgres (parking.aerial_candidate, parking.area)
// Run: npm run status  →  http://localhost:8017/
// Deliberately binds 127.0.0.1 and is never touched by deploy-to-server.sh.
import { execFile } from "child_process";
import { readdir, readFile, stat } from "fs/promises";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import pg from "pg";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env.STATUS_PORT || 8017);

// Heartbeats older than this are shown as "stalo" (stalled) instead of running.
const HEARTBEAT_FRESH_MS = 90_000;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = await readFile(path.resolve(ROOT, "../cadastre-data/api/.env"), "utf8");
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* no db, degrade */ }
  return null;
}

let pool = null;
async function getPool() {
  if (pool) return pool;
  const url = await loadDatabaseUrl();
  if (!url) return null;
  pool = new pg.Pool({ connectionString: url, max: 2 });
  return pool;
}

async function countFiles(dir, suffix) {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

async function readJsonSafe(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// ── Live heartbeats ────────────────────────────────────────────────────────
async function collectHeartbeats() {
  const dir = path.join(ROOT, "data", "status");
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    const hb = await readJsonSafe(path.join(dir, entry));
    if (!hb) continue;
    const ageMs = Date.now() - Date.parse(hb.updated_at || 0);
    out.push({ ...hb, age_seconds: Math.round(ageMs / 1000), fresh: ageMs < HEARTBEAT_FRESH_MS });
  }
  return out.sort((a, b) => a.age_seconds - b.age_seconds);
}

// ── ps fallback: catch runs that predate heartbeat instrumentation ────────
const PS_PATTERNS = [
  // process-area orchestrates the others as imports (not child processes), so
  // it needs its own pattern; heartbeats from inside it carry the detail.
  { pattern: "process-area.mjs", process: "sv-pipeline" },
  { pattern: "fetch-street-view-images.mjs", process: "sv-images" },
  { pattern: "fetch-street-view-metadata.mjs", process: "sv-metadata" },
  { pattern: "analyze-claude-cli.mjs", process: "sv-analyze-claude" },
  { pattern: "analyze-codex-cli.mjs", process: "sv-analyze-codex" },
  { pattern: "01_fetch_tiles.py", process: "fetch-tiles" },
  { pattern: "02_segment.py", process: "sam3-segment" },
  { pattern: "11_detect_vehicles.py", process: "detect-vehicles" },
  { pattern: "31_llm_propose.py", process: "aerial-llm" },
  { pattern: "32_render_area.py", process: "render-composites" },
];

async function scanProcesses() {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
    const found = [];
    const seen = new Set();
    for (const line of stdout.split("\n")) {
      // Shell wrappers (bash -c "… node script.mjs …") match the same pattern
      // as the node process itself — keep one entry per process name.
      for (const { pattern, process: name } of PS_PATTERNS) {
        if (line.includes(pattern) && !line.includes("grep") && !seen.has(name)) {
          seen.add(name);
          found.push({ process: name, pid: Number(line.trim().split(/\s+/)[0]), command: line.trim().slice(0, 160) });
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

// ── Derived pipeline state ─────────────────────────────────────────────────
async function aerialState() {
  const tiles = await countFiles(path.join(ROOT, "data/tiles/cdof2022"), ".tif");
  const tileJpgs = await countFiles(path.join(ROOT, "data/tiles_jpg/cdof2022"), ".jpg");
  const composites = await countFiles(path.join(ROOT, "data/composites/cdof2022"), ".png");
  const masks = await countFiles(path.join(ROOT, "data/masks/cdof2022"), ".tif");

  const candidatesFile = await readJsonSafe(path.join(ROOT, "data/candidates/llm_parking_candidates.geojson"));
  const rawLog = candidatesFile?.metadata?.raw_log || [];
  const processedComposites = new Set(rawLog.map((e) => e.composite)).size;
  const proposals = candidatesFile?.features?.length || 0;

  const vehicles = await readJsonSafe(path.join(ROOT, "data/candidates/vehicles.geojson"));

  return {
    tiles,
    tile_jpgs: tileJpgs,
    composites,
    sam_masks: masks,
    vehicles: vehicles?.features?.length || 0,
    llm: { composites_processed: processedComposites, composites_total: composites, proposals },
  };
}

async function streetViewAreas() {
  const outDir = path.join(ROOT, "street-view/out");
  const areas = [];
  let entries = [];
  try {
    entries = (await readdir(outDir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== "images");
  } catch {
    return areas;
  }

  for (const entry of entries) {
    const base = path.join(outDir, entry.name);
    const candidates = await readJsonSafe(path.join(base, "candidates.json"));
    if (!candidates) continue;  // not an area dir

    const metadata = await readJsonSafe(path.join(base, "street-view-metadata.json"));
    const covered = (metadata?.results || metadata?.captures || [])
      .filter((r) => r.ok || r.status === "OK").length || null;
    const images = await countFiles(path.join(base, "images"), ".jpg");

    // Any engine's analyses count toward "analyzed".
    const analyzed = { openai: null, claude: null, codex: null };
    for (const [key, file] of [
      ["openai", "openai-analyses.json"],
      ["claude", "claude-cli-analyses.json"],
      ["codex", "codex-cli-analyses.json"],
    ]) {
      const a = await readJsonSafe(path.join(base, file));
      if (a) analyzed[key] = (a.results || []).filter((r) => r.ok).length;
    }

    areas.push({
      area: entry.name,
      segments: candidates.segments?.length || 0,
      captures: candidates.segments?.reduce((s, seg) => s + (seg.captures?.length || 0), 0) || 0,
      captures_covered: covered,
      images_downloaded: images,
      analyzed,
    });
  }
  return areas.sort((a, b) => a.area.localeCompare(b.area));
}

async function dbState() {
  const p = await getPool();
  if (!p) return { available: false };
  try {
    const aerial = await p.query(
      "SELECT review_status, COUNT(*)::int AS n FROM parking.aerial_candidate WHERE current GROUP BY 1"
    );
    const street = await p.query(
      "SELECT review_status, COUNT(*)::int AS n FROM parking.area WHERE current AND active GROUP BY 1"
    );
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r.review_status, r.n]));
    return { available: true, aerial_review: toMap(aerial.rows), street_review: toMap(street.rows) };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

async function buildStatus() {
  const [heartbeats, processes, aerial, streetView, db] = await Promise.all([
    collectHeartbeats(), scanProcesses(), aerialState(), streetViewAreas(), dbState(),
  ]);

  // Merge ps results into heartbeats: a process seen in ps but without a fresh
  // heartbeat still shows as running (just without granular progress).
  const heartbeatByProcess = new Map(heartbeats.map((h) => [h.process, h]));
  for (const proc of processes) {
    const hb = heartbeatByProcess.get(proc.process);
    if (hb && hb.fresh && !hb.done) {
      hb.running = true;
    } else {
      heartbeats.push({
        process: proc.process, pid: proc.pid, running: true, no_heartbeat: true,
        message: proc.command, current: null, total: null, age_seconds: 0, fresh: true,
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    running: heartbeats.filter((h) => h.running || (h.fresh && !h.done)),
    recent: heartbeats.filter((h) => !h.running && (!h.fresh || h.done)),
    aerial,
    street_view: { areas: streetView },
    db,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/status.json")) {
      const body = JSON.stringify(await buildStatus());
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(body);
    }
    const file = req.url === "/" || req.url.startsWith("/index") ? "status.html"
      : req.url.startsWith("/status.css") ? "status.css"
      : req.url.startsWith("/status.js") ? "status.js"
      : null;
    if (!file) {
      res.writeHead(404);
      return res.end("not found");
    }
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(await readFile(path.join(HERE, file)));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`Status dashboard: http://localhost:${PORT}/ (localhost only)`);
});
