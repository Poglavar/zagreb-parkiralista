// Turns the three artifacts an area's image fetch produces — the capture plan, the free
// metadata preflight, and the JPEGs actually on disk — into one row per road segment, and
// records them in parking.segment_imagery.
//
// This lives on its own because imagery is a fact about the STREET, not about any model
// run. It is fully known the moment the images step finishes, and the status map is wrong
// until it is written down. It used to be computed only inside ingest-to-db.mjs, which
// meant an area that was fetched but never analysed stayed completely invisible: Vrbani
// had 271 JPEGs on disk and 87 segments reading "never checked" on the map, so the next
// run would have re-checked and re-fetched all of it.

// Pure: three arrays in, one inventory out. The three counts are deliberately kept apart —
// a planned capture that Google has no panorama for is a permanent gap in the city, not a
// stalled download, and conflating them makes the queue look like it holds work that no
// amount of fetching can ever clear.
export function tallyImagery({ candidateSegments = [], imageRecords = [], metadataResults = [] }) {
  const bySegment = new Map();
  const row = (sid) => {
    if (!bySegment.has(sid)) {
      bySegment.set(sid, { segment_id: sid, capture_count: 0, covered_count: 0, image_count: 0 });
    }
    return bySegment.get(sid);
  };

  for (const seg of candidateSegments) {
    row(String(seg.segment_id)).capture_count = (seg.captures || []).length;
  }
  for (const m of metadataResults) {
    if (m.ok && m.response?.status === "OK") row(String(m.segment_id)).covered_count += 1;
  }
  for (const img of imageRecords) {
    if (!img.ok || !img.image_path) continue;
    // capture ids are "<segment>-s<station>-<direction>", so the base id is the head.
    const sid = String(img.segment_id ?? String(img.capture_id).split("-s")[0]);
    row(sid).image_count += 1;
  }

  // Sorted so two runs over the same area produce byte-identical statements, which makes
  // a diff of what changed meaningful.
  return [...bySegment.values()].sort((a, b) => a.segment_id.localeCompare(b.segment_id));
}

// Imagery belongs to the street, not the run — a second model over the same area reuses
// the same JPEGs. So this upserts rather than appends, and keeps the max of what any pass
// has seen: a --limit run must never shrink the record of a full fetch that already ran.
export async function writeImagery(client, source, inventory) {
  if (inventory.length === 0) return 0;
  await client.query(`
    INSERT INTO parking.segment_imagery
      (segment_id, source, capture_count, covered_count, image_count, fetched_at)
    SELECT i.segment_id, $1, i.capture_count, i.covered_count, i.image_count, now()
    FROM unnest($2::text[], $3::int[], $4::int[], $5::int[])
         AS i(segment_id, capture_count, covered_count, image_count)
    ON CONFLICT (segment_id, source) DO UPDATE SET
      capture_count = GREATEST(parking.segment_imagery.capture_count, EXCLUDED.capture_count),
      covered_count = GREATEST(parking.segment_imagery.covered_count, EXCLUDED.covered_count),
      image_count   = GREATEST(parking.segment_imagery.image_count,   EXCLUDED.image_count),
      fetched_at = EXCLUDED.fetched_at, updated_at = now()
  `, [
    source,
    inventory.map((i) => i.segment_id),
    inventory.map((i) => i.capture_count),
    inventory.map((i) => i.covered_count),
    inventory.map((i) => i.image_count)
  ]);
  return inventory.length;
}

// What the inventory says about an area, for the log line after a fetch. The map turning
// green depends on "nothing left to fetch", so that is the number worth printing.
//
// no_streetview only means anything once the metadata preflight has run — see the guard in
// record-imagery.mjs, which refuses to write an inventory without it.
export function summariseImagery(inventory) {
  return {
    segments: inventory.length,
    with_images: inventory.filter((i) => i.image_count > 0).length,
    no_streetview: inventory.filter((i) => i.covered_count === 0).length,
    fetchable: inventory.filter((i) => i.covered_count > i.image_count).length
  };
}
