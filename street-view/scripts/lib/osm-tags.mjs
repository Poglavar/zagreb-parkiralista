// Loads the OSM tags for road segments, so they can be offered to the classifier as text.
//
// The tags worth having are cheap and directly relevant: `parking:lane:*` says what OSM
// already believes about this kerb, `sidewalk` says whether there is a pavement to park on,
// `highway` bounds what kind of street it is, and tram/`railway` presence is a strong
// no-parking signal the prompt already asks the model to respect. All of it costs a few
// dozen tokens, versus an image's few thousand.
//
// This is deliberately a SEPARATE input from the imagery. OSM is a prior, not ground truth —
// only ~8% of Zagreb parking features carry a capacity tag and parking:lane coverage is
// thinner still — so the prompt frames it as "what the map claims", not as the answer.
import pg from "pg";

// Tags that bear on kerbside parking. Everything else in the object is noise for this task
// and would only dilute attention.
const RELEVANT = [
  "highway", "oneway", "lanes", "width", "surface", "maxspeed", "service",
  "sidewalk", "sidewalk:left", "sidewalk:right", "sidewalk:both",
  "parking:zone", "parking", "parking:both", "parking:left", "parking:right",
  "railway", "tram", "embedded_rails",
  "access", "motor_vehicle", "living_street", "area:highway"
];

function isRelevant(key) {
  if (RELEVANT.includes(key)) return true;
  // Anything in the parking: or sidewalk: namespaces, which is where the useful detail
  // actually lives (parking:lane:left:parallel and friends).
  return key.startsWith("parking:") || key.startsWith("sidewalk:") || key.startsWith("cycleway:");
}

export function filterTags(tags) {
  if (!tags || typeof tags !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k === "name" || k === "old_name") continue;   // already in the prompt header
    if (isRelevant(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// segment_id (base, no station suffix) -> filtered tag object.
export async function loadOsmTags(databaseUrl, segmentIds) {
  const ids = [...new Set(segmentIds.map((s) => String(s).replace(/-s\d+$/, "")))]
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
  if (ids.length === 0) return new Map();

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    // DISTINCT ON because osm_road keeps versions; take the current row per way.
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (r.id) r.id, o.tags
      FROM public.road_width_segment r
      JOIN public.osm_road o ON o.osm_id = r.osm_id AND o.current
      WHERE r.id = ANY($1::int[])
      ORDER BY r.id, o.version DESC
    `, [ids]);
    const map = new Map();
    for (const row of rows) {
      const t = filterTags(row.tags);
      if (t) map.set(String(row.id), t);
    }
    return map;
  } finally {
    await pool.end();
  }
}

// Render for the prompt. Sorted so the same tags always produce the same string — an
// unstable ordering would make two otherwise identical runs incomparable.
export function formatTags(tags) {
  if (!tags) return null;
  return Object.keys(tags).sort().map((k) => `${k}=${tags[k]}`).join(", ");
}
