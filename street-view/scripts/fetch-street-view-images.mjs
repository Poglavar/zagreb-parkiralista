// This script fetches paid Street View images only for captures whose metadata preflight succeeded.
import { writeFile, access } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { estimateGoogleStreetViewImageCost } from "./lib/billing.mjs";
import { ensureDir, readJson, resolveFrom, writeJson } from "./lib/io.mjs";
import { waitForRequestGap } from "./lib/rate-limit.mjs";

function parseArgs(argv) {
  const args = {
    candidates: resolveFrom(import.meta.url, "../out/candidates.json"),
    metadata: resolveFrom(import.meta.url, "../out/street-view-metadata.json"),
    out: resolveFrom(import.meta.url, "../out/street-view-images.json"),
    imageDir: resolveFrom(import.meta.url, "../out/images"),
    keyEnv: "GOOGLE_MAPS_API_KEY",
    delayMs: 1000,
    segmentId: null,
    captureId: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--metadata") args.metadata = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--image-dir") args.imageDir = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--capture-id") args.captureId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/fetch-street-view-images.mjs [--candidates path] [--metadata path] [--delay-ms 1000] [--segment-id id] [--capture-id id]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function buildImageUrl(capture, panoId, size, apiKey) {
  const params = new URLSearchParams({
    size,
    pano: panoId,
    heading: capture.heading.toFixed(1),
    pitch: String(capture.pitch),
    fov: String(capture.fov),
    source: "outdoor",
    return_error_code: "true",
    key: apiKey
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

export async function fetchStreetViewImages({ candidates, metadata, out, imageDir, keyEnv, delayMs, segmentId, captureId }) {
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${keyEnv} in the environment.`);
  }

  const candidateData = await readJson(candidates);
  const metadataData = await readJson(metadata);
  const captureMap = new Map();
  for (const segment of candidateData.segments) {
    for (const capture of segment.captures) {
      captureMap.set(capture.capture_id, capture);
    }
  }

  await ensureDir(imageDir);
  const manifest = [];
  const size = candidateData.capture_settings.size;
  const payableItems = metadataData.results.filter((item) => {
    if (segmentId && String(item.segment_id) !== String(segmentId)) {
      return false;
    }
    if (captureId && item.capture_id !== captureId) {
      return false;
    }
    return item.ok;
  });
  const billingEstimate = estimateGoogleStreetViewImageCost(payableItems.length);

  console.log(
    `Street View image fetch: ${payableItems.length} billable image requests, ${delayMs}ms spacing, marginal cost $0.00 if free quota remains or about $${billingEstimate.estimated_cost_usd_if_first_paid_tier_applies.toFixed(3)} at the first paid tier.`
  );

  for (const [index, item] of metadataData.results.entries()) {
    if (segmentId && String(item.segment_id) !== String(segmentId)) {
      continue;
    }
    if (captureId && item.capture_id !== captureId) {
      continue;
    }
    const capture = captureMap.get(item.capture_id);
    if (!capture || !item.ok) {
      continue;
    }
    const panoId = item.response.pano_id;
    const relativePath = `out/images/${capture.capture_id}.jpg`;
    const absolutePath = path.resolve(imageDir, `${capture.capture_id}.jpg`);

    // Skip if already downloaded (resume support)
    try {
      await access(absolutePath);
      manifest.push({
        capture_id: capture.capture_id,
        segment_id: item.segment_id,
        ok: true,
        image_path: relativePath,
        pano_id: panoId
      });
      continue;
    } catch {
      // File does not exist — fetch it
    }

    await waitForRequestGap(delayMs, manifest.length);
    try {
      const url = buildImageUrl(capture, panoId, size, apiKey);
      const response = await fetch(url);
      if (!response.ok) {
        manifest.push({
          capture_id: capture.capture_id,
          segment_id: item.segment_id,
          ok: false,
          error: `HTTP ${response.status}`
        });
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      await writeFile(absolutePath, new Uint8Array(arrayBuffer));
      manifest.push({
        capture_id: capture.capture_id,
        segment_id: item.segment_id,
        ok: true,
        image_path: relativePath,
        pano_id: panoId
      });
      console.log(`Saved ${relativePath}`);
    } catch (err) {
      console.error(`Failed ${capture.capture_id}: ${err.message}`);
      manifest.push({
        capture_id: capture.capture_id,
        segment_id: item.segment_id,
        ok: false,
        error: err.message
      });
    }
  }

  await writeJson(out, {
    generated_at: new Date().toISOString(),
    candidates,
    metadata,
    throttle_delay_ms: delayMs,
    billing: billingEstimate,
    images: manifest
  });

  console.log(`Wrote image manifest to ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await fetchStreetViewImages(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
