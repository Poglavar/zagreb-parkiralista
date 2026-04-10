// This script assembles the static review bundle consumed by review.html from captures, analyses, and optional overrides.
import { readdir } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { buildReviewBundleCatalog, isReviewBundleFileName } from "./lib/review-bundle-catalog.mjs";
import { fileExists, readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    metadata: resolveFrom(import.meta.url, "../out/street-view-metadata.json"),
    images: resolveFrom(import.meta.url, "../out/street-view-images.json"),
    analyses: resolveFrom(import.meta.url, "../out/openai-analyses.json"),
    overrides: resolveFrom(import.meta.url, "../out/review-overrides.json"),
    out: resolveFrom(import.meta.url, "../out/review-bundle.json")
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--metadata") args.metadata = argv[++i];
    else if (argv[i] === "--images") args.images = argv[++i];
    else if (argv[i] === "--analyses") args.analyses = argv[++i];
    else if (argv[i] === "--overrides") args.overrides = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/build-review-bundle.mjs");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

export async function buildReviewBundle({ candidates, metadata, images, analyses, overrides, out }) {
  const candidateData = await readJson(candidates);
  const metadataData = (await fileExists(metadata)) ? await readJson(metadata) : { results: [] };
  const imageData = (await fileExists(images)) ? await readJson(images) : { images: [] };
  const analysisData = (await fileExists(analyses)) ? await readJson(analyses) : { results: [] };
  const overrideData = (await fileExists(overrides)) ? await readJson(overrides) : { overrides: {} };

  const metadataByCapture = new Map((metadataData.results || []).map((item) => [item.capture_id, item]));
  const imageByCapture = new Map((imageData.images || []).map((item) => [item.capture_id, item]));
  const analysisBySegment = new Map((analysisData.results || []).map((item) => [String(item.segment_id), item]));

  const segments = candidateData.segments.map((segment) => ({
    segment_id: segment.segment_id,
    label: segment.label,
    notes: segment.notes,
    width_m: segment.width_m,
    length_m: segment.length_m,
    width_bucket: segment.width_bucket,
    area_labels: segment.area_labels,
    turn_degrees: segment.turn_degrees,
    station_count: segment.station_count,
    geometry: segment.geometry,
    preview_polygons: segment.preview_polygons,
    captures: segment.captures.map((capture) => ({
      ...capture,
      metadata: metadataByCapture.get(capture.capture_id) || null,
      image: imageByCapture.get(capture.capture_id) || null
    })),
    ai_assessment: analysisBySegment.get(String(segment.segment_id)) || null,
    local_override: overrideData.overrides?.[String(segment.segment_id)] || null
  }));

  const payload = {
    generated_at: new Date().toISOString(),
    candidates,
    metadata: (await fileExists(metadata)) ? metadata : null,
    images: (await fileExists(images)) ? images : null,
    analyses: (await fileExists(analyses)) ? analyses : null,
    overrides: (await fileExists(overrides)) ? overrides : null,
    segment_count: segments.length,
    segments
  };

  await writeJson(out, payload);

  const outDir = path.dirname(out);
  const bundleFiles = (await readdir(outDir)).filter(isReviewBundleFileName);
  const bundles = buildReviewBundleCatalog(
    await Promise.all(
      bundleFiles.map(async (fileName) => ({
        fileName,
        payload: await readJson(path.join(outDir, fileName))
      }))
    )
  );
  const catalogPath = path.join(outDir, "review-bundle-catalog.json");
  await writeJson(catalogPath, {
    generated_at: new Date().toISOString(),
    latest_bundle_path: bundles[0]?.path || null,
    bundle_count: bundles.length,
    bundles
  });

  console.log(`Wrote review bundle to ${out}`);
  console.log(`Wrote review bundle catalog to ${catalogPath}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await buildReviewBundle(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
