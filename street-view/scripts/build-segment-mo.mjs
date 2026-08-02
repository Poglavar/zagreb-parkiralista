// Materialises parking.road_segment_mo: which mjesni odbor each road segment falls in,
// plus the concentric-circle processing order out from Trg bana Jelacica.
//
// Why a spatial join rather than road_width_segment.l3_names: that array already carries
// the MO name, but it carries the gradska cetvrt in the same array with nothing marking
// which is which ({"Donji grad","Pavao Subic"}), and the source's casing is inconsistent
// ("Donji Grad" vs "Donji grad"). ppv.boundary_jms gives a stable id, the parent via
// nadredjeni, and the polygon the status map needs.
//
// A segment that straddles two MOs is assigned to the one it shares the most length with,
// so every segment lands in exactly one ring and the queue has no duplicates.
import pg from "pg";
import { pathToFileURL } from "url";
import { readFile } from "fs/promises";
import { resolveFrom } from "./lib/io.mjs";

// Trg bana Josipa Jelacica — the centre of the concentric rings.
const CENTRE_LON = 15.9775;
const CENTRE_LAT = 45.8131;

const CADASTRE_ENV = resolveFrom(import.meta.url, "../../../cadastre-data/api/.env");

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function parseArgs(argv) {
  const args = { databaseUrl: process.env.DATABASE_URL, dryRun: true, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/build-segment-mo.mjs [--write]

Rebuilds parking.road_segment_mo — the segment -> mjesni odbor mapping and the
concentric ring order from Trg bana Jelacica (ring 1 = nearest MO).

Idempotent: a re-run produces the same table. Safe to run after any refresh of
road_width_segment or ppv.boundary_jms.

Options:
  --database-url URL   Override DATABASE_URL (default: env, then cadastre-data/api/.env)
  --write              Actually write (default: dry run, prints the ring preview)
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
    // fall through to the explicit error below
  }
  return null;
}

// One statement, because the assignment has to be atomic against the whole set:
// picking "the MO this segment shares most length with" is a window over all
// candidate overlaps, and doing it per-segment in JS would mean 12k round trips.
const BUILD_SQL = `
WITH centre AS (
    SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3765) AS g
),
mo AS (
    SELECT j.id, btrim(j.naziv, '"') AS naziv, btrim(j.nadredjeni, '"') AS nadredjeni, j.geom,
           ST_Distance(ST_Centroid(j.geom), c.g) / 1000.0 AS dist_km
    FROM ppv.boundary_jms j, centre c
    WHERE j.jls ILIKE '%zagreb%' AND j.status = 3
),
-- The source spells one gradska cetvrt two ways ("Donji grad" / "Donji Grad"), which
-- would split it into two groups everywhere it is used to aggregate. Fold
-- case-insensitively and keep the most common spelling. Derived from the data rather
-- than a hardcoded fix-up list, so a new inconsistency resolves itself.
gc_canon AS (
    SELECT DISTINCT ON (lower(nadredjeni)) lower(nadredjeni) AS k, nadredjeni AS canon
    FROM (SELECT nadredjeni, COUNT(*) AS n FROM mo GROUP BY nadredjeni) t
    ORDER BY lower(nadredjeni), n DESC, nadredjeni
),
ranked_mo AS (
    SELECT m.id, m.naziv, g.canon AS nadredjeni, m.geom, m.dist_km,
           dense_rank() OVER (ORDER BY m.dist_km) AS ring_index
    FROM mo m JOIN gc_canon g ON g.k = lower(m.nadredjeni)
),
seg AS (
    SELECT id, osm_id, ST_Transform(geom, 3765) AS geom FROM public.road_width_segment
),
overlap AS (
    SELECT s.id AS road_segment_id,
           s.osm_id,
           m.id AS mo_id,
           m.naziv,
           m.nadredjeni,
           m.ring_index,
           m.dist_km,
           -- Straddling segments go to whichever MO holds the most of them.
           ST_Length(ST_Intersection(s.geom, m.geom)) AS shared_m
    FROM seg s
    JOIN ranked_mo m ON ST_Intersects(s.geom, m.geom)
),
best AS (
    SELECT DISTINCT ON (road_segment_id)
           road_segment_id, osm_id, mo_id, naziv, nadredjeni, ring_index, dist_km
    FROM overlap
    ORDER BY road_segment_id, shared_m DESC, mo_id
)
-- Names are already unquoted and case-folded in the CTEs above, so the UI and the
-- --area argument both see one spelling per place.
SELECT road_segment_id, osm_id, mo_id,
       naziv       AS mo_naziv,
       nadredjeni  AS gc_naziv,
       ring_index, dist_km
FROM best
`;

export async function buildSegmentMo({ databaseUrl, dryRun }) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    log("Computing segment -> mjesni odbor assignment (spatial join, this takes a moment)…");
    const { rows } = await pool.query(BUILD_SQL, [CENTRE_LON, CENTRE_LAT]);
    log(`Assigned ${rows.length.toLocaleString("hr-HR")} road segments to mjesni odbori`);

    // Ring preview: the processing queue, in order.
    const byMo = new Map();
    for (const r of rows) {
      const key = `${r.ring_index}|${r.mo_naziv}|${r.gc_naziv}|${r.dist_km}`;
      byMo.set(key, (byMo.get(key) || 0) + 1);
    }
    const rings = [...byMo.entries()]
      .map(([k, count]) => {
        const [ring, mo, gc, dist] = k.split("|");
        return { ring: Number(ring), mo, gc, dist: Number(dist), count };
      })
      .sort((a, b) => a.ring - b.ring);

    log(`${rings.length} mjesni odbori carry road segments. First 15 in ring order:`);
    for (const r of rings.slice(0, 15)) {
      log(`  ${String(r.ring).padStart(3)}. ${r.mo.padEnd(34)} ${r.gc.padEnd(24)} ${r.dist.toFixed(2)} km  ${String(r.count).padStart(4)} seg`);
    }

    const unassigned = await pool.query(`
      SELECT COUNT(*)::int AS n FROM public.road_width_segment r
      WHERE NOT EXISTS (
        SELECT 1 FROM ppv.boundary_jms j
        WHERE j.jls ILIKE '%zagreb%' AND j.status = 3
          AND ST_Intersects(ST_Transform(r.geom, 3765), j.geom))
    `);
    // Say what was skipped, so a partial map cannot read as a complete one.
    if (unassigned.rows[0].n > 0) {
      log(`NOTE: ${unassigned.rows[0].n} segments fall outside every Zagreb mjesni odbor boundary — they will have mo_id NULL and never appear in a ring.`);
    }

    if (dryRun) {
      log("Dry run — nothing written. Pass --write to persist.");
      return { assigned: rows.length, rings: rings.length };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Full rebuild: the mapping is derived, so there is no state worth preserving,
      // and a stale row pointing at a since-deleted MO would be worse than absent.
      await client.query("TRUNCATE parking.road_segment_mo");
      await client.query(`
        INSERT INTO parking.road_segment_mo
          (road_segment_id, osm_id, mo_id, mo_naziv, gc_naziv, ring_index, dist_km)
        SELECT * FROM unnest(
          $1::int[], $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::int[], $7::real[]
        )
      `, [
        rows.map((r) => r.road_segment_id),
        rows.map((r) => r.osm_id),
        rows.map((r) => r.mo_id),
        rows.map((r) => r.mo_naziv),
        rows.map((r) => r.gc_naziv),
        rows.map((r) => r.ring_index),
        rows.map((r) => r.dist_km)
      ]);
      // Boundary polygons for the status map, at both levels, simplified once here so no
      // request ever pays for the union again. Built in the same transaction as the
      // segment assignment so the two cannot disagree about which MOs exist.
      await client.query("TRUNCATE parking.area_boundary");
      await client.query(`
        INSERT INTO parking.area_boundary (level, name, parent, ring_index, geom)
        SELECT 'mo', m.mo_naziv, MIN(m.gc_naziv), MIN(m.ring_index),
               ST_Multi(ST_SimplifyPreserveTopology(
                   ST_Transform(ST_Union(j.geom), 4326), 0.0001))
        FROM parking.road_segment_mo m
        JOIN ppv.boundary_jms j ON j.id = m.mo_id
        GROUP BY m.mo_naziv
      `);
      await client.query(`
        INSERT INTO parking.area_boundary (level, name, parent, ring_index, geom)
        SELECT 'gc', m.gc_naziv, NULL, MIN(m.ring_index),
               ST_Multi(ST_SimplifyPreserveTopology(
                   ST_Transform(ST_Union(j.geom), 4326), 0.0001))
        FROM parking.road_segment_mo m
        JOIN ppv.boundary_jms j ON j.id = m.mo_id
        GROUP BY m.gc_naziv
      `);
      const { rows: bcount } = await client.query(
        "SELECT level, COUNT(*)::int AS n FROM parking.area_boundary GROUP BY level ORDER BY level");

      await client.query("COMMIT");
      log(`Wrote ${rows.length.toLocaleString("hr-HR")} rows to parking.road_segment_mo`);
      log(`Wrote boundaries: ${bcount.map((b) => `${b.n} ${b.level}`).join(", ")}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { assigned: rows.length, rings: rings.length };
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  const databaseUrl = await loadDatabaseUrl(args.databaseUrl);
  if (!databaseUrl) throw new Error("DATABASE_URL not set and cadastre-data/api/.env is unreadable.");
  await buildSegmentMo({ databaseUrl, dryRun: args.dryRun });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[${ts()}] FATAL: ${err.message}`);
    process.exit(1);
  });
}
