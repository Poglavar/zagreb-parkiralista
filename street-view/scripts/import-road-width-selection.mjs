// This script imports a reusable hand-picked segment selection from zagreb-road-widths into Street View input GeoJSON.
import path from "path";
import { pathToFileURL } from "url";
import { readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    source: resolveFrom(import.meta.url, "../../../zagreb-road-widths/data/road-width-zagreb.json"),
    selection: resolveFrom(import.meta.url, "../data/tresnjevka-batch-selection.mjs"),
    out: resolveFrom(import.meta.url, "../data/selected-segments.geojson")
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--source") args.source = argv[++i];
    else if (argv[i] === "--selection") args.selection = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/import-road-width-selection.mjs [--selection path] [--source path] [--out path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function resolveSelectionPath(selectionPath) {
  if (path.isAbsolute(selectionPath)) {
    return selectionPath;
  }
  return path.resolve(process.cwd(), selectionPath);
}

async function loadSelection(selectionPath) {
  const modulePath = resolveSelectionPath(selectionPath);
  const imported = await import(pathToFileURL(modulePath).href);
  const items = imported.SEGMENT_SELECTION || imported.default;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`Selection file ${selectionPath} must export a non-empty SEGMENT_SELECTION array.`);
  }
  return items;
}

export function buildSelectedFeatures(sourceData, selectionItems) {
  const segmentById = new Map((sourceData.segmentLines || []).map((segment) => [String(segment.id), segment]));
  const duplicateIds = selectionItems
    .map((item) => String(item.segmentId))
    .filter((segmentId, index, ids) => ids.indexOf(segmentId) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate segment ids in selection: ${[...new Set(duplicateIds)].join(", ")}`);
  }

  const missing = selectionItems.filter((item) => !segmentById.has(String(item.segmentId)));
  if (missing.length > 0) {
    throw new Error(`Missing selected segment ids in source: ${missing.map((item) => item.segmentId).join(", ")}`);
  }

  return selectionItems.map((item) => {
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
}

export async function importRoadWidthSelection({ source, selection, out }) {
  const [sourceData, selectionItems] = await Promise.all([
    readJson(source),
    loadSelection(selection)
  ]);
  const features = buildSelectedFeatures(sourceData, selectionItems);

  await writeJson(out, {
    type: "FeatureCollection",
    metadata: {
      source,
      selection,
      generated_at: new Date().toISOString(),
      feature_count: features.length
    },
    features
  });

  console.log(`Wrote ${features.length} selected segments to ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await importRoadWidthSelection(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
