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
import { JobRunner, ENGINE_MODELS, STEPS, EFFORTS } from "./jobs.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env.STATUS_PORT || 8017);

// Origins allowed to SUBMIT jobs. Reading status is open (see the CORS header on
// /status.json), but submitting spawns a process, and "*" on that would let any page you
// happen to have open in another tab start LLM runs on this machine. Localhost only, and
// the Origin header is checked rather than assumed — a browser always sends it on
// cross-origin requests, so a missing one means the call did not come from a page.
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGIN.test(origin);
}

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
    // Review progress = spaces you have judged vs spaces still only a model's opinion.
    // parking.area is retired; observations are per-run and verdicts are per physical space.
    const street = await p.query(`
      SELECT review_status, COUNT(*)::int AS n FROM (
        SELECT v.review_status
        FROM parking.verdict v
        UNION ALL
        SELECT 'pending'
        FROM (SELECT DISTINCT segment_id, side FROM parking.observation) o
        WHERE NOT EXISTS (
          SELECT 1 FROM parking.verdict v2
          WHERE v2.segment_id = o.segment_id AND v2.side = o.side
        )
      ) x GROUP BY 1
    `);
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

const runner = new JobRunner({
  cwd: path.join(ROOT, "street-view"),
  logDir: path.join(ROOT, "data", "status", "jobs"),
  stateFile: path.join(ROOT, "data", "status", "jobs.json")
});

function sendJson(res, status, body, origin) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 64_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// The areas a job may name. Checked against the database rather than trusted from the
// client, so a typo fails at submit with a useful message instead of after the process has
// spawned and burned a minute discovering it selected nothing.
async function knownAreas() {
  const p = await getPool();
  if (!p) return null;
  const { rows } = await p.query(`
    SELECT DISTINCT mo_naziv AS name FROM parking.road_segment_mo WHERE mo_naziv IS NOT NULL
    UNION SELECT DISTINCT gc_naziv FROM parking.road_segment_mo WHERE gc_naziv IS NOT NULL
  `);
  return new Set(rows.map((r) => r.name));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  try {
    // --- job manager -----------------------------------------------------------------
    if (req.url.startsWith("/jobs")) {
      if (req.method === "OPTIONS") {
        return sendJson(res, isAllowedOrigin(origin) ? 204 : 403, {}, origin);
      }

      if (req.method === "GET" && req.url === "/jobs") {
        return sendJson(res, 200, {
          jobs: runner.list(),
          options: { steps: STEPS, engines: ENGINE_MODELS, efforts: EFFORTS }
        }, origin);
      }

      const logMatch = /^\/jobs\/([\w-]+)\/log/.exec(req.url);
      if (req.method === "GET" && logMatch) {
        const text = await runner.tail(logMatch[1]);
        if (text === null) return sendJson(res, 404, { error: "nepoznat posao" }, origin);
        return sendJson(res, 200, { id: logMatch[1], log: text }, origin);
      }

      // Everything below mutates. Same-origin-ish check first, always.
      if (req.method === "POST" && !isAllowedOrigin(origin)) {
        return sendJson(res, 403, {
          error: "submitting jobs is allowed only from a localhost page"
        }, origin);
      }

      const stopMatch = /^\/jobs\/([\w-]+)\/stop$/.exec(req.url);
      if (req.method === "POST" && stopMatch) {
        const result = await runner.stop(stopMatch[1]);
        return sendJson(res, result.ok ? 200 : 400, result, origin);
      }

      if (req.method === "POST" && req.url === "/jobs") {
        let spec;
        try {
          spec = await readBody(req);
        } catch (err) {
          return sendJson(res, 400, { ok: false, errors: [`neispravan zahtjev: ${err.message}`] }, origin);
        }
        if (!spec.benchmark && typeof spec.area === "string") {
          const areas = await knownAreas();
          if (areas && !areas.has(spec.area.trim())) {
            return sendJson(res, 400, {
              ok: false,
              errors: [`nepoznato područje "${spec.area}" — mora biti mjesni odbor ili gradska četvrt`]
            }, origin);
          }
        }
        const result = await runner.submit(spec, new Date().toISOString());
        if (result.ok) log(`job ${result.job.id} started: node ${result.job.argv.join(" ")}`);
        return sendJson(res, result.ok ? 200 : 400, result, origin);
      }

      return sendJson(res, 404, { error: "not found" }, origin);
    }

    if (req.url.startsWith("/status.json")) {
      const body = JSON.stringify(await buildStatus());
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        // Lets the "Status obrade" page (served from another localhost port) show what is
        // running right now beside what has already been processed — the two answer the
        // same question at different time scales. Safe to open up: this server binds
        // 127.0.0.1 and is never deployed, so there is no remote origin to protect from.
        "Access-Control-Allow-Origin": "*"
      });
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

await runner.init();

server.listen(PORT, "127.0.0.1", () => {
  log(`Status dashboard: http://localhost:${PORT}/ (localhost only)`);
  log(`Job manager active — submitting spawns pipeline runs; POST is restricted to localhost origins.`);
  const orphaned = runner.list().filter((j) => j.status === "running" && j.alive);
  if (orphaned.length) log(`Reattached to ${orphaned.length} job(s) still running from a previous server.`);
});
