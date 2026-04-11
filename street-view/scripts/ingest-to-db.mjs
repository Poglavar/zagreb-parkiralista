// Ingests AI analysis results into parking.area as pending records. Connects directly to the database.
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
    databaseUrl: process.env.DATABASE_URL,
    provider: "openai",
    model: null,
    batchId: null,
    segmentSuffix: "",
    dryRun: true
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--analyses") args.analyses = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--provider") args.provider = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--batch-id") args.batchId = argv[++i];
    else if (argv[i] === "--segment-suffix") args.segmentSuffix = argv[++i];
    else if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/ingest-to-db.mjs --candidates path --analyses path [--write] [--provider openai] [--batch-id id]");
      console.log("");
      console.log("Reads AI analysis results and inserts parking polygons into parking.area.");
      console.log("Default is dry run. Pass --write to actually insert.");
      console.log("Requires DATABASE_URL in the environment.");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (!args.candidates || !args.analyses) {
    throw new Error("--candidates and --analyses are required. Run with --help for usage.");
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

        for (const ring of rings) {
          const geom = JSON.stringify({ type: "Polygon", coordinates: [ring] });
          const tags = {
            parking_manner: sideAssessment.parking_manner,
            parking_level: sideAssessment.parking_level,
            formality: sideAssessment.formality,
            label: segment.label,
            station_index: si,
            station_count: stationCount,
            decision: stationAssessment.decision,
            overall_notes: assessment.overall_notes
          };

          rows.push({
            segment_id: `${segmentId}${stationSuffix}${args.segmentSuffix}`,
            side,
            geom,
            tags: JSON.stringify(tags),
            confidence: sideAssessment.confidence,
            provider: args.provider,
            model: resolvedModel,
            batch_id: args.batchId,
            cost_usd: typeof result.cost_usd === "number" ? result.cost_usd : (result.cost_usd?.total || null)
          });
          insertCount += 1;
        }
      }
    }
  }

  console.log(`Prepared ${insertCount} polygon inserts from ${resultBySegment.size} analyzed segments (${skipCount} skipped)`);

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
        // Strip suffix to look up source segment data
        const sourceId = args.segmentSuffix ? segId.replace(new RegExp(`${args.segmentSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), "") : segId;
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

      let skippedReviewed = 0;
      for (const r of rows) {
        // Skip if this segment+side has already been reviewed (confirmed/suspect)
        const { rows: reviewCheck } = await client.query(`
          SELECT 1 FROM parking.area
          WHERE segment_id = $1 AND side = $2 AND current = true
            AND review_status IN ('confirmed', 'suspect')
          LIMIT 1
        `, [r.segment_id, r.side]);
        if (reviewCheck.length > 0) {
          skippedReviewed += 1;
          continue;
        }

        // Mark previous versions as not current
        await client.query(`
          UPDATE parking.area SET current = false, updated_at = now()
          WHERE segment_id = $1 AND side = $2 AND current = true
        `, [r.segment_id, r.side]);

        // Get next version
        const { rows: vRows } = await client.query(`
          SELECT COALESCE(MAX(version), 0) + 1 AS v FROM parking.area
          WHERE segment_id = $1 AND side = $2
        `, [r.segment_id, r.side]);

        await client.query(`
          INSERT INTO parking.area
            (segment_id, side, version, current, active, reviewed, review_status, geom, tags,
             confidence, provider, model, batch_id, cost_usd, updated_by)
          VALUES ($1, $2, $3, true, true, false, 'pending',
                  ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5,
                  $6, $7, $8, $9, $10, $11)
        `, [
          r.segment_id, r.side, vRows[0].v,
          r.geom, r.tags,
          r.confidence, r.provider, r.model, r.batch_id, r.cost_usd,
          `ai-pipeline-${r.provider}`
        ]);
      }

      await client.query("COMMIT");
      console.log(`Inserted ${rows.length - skippedReviewed} parking areas into parking.area (${skippedReviewed} skipped — already reviewed)`);
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
