// This script fetches paid Street View images only for captures whose metadata preflight succeeded.
import { writeFile, access, readdir } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { estimateGoogleStreetViewImageCost } from "./lib/billing.mjs";
import { ensureDir, readJson, resolveFrom, writeJson } from "./lib/io.mjs";
import { waitForRequestGap } from "./lib/rate-limit.mjs";
import { reportProgress } from "./lib/progress.mjs";

// Pull the area slug out of an out/<slug>/... path so the heartbeat can label the run.
function areaFromPath(p) {
  const m = /out\/([^/]+)\//.exec(p || "");
  return m ? m[1] : null;
}

// Every image already on disk anywhere under out/, keyed by capture_id.
//
// capture_id is "<segmentId>-s<station>-<direction>", which is globally unique across
// areas — so the same street fetched under a gradska-cetvrt run and again under a mjesni
// odbor run is the SAME photograph, and paying twice for it is pure waste. That is not
// hypothetical: the Gornji Grad - Medvescak run already holds 1,508 images covering a
// dozen MOs, and processing those MOs individually would re-buy every one of them.
//
// Street View Static is billed per request against a 10,000/month free cap, so this index
// is the difference between a month of MO-by-MO processing being free and not.
// Paths in the index are relative to the STREET-VIEW ROOT ("out/<area>/images/x.jpg"),
// matching what the normal fetch path writes. Every consumer resolves image_path against
// that root, so an index relative to out/ instead would silently produce paths nothing can
// open — and the failure mode is quiet: the analyzer just sees zero segments with imagery
// and reports a clean run over nothing.
async function indexExistingImages(svRoot) {
  const outRoot = path.join(svRoot, "out");
  const index = new Map();
  let dirs;
  try {
    dirs = await readdir(outRoot, { withFileTypes: true });
  } catch {
    return index;
  }

  const imageDirs = [path.join(outRoot, "images")];
  for (const e of dirs) {
    if (e.isDirectory()) imageDirs.push(path.join(outRoot, e.name, "images"));
  }

  for (const dir of imageDirs) {
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jpg")) continue;
      const captureId = f.slice(0, -4);
      // First one wins: any copy of the same capture_id is the same image, so there is
      // nothing to choose between them.
      if (!index.has(captureId)) {
        index.set(captureId, path.relative(svRoot, path.join(dir, f)).split(path.sep).join("/"));
      }
    }
  }
  return index;
}

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
  const area = areaFromPath(candidates);
  let imageIndex = 0;

  // Anything already on disk under out/ is free, so the billable count is what remains.
  const existing = await indexExistingImages(resolveFrom(import.meta.url, ".."));
  const reusable = payableItems.filter((item) => existing.has(item.capture_id)).length;
  const billingEstimate = estimateGoogleStreetViewImageCost(payableItems.length - reusable);
  let reusedCount = 0;

  // Manifest paths must be relative to the street-view root and follow the real
  // imageDir (out/<slug>/images for per-area runs), otherwise every consumer
  // resolves them against the default out/images and finds nothing.
  const manifestImageDir = path
    .relative(resolveFrom(import.meta.url, ".."), path.resolve(imageDir))
    .split(path.sep)
    .join("/");

  console.log(
    `Street View image fetch: ${payableItems.length} captures wanted, ${reusable} already on disk elsewhere under out/ (free), ` +
    `${payableItems.length - reusable} billable requests, ${delayMs}ms spacing, marginal cost $0.00 if free quota remains ` +
    `or about $${billingEstimate.estimated_cost_usd_if_first_paid_tier_applies.toFixed(3)} at the first paid tier.`
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
    imageIndex += 1;
    reportProgress("sv-images", { current: imageIndex, total: payableItems.length, message: `${capture.capture_id}.jpg`, area });
    const panoId = item.response.pano_id;
    const relativePath = `${manifestImageDir}/${capture.capture_id}.jpg`;
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
      // Not in this area's own directory — but it may already exist under another area.
    }

    // Point the manifest at the existing copy rather than buying it again. The file is
    // not moved or duplicated: every consumer resolves image_path against the street-view
    // root, so a path into another area's images/ works unchanged.
    const elsewhere = existing.get(capture.capture_id);
    if (elsewhere) {
      reusedCount += 1;
      manifest.push({
        capture_id: capture.capture_id,
        segment_id: item.segment_id,
        ok: true,
        image_path: elsewhere,
        pano_id: panoId,
        reused_from: elsewhere
      });
      continue;
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

  reportProgress("sv-images", { current: payableItems.length, total: payableItems.length, message: "done", area, done: true });

  const fetched = manifest.filter((m) => m.ok && !m.reused_from).length;
  await writeJson(out, {
    generated_at: new Date().toISOString(),
    candidates,
    metadata,
    throttle_delay_ms: delayMs,
    billing: { ...billingEstimate, reused_from_disk: reusedCount, newly_fetched: fetched },
    images: manifest
  });

  console.log(
    `Wrote image manifest to ${out} — ${fetched} newly fetched (billable), ` +
    `${reusedCount} reused from images already on disk (free).`
  );
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
