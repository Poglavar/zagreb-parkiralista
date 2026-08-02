// Reconstructs parking.segment_coverage and parking.segment_imagery for work done before
// those tables existed. Without this, every run in the database looks like it covered only
// the streets where it happened to find parking, and the status map paints ~1,200 correctly
// analysed empty streets as untouched.
//
// Two halves, with very different confidence levels — kept separate on purpose:
//
//   IMAGERY  Unambiguous. Walk out/<area>/, read the candidates + metadata + images
//            manifests, upsert the counts. No run involved; imagery belongs to the street.
//
//   COVERAGE Needs the analyses JSON that produced a given run, and nothing on disk records
//            which file that was. So: derive the floor from the observations themselves
//            (a segment with an observation was certainly covered, outcome 'parking'), then
//            try to identify each run's analyses file by matching its parking-positive
//            segment set EXACTLY. A unique exact match over hundreds of segments is not a
//            coincidence; anything less is reported for a human to resolve with --map,
//            never guessed. Runs left unmatched keep the floor and are listed, so a partial
//            backfill can never read as a complete one.
import pg from "pg";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { fileExists, readJson, resolveFrom } from "./lib/io.mjs";

const OUT_DIR = resolveFrom(import.meta.url, "../out");
const CADASTRE_ENV = resolveFrom(import.meta.url, "../../../cadastre-data/api/.env");

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function parseArgs(argv) {
  const args = { databaseUrl: null, dryRun: true, map: new Map(), help: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--map") {
      const raw = argv[++i];
      const eq = raw.indexOf("=");
      if (eq < 0) throw new Error(`--map expects run_id=path/to/analyses.json, got "${raw}"`);
      // Comma-separated, because the legacy runs were each ingested from several files
      // (donji-grad + tresnjevka-sjever + the remainder all landed in one run_id).
      args.map.set(raw.slice(0, eq), raw.slice(eq + 1).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/backfill-coverage.mjs [--write] [--map run_id=path]

Backfills parking.segment_imagery from the manifests in out/<area>/, and
parking.segment_coverage for runs that predate the coverage table.

Coverage for a run needs the analyses JSON it was ingested from. This script
identifies that file automatically when exactly one candidate matches the run's
parking-positive segment set; otherwise it reports the run and you supply the
file yourself:

  node scripts/backfill-coverage.mjs --map trnje-fable5=out/trnje/claude-cli-analyses-fable5.json --write

Runs with no analyses file still get a coverage floor derived from their own
observations (outcome 'parking' only) — correct as far as it goes, but it cannot
recover the segments where the model found nothing. Those runs are listed at the
end so a partial backfill is never mistaken for a complete one.

Options:
  --database-url URL   Override DATABASE_URL (default: env, then cadastre-data/api/.env)
  --map ID=PATH        Bind a run_id to its analyses JSON (repeatable)
  --write              Actually write (default: dry run)
  --help               Show this message
`);
}

async function loadDatabaseUrl(explicit) {
  if (explicit) return explicit;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = await readFile(CADASTRE_ENV, "utf8");
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    // fall through
  }
  return null;
}

// --- imagery -------------------------------------------------------------------

// Every (candidates, metadata, images) triple on disk, in both layouts:
//   out/<area>/candidates.json + street-view-metadata.json + street-view-images.json
//   out/<prefix>-candidates.json + <prefix>-metadata.json + <prefix>-images.json   (pre-2026-07)
// The flat layout holds Tresnjevka, which is 761 analysed segments — skipping it made the
// status map claim the most-processed cetvrt in the city had no imagery at all.
async function findManifestSets() {
  const sets = [];
  const entries = await readdir(OUT_DIR, { withFileTypes: true });

  for (const e of entries) {
    if (!e.isDirectory() || e.name === "images" || e.name === "mock-images") continue;
    const dir = path.join(OUT_DIR, e.name);
    const candidates = path.join(dir, "candidates.json");
    if (!await fileExists(candidates)) continue;
    sets.push({
      label: e.name,
      candidates,
      metadata: path.join(dir, "street-view-metadata.json"),
      images: path.join(dir, "street-view-images.json")
    });
  }

  for (const e of entries) {
    if (e.isDirectory()) continue;
    const m = /^(.*)-candidates\.json$/.exec(e.name);
    if (!m) continue;
    const prefix = m[1];
    if (prefix.startsWith("live-") || prefix.startsWith("mock-")) continue;   // one-off smoke tests
    sets.push({
      label: `${prefix} (flat)`,
      candidates: path.join(OUT_DIR, e.name),
      metadata: path.join(OUT_DIR, `${prefix}-metadata.json`),
      images: path.join(OUT_DIR, `${prefix}-images.json`)
    });
  }

  return sets;
}

async function collectImagery() {
  const inventory = new Map();
  const bump = (sid) => {
    if (!inventory.has(sid)) {
      inventory.set(sid, { segment_id: sid, capture_count: 0, covered_count: 0, image_count: 0 });
    }
    return inventory.get(sid);
  };

  const areas = [];
  for (const set of await findManifestSets()) {
    areas.push(set.label);

    const cand = await readJson(set.candidates);
    for (const seg of cand.segments || []) {
      // A segment can appear in more than one area export (boundaries overlap), so take
      // the max rather than adding — otherwise a street on a boundary reports double the
      // captures it actually has.
      const inv = bump(String(seg.segment_id));
      inv.capture_count = Math.max(inv.capture_count, (seg.captures || []).length);
    }

    const metaPath = set.metadata;
    if (await fileExists(metaPath)) {
      const meta = await readJson(metaPath);
      const perSeg = new Map();
      for (const m of meta.results || []) {
        if (m.ok && m.response?.status === "OK") {
          perSeg.set(String(m.segment_id), (perSeg.get(String(m.segment_id)) || 0) + 1);
        }
      }
      for (const [sid, n] of perSeg) bump(sid).covered_count = Math.max(bump(sid).covered_count, n);
    }

    const imgPath = set.images;
    if (await fileExists(imgPath)) {
      const imgs = await readJson(imgPath);
      const perSeg = new Map();
      for (const im of imgs.images || []) {
        if (!im.ok || !im.image_path) continue;
        const sid = String(im.segment_id ?? String(im.capture_id).split("-s")[0]);
        perSeg.set(sid, (perSeg.get(sid) || 0) + 1);
      }
      for (const [sid, n] of perSeg) bump(sid).image_count = Math.max(bump(sid).image_count, n);
    }
  }

  log(`Imagery scanned from ${areas.length} manifest sets: ${areas.join(", ")}`);
  return [...inventory.values()];
}

// --- coverage ------------------------------------------------------------------

// Every *-analyses*.json under out/, with the set of segments it found parking on.
// That set is the fingerprint used to match a file to a run.
async function indexAnalysesFiles() {
  const found = [];
  const entries = await readdir(OUT_DIR, { withFileTypes: true });

  // The per-area subdirectories are the current layout; the flat out/ root holds the
  // pre-2026-07 runs (tresnjevka-*, donji-grad-openai.json), which is exactly where the
  // legacy run_ids come from. Scan both or the oldest runs can never be matched.
  const dirs = [OUT_DIR, ...entries
    .filter((e) => e.isDirectory() && e.name !== "images" && e.name !== "mock-images")
    .map((e) => path.join(OUT_DIR, e.name))];

  for (const dir of dirs) {
    for (const f of await readdir(dir)) {
      if (!/(analyses|openai)[^/]*\.json$/.test(f)) continue;
      if (/batch-status|catalog|bundle/.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const data = await readJson(full);
        if (!Array.isArray(data.results)) continue;
        const positives = new Set();
        for (const r of data.results) {
          if (!r.ok || !r.assessment) continue;
          const stations = r.assessment.stations || [r.assessment];
          const any = stations.some((s) =>
            s?.segment_left?.parking_present || s?.segment_right?.parking_present);
          if (any) positives.add(String(r.segment_id));
        }
        found.push({ file: full, area: path.basename(dir), data, positives });
      } catch {
        log(`  (skipping unreadable ${path.relative(OUT_DIR, full)})`);
      }
    }
  }
  log(`Indexed ${found.length} analyses files under out/`);
  return found;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// Turn one analyses file into coverage rows for a run.
function coverageFromAnalyses(data) {
  const rows = [];
  for (const r of data.results || []) {
    const sid = String(r.segment_id);
    if (!r.ok) {
      rows.push({ segment_id: sid, outcome: "failed", station_count: null, sides: 0, error: (r.error || "unknown").slice(0, 500) });
      continue;
    }
    const stations = r.assessment?.stations || (r.assessment ? [r.assessment] : []);
    let sides = 0;
    for (const s of stations) {
      if (s?.segment_left?.parking_present) sides += 1;
      if (s?.segment_right?.parking_present) sides += 1;
    }
    rows.push({
      segment_id: sid,
      outcome: sides > 0 ? "parking" : "no_parking",
      station_count: stations.length || null,
      sides,
      error: null
    });
  }
  return rows;
}

async function writeCoverage(client, runId, rows) {
  await client.query(`
    INSERT INTO parking.segment_coverage
      (run_id, segment_id, osm_id, street_name, outcome, station_count, sides_with_parking, error)
    SELECT $1, c.segment_id, r.osm_id, r.street_name, c.outcome, c.station_count, c.sides, c.error
    FROM unnest($2::text[], $3::text[], $4::int[], $5::int[], $6::text[])
         AS c(segment_id, outcome, station_count, sides, error)
    LEFT JOIN public.road_width_segment r ON r.id::text = c.segment_id
    ON CONFLICT (run_id, segment_id) DO UPDATE SET
      outcome = EXCLUDED.outcome, station_count = EXCLUDED.station_count,
      sides_with_parking = EXCLUDED.sides_with_parking, error = EXCLUDED.error,
      osm_id = EXCLUDED.osm_id, street_name = EXCLUDED.street_name
  `, [
    runId,
    rows.map((r) => r.segment_id),
    rows.map((r) => r.outcome),
    rows.map((r) => r.station_count),
    rows.map((r) => r.sides),
    rows.map((r) => r.error)
  ]);
}

export async function backfill({ databaseUrl, dryRun, map }) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const inventory = await collectImagery();
    log(`Imagery inventory: ${inventory.length} segments`);

    const analyses = await indexAnalysesFiles();
    const { rows: runs } = await pool.query(
      "SELECT run_id, area, model, engine FROM parking.run ORDER BY created_at");
    log(`${runs.length} runs in the database`);

    const plan = [];
    const unmatched = [];
    for (const run of runs) {
      // The run's own observations give both the floor and the fingerprint. Station
      // suffixes are stripped: coverage is per street, observations are per station.
      const { rows: obs } = await pool.query(
        `SELECT DISTINCT regexp_replace(segment_id, '-s[0-9]+$', '') AS sid
         FROM parking.observation WHERE run_id = $1`, [run.run_id]);
      const runPositives = new Set(obs.map((o) => o.sid));

      // An analyses file can only ADD to what the observations already prove. If the run
      // holds an observation for a segment the file does not mention (files get moved,
      // renamed, partially re-run), dropping it would make the backfill lose information
      // it already had. So every path below is unioned with the floor.
      const withFloor = (rows) => {
        const byId = new Map(rows.map((r) => [r.segment_id, r]));
        let added = 0;
        for (const sid of runPositives) {
          if (byId.has(sid)) continue;
          byId.set(sid, { segment_id: sid, outcome: "parking", station_count: null, sides: 0, error: null });
          added += 1;
        }
        if (added) log(`  note: ${run.run_id} — ${added} observed segment(s) absent from the analyses file, kept from observations`);
        return [...byId.values()];
      };

      const explicit = map.get(run.run_id);
      if (explicit) {
        // Merge the files by segment, last writer wins per segment. A segment appearing in
        // two files with different outcomes means the later file re-analysed it, which is
        // exactly what "remaining" files were for.
        const merged = new Map();
        for (const p of explicit) {
          for (const row of coverageFromAnalyses(await readJson(path.resolve(p)))) {
            merged.set(row.segment_id, row);
          }
        }
        plan.push({ run, source: `--map ${explicit.join(" + ")}`, rows: withFloor([...merged.values()]), exact: true });
        continue;
      }

      const hits = analyses.filter((a) => sameSet(a.positives, runPositives));
      if (hits.length === 1) {
        plan.push({
          run,
          source: path.relative(OUT_DIR, hits[0].file),
          rows: withFloor(coverageFromAnalyses(hits[0].data)),
          exact: true
        });
      } else {
        // Floor only: what we can prove from the observations alone.
        plan.push({
          run,
          source: hits.length === 0 ? "observations only (no analyses file matched)" : `observations only (${hits.length} files matched — ambiguous)`,
          rows: [...runPositives].map((sid) => ({ segment_id: sid, outcome: "parking", station_count: null, sides: 0, error: null })),
          exact: false
        });
        unmatched.push({
          run_id: run.run_id,
          reason: hits.length === 0 ? "no analyses file matched" : `${hits.length} files matched`,
          candidates: hits.map((h) => path.relative(OUT_DIR, h.file))
        });
      }
    }

    log("");
    log("Coverage plan:");
    for (const p of plan) {
      const tally = p.rows.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {});
      log(`  ${p.exact ? "✓" : "~"} ${p.run.run_id.padEnd(30)} ${String(p.rows.length).padStart(5)} segs  ` +
          `(parking ${tally.parking || 0}, empty ${tally.no_parking || 0}, failed ${tally.failed || 0})  ← ${p.source}`);
    }

    if (dryRun) {
      log("");
      log("Dry run — nothing written. Pass --write to persist.");
      if (unmatched.length) reportUnmatched(unmatched);
      return { inventory: inventory.length, plan };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (inventory.length > 0) {
        await client.query(`
          INSERT INTO parking.segment_imagery
            (segment_id, source, capture_count, covered_count, image_count, fetched_at)
          SELECT i.segment_id, 'google_street_view', i.capture_count, i.covered_count, i.image_count, now()
          FROM unnest($1::text[], $2::int[], $3::int[], $4::int[])
               AS i(segment_id, capture_count, covered_count, image_count)
          ON CONFLICT (segment_id, source) DO UPDATE SET
            capture_count = GREATEST(parking.segment_imagery.capture_count, EXCLUDED.capture_count),
            covered_count = GREATEST(parking.segment_imagery.covered_count, EXCLUDED.covered_count),
            image_count   = GREATEST(parking.segment_imagery.image_count,   EXCLUDED.image_count),
            updated_at = now()
        `, [
          inventory.map((i) => i.segment_id),
          inventory.map((i) => i.capture_count),
          inventory.map((i) => i.covered_count),
          inventory.map((i) => i.image_count)
        ]);
        log(`Wrote imagery for ${inventory.length} segments`);
      }
      for (const p of plan) {
        if (p.rows.length === 0) continue;
        await writeCoverage(client, p.run.run_id, p.rows);
      }
      await client.query("COMMIT");
      log(`Wrote coverage for ${plan.length} runs`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (unmatched.length) reportUnmatched(unmatched);
    return { inventory: inventory.length, plan };
  } finally {
    await pool.end();
  }
}

// Loud, because a run backfilled from observations alone is missing exactly the rows this
// whole exercise exists to recover — its correctly-empty streets still look untouched.
function reportUnmatched(unmatched) {
  log("");
  log(`WARNING: ${unmatched.length} run(s) got a coverage FLOOR only — their 'analysed, no parking'`);
  log("segments are still missing and will show as untouched on the status map:");
  for (const u of unmatched) {
    log(`  ${u.run_id} — ${u.reason}`);
    for (const c of u.candidates) log(`      candidate: ${c}`);
  }
  log("Re-run with --map <run_id>=<analyses.json> for each to complete them.");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  const databaseUrl = await loadDatabaseUrl(args.databaseUrl);
  if (!databaseUrl) throw new Error("DATABASE_URL not set and cadastre-data/api/.env is unreadable.");
  await backfill({ databaseUrl, dryRun: args.dryRun, map: args.map });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[${ts()}] FATAL: ${err.message}`);
    process.exit(1);
  });
}
