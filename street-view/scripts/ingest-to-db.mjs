// Ingests AI analysis results as observations under one run (parking.observation),
// plus the run's COVERAGE (parking.segment_coverage) and the imagery inventory
// (parking.segment_imagery). Connects directly to the database.
//
// Coverage is written for every segment the run touched, including the ones where the
// model found no parking and the ones whose call failed. Observations alone cannot say
// that: they only exist where parking_present was true, so "analysed, nothing here" and
// "never looked at" were indistinguishable, which is what made citywide progress
// impossible to see.
import pg from "pg";
import { pathToFileURL } from "url";
import { buildParkingSidePolygons } from "./lib/parking.mjs";
import { splitPolylineEqual } from "./lib/geo.mjs";
import { fileExists, readJson, resolveFrom } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    candidates: null,
    analyses: null,
    images: null,
    metadata: null,        // optional: lets covered_count distinguish "no pano here" from "not downloaded"
    imagerySource: "google_street_view",
    databaseUrl: process.env.DATABASE_URL,
    provider: "openai",
    model: null,
    runId: null,
    area: null,
    promptVersion: "v2",
    notes: null,
    segmentSuffix: "",
    dryRun: true
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--analyses") args.analyses = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--metadata") args.metadata = argv[++i];
    else if (argv[i] === "--imagery-source") args.imagerySource = argv[++i];
    else if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--provider") args.provider = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--run-id") args.runId = argv[++i];
    else if (argv[i] === "--area") args.area = argv[++i];
    else if (argv[i] === "--prompt-version") args.promptVersion = argv[++i];
    else if (argv[i] === "--notes") args.notes = argv[++i];
    else if (argv[i] === "--segment-suffix") args.segmentSuffix = argv[++i];
    else if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/ingest-to-db.mjs --candidates path --analyses path --run-id id --area name [--write]");
      console.log("");
      console.log("Appends AI analysis results as observations under one run (parking.observation).");
      console.log("Runs never overwrite each other, so the same area can be analysed by any number");
      console.log("of models. Human verdicts (parking.verdict) are never written here.");
      console.log("Also records what the run COVERED (parking.segment_coverage) including segments");
      console.log("where nothing was found, and the imagery inventory (parking.segment_imagery).");
      console.log("");
      console.log("  --images path           image manifest (street-view-images.json)");
      console.log("  --metadata path         metadata manifest; lets covered_count tell 'no pano here'");
      console.log("                          apart from 'not downloaded yet'");
      console.log("  --imagery-source NAME   google_street_view (default) | panoramax");
      console.log("");
      console.log("Default is dry run. Pass --write to actually insert.");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (!args.candidates || !args.analyses) {
    throw new Error("--candidates and --analyses are required. Run with --help for usage.");
  }
  if (!args.dryRun && !args.runId) {
    throw new Error("--run-id is required when writing. Each run is a distinct, permanent set of observations.");
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Source .env first.");
  }

  const candidateData = await readJson(args.candidates);
  const analysisData = await readJson(args.analyses);

  // Merge image paths into captures if images manifest provided
  const imageByCapture = new Map();
  if (args.images) {
    const imageData = await readJson(args.images);
    for (const img of imageData.images || []) {
      if (img.ok && img.image_path) {
        imageByCapture.set(img.capture_id, img);
      }
    }
    console.log(`Loaded ${imageByCapture.size} image paths from ${args.images}`);
  }

  // Attach image info to captures
  for (const seg of candidateData.segments) {
    for (const cap of seg.captures || []) {
      const img = imageByCapture.get(cap.capture_id);
      if (img) {
        cap.image = { image_path: img.image_path, pano_id: img.pano_id };
      }
    }
  }

  const segmentById = new Map(candidateData.segments.map((s) => [String(s.segment_id), s]));
  const resultBySegment = new Map(analysisData.results.filter((r) => r.ok).map((r) => [String(r.segment_id), r]));

  // Every segment this run touched, ok or not. Keyed by the BASE segment id (no -sN
  // station suffix): a station is what a polygon belongs to, a street is what coverage
  // belongs to. sides_with_parking is filled in as the polygon rows are built below.
  const coverageBySegment = new Map();
  for (const r of analysisData.results || []) {
    const sid = String(r.segment_id);
    coverageBySegment.set(sid, {
      segment_id: sid,
      outcome: r.ok ? "no_parking" : "failed",   // upgraded to 'parking' if any side lands
      station_count: r.ok ? (r.assessment?.stations?.length ?? 1) : null,
      sides_with_parking: 0,
      error: r.ok ? null : (r.error || "unknown error").slice(0, 500)
    });
  }

  // Imagery inventory per base segment. capture_count comes from the plan, covered_count
  // from the free metadata preflight, image_count from what is actually on disk — three
  // different facts that the status page must not conflate (a planned capture Google has
  // no pano for is a real gap in the city, not a stalled download).
  const imageryBySegment = new Map();
  const imagery = (sid) => {
    if (!imageryBySegment.has(sid)) {
      imageryBySegment.set(sid, { segment_id: sid, capture_count: 0, covered_count: 0, image_count: 0 });
    }
    return imageryBySegment.get(sid);
  };
  for (const seg of candidateData.segments) {
    imagery(String(seg.segment_id)).capture_count = (seg.captures || []).length;
  }
  for (const img of imageByCapture.values()) {
    // capture ids are "<segment>-s<station>-<direction>", so the base id is the head.
    const sid = String(img.segment_id ?? String(img.capture_id).split("-s")[0]);
    imagery(sid).image_count += 1;
  }
  if (args.metadata && await fileExists(args.metadata)) {
    const metaData = await readJson(args.metadata);
    for (const m of metaData.results || []) {
      if (m.ok && m.response?.status === "OK") imagery(String(m.segment_id)).covered_count += 1;
    }
  }

  const resolvedModel = args.model || analysisData.model || "unknown";
  let insertCount = 0;
  let skipCount = 0;
  const rows = [];

  for (const [segmentId, result] of resultBySegment) {
    const segment = segmentById.get(segmentId);
    if (!segment) {
      console.warn(`Segment ${segmentId} in analyses but not in candidates — skipping`);
      skipCount += 1;
      continue;
    }

    const assessment = result.assessment;
    if (!assessment) continue;

    // Support both per-station (new) and single-assessment (old) formats
    const stationAssessments = assessment.stations || [assessment];
    const stationCount = stationAssessments.length;
    const subSegments = stationCount > 1
      ? splitPolylineEqual(segment.geometry.coordinates, stationCount)
      : [segment.geometry.coordinates];

    for (let si = 0; si < stationAssessments.length; si += 1) {
      const stationAssessment = stationAssessments[si];
      const subCoords = subSegments[si] || segment.geometry.coordinates;
      const stationSuffix = stationCount > 1 ? `-s${si + 1}` : "";

      for (const [sideKey, side] of [["segment_left", "left"], ["segment_right", "right"]]) {
        const sideAssessment = stationAssessment[sideKey];
        if (!sideAssessment?.parking_present) continue;

        const rings = buildParkingSidePolygons(subCoords, {
          side,
          roadWidthM: segment.width_m,
          parkingLevel: sideAssessment.parking_level,
          parkingManner: sideAssessment.parking_manner,
          endSetbackM: 3
        });

        if (rings.length === 0) continue;

        // One row per (segment_id, side): a curved street yields several rings
        // (split at the bends) and they are all one parking area. Emitting a row
        // per ring made them collide on the (segment_id, side, version) key, so
        // each ring un-currented the one before it and only the last survived.
        const geom = JSON.stringify({
          type: "MultiPolygon",
          coordinates: rings.map((ring) => [ring])
        });
        const tags = {
          parking_manner: sideAssessment.parking_manner,
          parking_level: sideAssessment.parking_level,
          formality: sideAssessment.formality,
          label: segment.label,
          station_index: si,
          station_count: stationCount,
          part_count: rings.length,
          decision: stationAssessment.decision,
          overall_notes: assessment.overall_notes
        };

        rows.push({
          segment_id: `${segmentId}${stationSuffix}${args.segmentSuffix}`,
          side,
          geom,
          tags: JSON.stringify(tags),
          // The model's visual reasoning ("bollards along the kerb", "no-parking sign").
          // This is the part a human actually reads when reviewing, and it used to live
          // only in the analyses JSON on disk — i.e. one `rm` away from being lost.
          evidence: JSON.stringify(sideAssessment.evidence || []),
          manner: sideAssessment.parking_manner,
          level: sideAssessment.parking_level,
          formality: sideAssessment.formality,
          confidence: sideAssessment.confidence,
          provider: args.provider,
          model: resolvedModel,
          cost_usd: typeof result.cost_usd === "number" ? result.cost_usd : (result.cost_usd?.total || null)
        });
        insertCount += 1;

        // This segment produced at least one real polygon, so its coverage outcome is
        // 'parking' rather than the 'no_parking' it was initialised to.
        const cov = coverageBySegment.get(segmentId);
        if (cov) {
          cov.outcome = "parking";
          cov.sides_with_parking += 1;
        }
      }
    }
  }

  const coverage = [...coverageBySegment.values()];
  const covTally = coverage.reduce((acc, c) => { acc[c.outcome] = (acc[c.outcome] || 0) + 1; return acc; }, {});
  console.log(`Prepared ${insertCount} polygon inserts from ${resultBySegment.size} analyzed segments (${skipCount} skipped)`);
  console.log(`Coverage: ${coverage.length} segments — ${covTally.parking || 0} with parking, ${covTally.no_parking || 0} clean-but-empty, ${covTally.failed || 0} failed`);
  console.log(`Imagery: ${imageryBySegment.size} segments inventoried`);

  if (args.dryRun) {
    console.log("Dry run — no database writes. Pass --write to insert.");
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.segment_id}/${r.side} conf=${r.confidence} provider=${r.provider}`);
    }
    if (rows.length > 5) console.log(`  ... and ${rows.length - 5} more`);
    return;
  }

  const pool = new pg.Pool({ connectionString: args.databaseUrl });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Upsert source segments
      const segmentIds = [...new Set(rows.map((r) => r.segment_id))];
      for (const segId of segmentIds) {
        // Strip station suffix (-s1, -s2, ...) and any custom --segment-suffix
        // to look up the source segment in the candidates map (which is keyed
        // by the base segment_id, e.g. "10872" not "10872-s1").
        let sourceId = segId.replace(/-s\d+$/, "");
        if (args.segmentSuffix) sourceId = sourceId.replace(new RegExp(`${args.segmentSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), "");
        const seg = segmentById.get(sourceId) || segmentById.get(segId);
        if (!seg) continue;
        const captures = (seg.captures || []).map((c) => ({
          capture_id: c.capture_id,
          direction: c.direction,
          heading: c.heading,
          station_index: c.station_index,
          viewpoint: c.viewpoint,
          maps_url: c.maps_url,
          image_path: c.image?.image_path || null,
          pano_id: c.metadata?.response?.pano_id || c.image?.pano_id || null
        }));
        await client.query(`
          INSERT INTO parking.segment (segment_id, geom, width_m, length_m, area_labels, captures)
          VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3, $4, $5, $6)
          ON CONFLICT (segment_id) DO UPDATE SET
            geom = EXCLUDED.geom, width_m = EXCLUDED.width_m,
            length_m = EXCLUDED.length_m, area_labels = EXCLUDED.area_labels,
            captures = EXCLUDED.captures
        `, [
          segId,
          JSON.stringify(seg.geometry),
          seg.width_m,
          seg.length_m,
          (seg.area_labels || []).map((l) => l.replace(/^"|"$/g, "")).filter((l) => l !== l.toUpperCase() || l.length <= 1),
          JSON.stringify(captures)
        ]);
      }
      console.log(`Upserted ${segmentIds.length} segments into parking.segment`);

      // The run this ingest belongs to. Re-ingesting the same run_id overwrites only
      // that run's own observations; every other run is untouched.
      await client.query(`
        INSERT INTO parking.run (run_id, area, provider, model, engine, prompt_version, nominal_cost_usd, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (run_id) DO UPDATE SET
          area = EXCLUDED.area, provider = EXCLUDED.provider, model = EXCLUDED.model,
          engine = EXCLUDED.engine, prompt_version = EXCLUDED.prompt_version,
          nominal_cost_usd = EXCLUDED.nominal_cost_usd, updated_at = now()
      `, [
        args.runId, args.area, args.provider, resolvedModel,
        analysisData.engine || null, args.promptVersion,
        analysisData.billing?.total_nominal_cost_usd ?? null,
        args.notes
      ]);

      for (const r of rows) {
        // Append-only per run. No version juggling, no un-currenting, and — deliberately —
        // no write path to parking.verdict: a later, smarter model cannot overwrite a
        // decision a human already made about a physical space.
        await client.query(`
          INSERT INTO parking.observation
            (run_id, segment_id, side, osm_id, street_name, geom,
             parking_manner, parking_level, formality, confidence, evidence, tags, cost_usd)
          SELECT $1, $2, $3, s.osm_id, s.street_name,
                 -- UnaryUnion dissolves the rings where they overlap at a bend: they are one
                 -- continuous kerb strip, and overlapping parts would make the MultiPolygon invalid.
                 ST_Multi(ST_UnaryUnion(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))),
                 $5, $6, $7, $8, $9, $10, $11
          FROM (SELECT $2::text AS sid) k
          LEFT JOIN parking.segment s ON s.segment_id = k.sid
          ON CONFLICT (run_id, segment_id, side) DO UPDATE SET
            geom = EXCLUDED.geom, parking_manner = EXCLUDED.parking_manner,
            parking_level = EXCLUDED.parking_level, formality = EXCLUDED.formality,
            confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, tags = EXCLUDED.tags
        `, [
          args.runId, r.segment_id, r.side, r.geom,
          r.manner, r.level, r.formality, r.confidence, r.evidence, r.tags, r.cost_usd
        ]);
      }

      // Coverage: what this run actually looked at, empty results included. Bulk-inserted
      // via UNNEST because it is one row per segment, not per polygon, so it is the
      // largest set here. osm_id and street_name are resolved from the road table rather
      // than trusted from the candidates file, which on older areas has neither.
      if (coverage.length > 0) {
        await client.query(`
          INSERT INTO parking.segment_coverage
            (run_id, segment_id, osm_id, street_name, outcome, station_count, sides_with_parking, error)
          SELECT $1, c.segment_id, r.osm_id, r.street_name, c.outcome, c.station_count, c.sides, c.error
          FROM unnest($2::text[], $3::text[], $4::int[], $5::int[], $6::text[])
               AS c(segment_id, outcome, station_count, sides, error)
          LEFT JOIN public.road_width_segment r
            ON r.id::text = c.segment_id
          ON CONFLICT (run_id, segment_id) DO UPDATE SET
            outcome = EXCLUDED.outcome, station_count = EXCLUDED.station_count,
            sides_with_parking = EXCLUDED.sides_with_parking, error = EXCLUDED.error,
            osm_id = EXCLUDED.osm_id, street_name = EXCLUDED.street_name
        `, [
          args.runId,
          coverage.map((c) => c.segment_id),
          coverage.map((c) => c.outcome),
          coverage.map((c) => c.station_count),
          coverage.map((c) => c.sides_with_parking),
          coverage.map((c) => c.error)
        ]);
        console.log(`Recorded coverage for ${coverage.length} segments under run "${args.runId}"`);
      }

      // Imagery is a property of the street, not of the run — a second model over the
      // same area reuses the same JPEGs. So this upserts rather than appends, and takes
      // the max of what any ingest has seen (a --limit run must not shrink the record of
      // a full fetch that already happened).
      const inventory = [...imageryBySegment.values()];
      if (inventory.length > 0) {
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
          args.imagerySource,
          inventory.map((i) => i.segment_id),
          inventory.map((i) => i.capture_count),
          inventory.map((i) => i.covered_count),
          inventory.map((i) => i.image_count)
        ]);
        console.log(`Recorded imagery for ${inventory.length} segments (source: ${args.imagerySource})`);
      }

      await client.query(`
        UPDATE parking.run SET segment_count = (SELECT COUNT(*) FROM parking.observation WHERE run_id = $1)
        WHERE run_id = $1
      `, [args.runId]);

      await client.query("COMMIT");
      console.log(`Inserted ${rows.length} observations into run "${args.runId}" (append-only; other runs and all human verdicts untouched)`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
