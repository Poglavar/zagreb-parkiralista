// This script preflights Street View captures through the free metadata endpoint before any paid image requests.
import { pathToFileURL } from "url";
import { waitForRequestGap } from "./lib/rate-limit.mjs";
import { readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    input: resolveFrom(import.meta.url, "../out/candidates.json"),
    out: resolveFrom(import.meta.url, "../out/street-view-metadata.json"),
    keyEnv: "GOOGLE_MAPS_API_KEY",
    delayMs: 1000,
    segmentId: null,
    captureId: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--capture-id") args.captureId = String(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/fetch-street-view-metadata.mjs [--input path] [--out path] [--delay-ms 1000] [--segment-id id] [--capture-id id]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function buildMetadataUrl(capture, apiKey) {
  const params = new URLSearchParams({
    location: `${capture.viewpoint.lat.toFixed(6)},${capture.viewpoint.lon.toFixed(6)}`,
    heading: capture.heading.toFixed(1),
    pitch: String(capture.pitch),
    fov: String(capture.fov),
    source: "outdoor",
    key: apiKey
  });
  return `https://maps.googleapis.com/maps/api/streetview/metadata?${params.toString()}`;
}

export async function fetchStreetViewMetadata({ input, out, keyEnv, delayMs, segmentId, captureId }) {
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${keyEnv} in the environment.`);
  }

  const candidates = await readJson(input);
  const captures = candidates.segments.flatMap((segment) => {
    if (segmentId && String(segment.segment_id) !== String(segmentId)) {
      return [];
    }
    return segment.captures
      .filter((capture) => !captureId || capture.capture_id === captureId)
      .map((capture) => ({ segment_id: segment.segment_id, capture }));
  });

  console.log(
    `Street View metadata preflight: ${captures.length} capture requests, ${delayMs}ms spacing, expected Google cost $0.00 because metadata is documented as free.`
  );

  const results = [];
  for (const [index, item] of captures.entries()) {
    await waitForRequestGap(delayMs, index);
    const url = buildMetadataUrl(item.capture, apiKey);
    const response = await fetch(url);
    const payload = await response.json();
    results.push({
      segment_id: item.segment_id,
      capture_id: item.capture.capture_id,
      request_url: url.replace(apiKey, "REDACTED"),
      ok: response.ok && payload.status === "OK",
      response: payload
    });
    console.log(`${item.capture.capture_id}: ${payload.status}`);
  }

  await writeJson(out, {
    generated_at: new Date().toISOString(),
    input,
    throttle_delay_ms: delayMs,
    billing: {
      pricing_source_note: "Google documents Street View metadata requests as free.",
      estimated_cost_usd: 0
    },
    capture_count: captures.length,
    results
  });

  console.log(`Wrote metadata results to ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await fetchStreetViewMetadata(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
