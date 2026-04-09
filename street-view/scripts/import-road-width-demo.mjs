// This script imports a few real trimmed road segments from zagreb-road-widths into this folder as demo input.
import { pathToFileURL } from "url";
import { DEMO_SEGMENTS } from "../data/demo-selection.mjs";
import { readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    source: resolveFrom(import.meta.url, "../../../zagreb-road-widths/data/road-width-zagreb.json"),
    out: resolveFrom(import.meta.url, "../data/demo-segments.geojson")
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--source") {
      args.source = argv[++i];
    } else if (argv[i] === "--out") {
      args.out = argv[++i];
    } else if (argv[i] === "--help") {
      console.log("Usage: node scripts/import-road-width-demo.mjs [--source path] [--out path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

export async function importRoadWidthDemo({ source, out }) {
  const data = await readJson(source);
  const segmentById = new Map((data.segmentLines || []).map((segment) => [String(segment.id), segment]));
  const missing = DEMO_SEGMENTS.filter((item) => !segmentById.has(String(item.segmentId)));
  if (missing.length > 0) {
    throw new Error(`Missing demo segment ids in source: ${missing.map((item) => item.segmentId).join(", ")}`);
  }

  const features = DEMO_SEGMENTS.map((item) => {
    const segment = segmentById.get(String(item.segmentId));
    return {
      type: "Feature",
      id: String(segment.id),
      geometry: {
        type: "LineString",
        coordinates: segment.c
      },
      properties: {
        segment_id: String(segment.id),
        label: item.label,
        notes: item.notes,
        width_m: Number(segment.w),
        length_m: Number(segment.len),
        width_bucket: segment.b,
        l1: segment.l1 || [],
        l2: segment.l2 || [],
        l3: segment.l3 || []
      }
    };
  });

  const outData = {
    type: "FeatureCollection",
    metadata: {
      source,
      generated_at: new Date().toISOString(),
      feature_count: features.length
    },
    features
  };

  await writeJson(out, outData);
  console.log(`Wrote ${features.length} demo segments to ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await importRoadWidthDemo(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
