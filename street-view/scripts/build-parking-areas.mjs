// This script turns AI or reviewed side decisions into approximate curbside parking polygons.
import { pathToFileURL } from "url";
import { buildParkingSidePolygon } from "./lib/parking.mjs";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    analyses: resolveFrom(import.meta.url, "../out/openai-analyses.json"),
    overrides: resolveFrom(import.meta.url, "../out/review-overrides.json"),
    out: resolveFrom(import.meta.url, "../out/parking-areas.geojson")
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--analyses") args.analyses = argv[++i];
    else if (argv[i] === "--overrides") args.overrides = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/build-parking-areas.mjs [--overrides path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function effectiveAssessment(segmentId, analysisMap, overrideMap) {
  const override = overrideMap.get(segmentId);
  if (override?.effective_assessment) {
    return {
      assessment: override.effective_assessment,
      review_status: override.review_status || "override",
      source: "human_review"
    };
  }

  const analysis = analysisMap.get(segmentId);
  if (analysis?.assessment) {
    return {
      assessment: analysis.assessment,
      review_status: override?.review_status || "unreviewed",
      source: "openai"
    };
  }

  return null;
}

export async function buildParkingAreas({ candidates, analyses, overrides, out }) {
  const candidateData = await readJson(candidates);
  const analysisData = await readJson(analyses);
  const analysisMap = new Map(
    (analysisData.results || [])
      .filter((item) => item.ok && item.assessment)
      .map((item) => [String(item.segment_id), item])
  );

  let overrideMap = new Map();
  if (await fileExists(overrides)) {
    const overrideData = await readJson(overrides);
    overrideMap = new Map(Object.entries(overrideData.overrides || {}));
  }

  const features = [];
  for (const segment of candidateData.segments) {
    const resolved = effectiveAssessment(String(segment.segment_id), analysisMap, overrideMap);
    if (!resolved) continue;

    for (const [assessmentKey, side] of [
      ["segment_left", "left"],
      ["segment_right", "right"]
    ]) {
      const sideAssessment = resolved.assessment[assessmentKey];
      if (!sideAssessment?.parking_present) continue;

      const ring = buildParkingSidePolygon(segment.geometry.coordinates, {
        side,
        roadWidthM: segment.width_m,
        parkingLevel: sideAssessment.parking_level
      });
      if (!ring) continue;

      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [ring]
        },
        properties: {
          segment_id: segment.segment_id,
          label: segment.label,
          side,
          decision: resolved.assessment.decision,
          parking_manner: sideAssessment.parking_manner,
          parking_level: sideAssessment.parking_level,
          formality: sideAssessment.formality,
          confidence: sideAssessment.confidence,
          notes: resolved.assessment.overall_notes,
          width_m: segment.width_m,
          length_m: segment.length_m,
          source: resolved.source,
          review_status: resolved.review_status
        }
      });
    }
  }

  await writeJson(out, {
    type: "FeatureCollection",
    metadata: {
      generated_at: new Date().toISOString(),
      candidates,
      analyses,
      overrides: await fileExists(overrides) ? overrides : null,
      feature_count: features.length
    },
    features
  });

  console.log(`Wrote ${features.length} parking polygons to ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await buildParkingAreas(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
