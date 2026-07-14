// Re-attaches parking data to the road network after the road-width source (or OSM) is
// regenerated. segment_id is only a position in that export — it renumbers freely — so
// this matches on what actually identifies a piece of kerb: its geometry, narrowed by
// osm_id where we have it.
//
// It NEVER silently re-points anything. Every space lands in exactly one bucket:
//   ok        — same segment, same place. Nothing to do.
//   moved     — the geometry shifted slightly (someone nudged the OSM nodes). Re-attach.
//   renumbered— same kerb, new segment_id (the export renumbered). Re-attach.
//   ambiguous — more than one plausible candidate. REPORTED, never guessed.
//   orphaned  — nothing matches (way deleted or redrawn). REPORTED, never dropped.
//
// Verdicts carry their own geometry, so even an orphaned verdict is still correct on the
// map — it just loses its link to a segment. Nothing is ever deleted here.
import pg from "pg";
import { readJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = { source: null, databaseUrl: process.env.DATABASE_URL, toleranceM: 8, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--source") args.source = argv[++i];
    else if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--tolerance-m") args.toleranceM = Number(argv[++i]);
    else if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/reconcile-segments.mjs [--source road-width-zagreb.json] [--apply]");
      console.log("");
      console.log("Re-attaches parking segments after the road network is refreshed.");
      console.log("Reads road_width_segment from the database by default — that table is the");
      console.log("source of truth. --source only exists to diff against a JSON export before");
      console.log("it has been loaded.");
      console.log("Reports by default; --apply writes the re-attachments. Never deletes, never guesses.");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

// The road network as the database holds it. This is the source of truth: a JSON export on
// disk is a snapshot that goes stale the moment the analysis is re-run.
async function loadIncomingFromDb(client) {
  const { rows } = await client.query(`
    SELECT id::text AS id, osm_id AS osm, street_name AS nm,
           ST_AsGeoJSON(geom)::json -> 'coordinates' AS c
    FROM road_width_segment
  `);
  return rows;
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.databaseUrl) throw new Error("DATABASE_URL is not set. Source .env first.");

  const pool = new pg.Pool({ connectionString: args.databaseUrl });
  const client = await pool.connect();
  const buckets = { ok: [], moved: [], renumbered: [], ambiguous: [], orphaned: [] };

  try {
    let incoming;
    if (args.source) {
      const source = await readJson(args.source);
      incoming = source.segmentLines || [];
      log(`Road network from JSON export ${args.source}: ${incoming.length} segments (generated ${source.generated})`);
    } else {
      incoming = await loadIncomingFromDb(client);
      log(`Road network from road_width_segment: ${incoming.length} segments`);
    }
    if (incoming.length && incoming[0].osm == null) {
      log("WARNING: this source carries no osm_id — matching will be geometry-only.");
    }

    // Everything we would lose if a re-numbering went unnoticed.
    const { rows: spaces } = await client.query(`
      SELECT s.segment_id, s.osm_id, s.street_name,
             ST_AsGeoJSON(ST_LineInterpolatePoint(s.geom, 0.5))::json AS midpoint,
             (SELECT COUNT(*) FROM parking.verdict v WHERE v.segment_id = s.segment_id) AS verdicts,
             (SELECT COUNT(*) FROM parking.observation o WHERE o.segment_id = s.segment_id) AS observations
      FROM parking.segment s
      WHERE s.segment_id NOT LIKE 'manual-%'
    `);
    log(`Existing: ${spaces.length} segments carrying ${spaces.reduce((a, s) => a + Number(s.verdicts), 0)} verdicts and ${spaces.reduce((a, s) => a + Number(s.observations), 0)} observations`);

    const R = 6378137, rad = Math.PI / 180;
    const distM = (a, b) => {
      const k = Math.cos(a[1] * rad);
      return Math.hypot((a[0] - b[0]) * rad * R * k, (a[1] - b[1]) * rad * R);
    };

    // The point half way ALONG the line — not the middle vertex. On a two-point segment
    // the middle vertex is the endpoint, which would put every comparison half a segment
    // out and orphan the lot. Must match PostGIS ST_LineInterpolatePoint(geom, 0.5).
    const midpointOf = (coords) => {
      const spans = [];
      let total = 0;
      for (let i = 0; i < coords.length - 1; i += 1) {
        const d = distM(coords[i], coords[i + 1]);
        spans.push(d);
        total += d;
      }
      if (total === 0) return coords[0];
      let walked = 0;
      for (let i = 0; i < spans.length; i += 1) {
        if (walked + spans[i] >= total / 2) {
          const t = spans[i] === 0 ? 0 : (total / 2 - walked) / spans[i];
          const [x1, y1] = coords[i];
          const [x2, y2] = coords[i + 1];
          return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
        }
        walked += spans[i];
      }
      return coords[coords.length - 1];
    };

    // Distance from a point to a polyline. This is the metric that matters: a station
    // sub-segment ("582-s2") is a SLICE of its parent, so its midpoint sits on the parent's
    // line but nowhere near the parent's midpoint. Point-to-line handles both cases.
    const pointToLineM = (p, coords) => {
      let best = Infinity;
      for (let i = 0; i < coords.length - 1; i += 1) {
        const [x1, y1] = coords[i];
        const [x2, y2] = coords[i + 1];
        const k = Math.cos(p[1] * rad);
        const px = (p[0] - x1) * k, py = p[1] - y1;
        const vx = (x2 - x1) * k, vy = y2 - y1;
        const len2 = vx * vx + vy * vy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / len2));
        const dx = (px - vx * t) * rad * R;
        const dy = (py - vy * t) * rad * R;
        best = Math.min(best, Math.hypot(dx, dy));
      }
      return best;
    };

    // Index the incoming export by its own midpoint so we can match kerb-to-kerb.
    const byOsm = new Map();
    const allIncoming = [];
    for (const seg of incoming) {
      const entry = {
        id: String(seg.id),
        osm: seg.osm != null ? Number(seg.osm) : null,
        name: seg.nm || null,
        mid: midpointOf(seg.c),
        coords: seg.c
      };
      allIncoming.push(entry);
      if (entry.osm != null) {
        if (!byOsm.has(entry.osm)) byOsm.set(entry.osm, []);
        byOsm.get(entry.osm).push(entry);
      }
    }

    for (const sp of spaces) {
      const mid = sp.midpoint.coordinates;
      // A station sub-segment ("582-s2") shares its parent's geometry and its parent's id
      // in the export. Match on the base id and carry the suffix through.
      const suffixMatch = /-s\d+.*$/.exec(sp.segment_id);
      const suffix = suffixMatch ? suffixMatch[0] : "";
      const baseId = suffix ? sp.segment_id.slice(0, -suffix.length) : sp.segment_id;
      // osm_id narrows the field; one way can hold several segments, so geometry decides.
      const candidates = (sp.osm_id != null && byOsm.has(Number(sp.osm_id)))
        ? byOsm.get(Number(sp.osm_id))
        : allIncoming;

      const near = candidates
        .map((cand) => ({ ...cand, d: pointToLineM(mid, cand.coords) }))
        .filter((cand) => cand.d <= args.toleranceM)
        .sort((a, b) => a.d - b.d);

      // If the id we already hold is itself a good geometric match, that settles it —
      // identity and geometry agreeing beats a neighbouring line happening to run close by.
      const selfMatch = near.find((n) => n.id === baseId && n.d <= 1);

      if (near.length === 0) {
        buckets.orphaned.push({ ...sp, reason: sp.osm_id == null ? "no osm_id and nothing within tolerance" : "osm way gone or moved further than tolerance" });
      } else if (selfMatch) {
        buckets.ok.push({ ...sp, newId: sp.segment_id, d: selfMatch.d });
      } else if (near.length > 1 && near[1].d - near[0].d < 2) {
        // Two candidates we cannot tell apart, and neither is the id we hold. Say so.
        buckets.ambiguous.push({ ...sp, candidates: near.slice(0, 3).map((n) => `${n.id}@${n.d.toFixed(1)}m`) });
      } else if (near[0].id === baseId) {
        (near[0].d < 1 ? buckets.ok : buckets.moved).push({ ...sp, newId: sp.segment_id, d: near[0].d });
      } else {
        // Carry the station suffix across: a renumbered "582-s2" becomes "<new>-s2".
        buckets.renumbered.push({ ...sp, newId: near[0].id + suffix, newName: near[0].name, d: near[0].d });
      }
    }

    console.log("");
    log("=== reconciliation ===");
    for (const [name, rows] of Object.entries(buckets)) {
      const verdicts = rows.reduce((a, r) => a + Number(r.verdicts), 0);
      console.log(`  ${name.padEnd(11)} ${String(rows.length).padStart(5)} segments  (${verdicts} verdicts affected)`);
    }

    for (const b of ["ambiguous", "orphaned"]) {
      if (!buckets[b].length) continue;
      console.log(`\n  --- ${b.toUpperCase()}: needs a human, not a guess ---`);
      for (const r of buckets[b].slice(0, 15)) {
        const v = Number(r.verdicts) ? ` [${r.verdicts} VERDICT(S)]` : "";
        console.log(`    ${r.segment_id} (${r.street_name || "unnamed"})${v} — ${r.reason || r.candidates.join(", ")}`);
      }
      if (buckets[b].length > 15) console.log(`    ... and ${buckets[b].length - 15} more`);
    }

    if (!args.apply) {
      console.log("\nDry run — nothing written. Pass --apply to re-attach the 'moved' and 'renumbered' segments.");
      return;
    }

    // Only the unambiguous ones get rewritten. Ambiguous and orphaned are left exactly as
    // they are: their geometry still places them correctly on the map.
    const toApply = buckets.renumbered;
    await client.query("BEGIN");
    for (const r of toApply) {
      await client.query("UPDATE parking.segment  SET segment_id = $2 WHERE segment_id = $1", [r.segment_id, r.newId]);
      await client.query("UPDATE parking.observation SET segment_id = $2 WHERE segment_id = $1", [r.segment_id, r.newId]);
      await client.query("UPDATE parking.verdict     SET segment_id = $2 WHERE segment_id = $1", [r.segment_id, r.newId]);
    }
    await client.query("COMMIT");
    log(`Re-attached ${toApply.length} renumbered segments. ${buckets.ambiguous.length + buckets.orphaned.length} left for manual review.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
