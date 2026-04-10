// Uploads reviewed parking polygons to OpenStreetMap via the v0.6 API.
// Reads a review bundle + exported overrides, filters to approved segments,
// and creates nodes + ways in a changeset.
import { pathToFileURL } from "url";
import { chooseParkingPolygonKeys } from "./lib/review-map.mjs";
import { activeParkingPolygons, buildChangesetXml, buildOsmChangePayload } from "./lib/osm-submit.mjs";
import { fileExists, readJson, resolveFrom } from "./lib/io.mjs";

const OSM_API = {
  prod: "https://api.openstreetmap.org/api/0.6",
  dev: "https://master.apis.dev.openstreetmap.org/api/0.6"
};

function parseArgs(argv) {
  const args = {
    bundle: resolveFrom(import.meta.url, "../out/review-bundle.json"),
    overrides: null,
    keyEnv: "OSM_OAUTH_TOKEN",
    api: "dev",
    dryRun: true,
    segmentId: null,
    changesetComment: "Add curbside parking areas from street-level imagery review in Zagreb"
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--bundle") args.bundle = argv[++i];
    else if (argv[i] === "--overrides") args.overrides = argv[++i];
    else if (argv[i] === "--key-env") args.keyEnv = argv[++i];
    else if (argv[i] === "--api") args.api = argv[++i];
    else if (argv[i] === "--upload") args.dryRun = false;
    else if (argv[i] === "--segment-id") args.segmentId = String(argv[++i]);
    else if (argv[i] === "--comment") args.changesetComment = argv[++i];
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/upload-to-osm.mjs [--bundle path] [--overrides path] [--upload] [--api dev|prod] [--segment-id id]");
      console.log("");
      console.log("Uploads reviewed parking polygons to OpenStreetMap.");
      console.log("");
      console.log("By default this is a dry run. Pass --upload to actually create data in OSM.");
      console.log("");
      console.log("Options:");
      console.log("  --bundle path       Review bundle JSON (default: out/review-bundle.json)");
      console.log("  --overrides path    Exported overrides JSON from the review UI");
      console.log("  --upload            Actually upload (without this, only shows what would happen)");
      console.log("  --api dev|prod      OSM API target (default: dev)");
      console.log("  --segment-id id     Upload only this segment");
      console.log("  --comment text      Changeset comment");
      console.log("  --key-env name      Env var for OAuth token (default: OSM_OAUTH_TOKEN)");
      console.log("");
      console.log("Authentication:");
      console.log("  1. Log in to openstreetmap.org (or the dev server)");
      console.log("  2. Go to Settings > OAuth 2 applications > Register new application");
      console.log("  3. Set redirect URI to: urn:ietf:wg:oauth:2.0:oob");
      console.log("  4. Request scope: write_api");
      console.log("  5. Authorize and copy the access token");
      console.log("  6. export OSM_OAUTH_TOKEN=your_token_here");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function effectivePolygonCoords(segment, assessment, overridePolygons, side) {
  if (overridePolygons?.[side]) {
    return overridePolygons[side];
  }
  const polygonKeys = chooseParkingPolygonKeys(assessment);
  const key = side === "left" ? polygonKeys.left : polygonKeys.right;
  return segment.preview_polygons?.[key] || null;
}

async function osmFetch(baseUrl, path, token, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    ...options.headers
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OSM API ${options.method || "GET"} ${path} returned ${response.status}: ${body}`);
  }
  return response;
}

export async function uploadToOsm({ bundle, overrides, keyEnv, api, dryRun, segmentId, changesetComment }) {
  const apiLabel = api === "prod" ? "PRODUCTION" : "dev";
  const baseUrl = OSM_API[api] || OSM_API.dev;

  // Load bundle
  if (!(await fileExists(bundle))) {
    throw new Error(`Bundle not found: ${bundle}`);
  }
  const bundleData = await readJson(bundle);

  // Load overrides
  let overrideData = {};
  if (overrides) {
    if (!(await fileExists(overrides))) {
      throw new Error(`Overrides file not found: ${overrides}`);
    }
    const raw = await readJson(overrides);
    overrideData = raw.overrides || raw;
  }

  // Find segments with reviewed/approved status
  const candidates = [];
  for (const segment of bundleData.segments) {
    if (segmentId && String(segment.segment_id) !== segmentId) {
      continue;
    }
    const override = overrideData[segment.segment_id];
    if (!override?.effective_assessment) {
      continue;
    }
    const status = override.review_status;
    if (status !== "agree" && status !== "confirmed" && status !== "override") {
      continue;
    }

    const assessment = override.effective_assessment;
    const overridePolygons = override.polygon_overrides || null;
    const coordsFn = (seg, assess, side) => effectivePolygonCoords(seg, assess, overridePolygons, side);
    const polygons = activeParkingPolygons(segment, assessment, coordsFn);

    if (polygons.length > 0) {
      candidates.push({ segment, assessment, polygons, reviewStatus: status });
    }
  }

  if (candidates.length === 0) {
    console.log("No reviewed segments with parking polygons found. Nothing to upload.");
    console.log("Review segments in the UI first (Accept AI or Save Override), then export overrides.");
    return;
  }

  // Summary
  const totalPolygons = candidates.reduce((sum, c) => sum + c.polygons.length, 0);
  console.log(`Target: ${apiLabel} (${baseUrl})`);
  console.log(`Found ${candidates.length} reviewed segments with ${totalPolygons} parking polygons:`);
  console.log("");
  for (const c of candidates) {
    const sides = c.polygons.map((p) => p.side).join(", ");
    console.log(`  segment ${c.segment.segment_id}: ${c.polygons.length} polygon(s) [${sides}] — ${c.reviewStatus}`);
  }
  console.log("");

  if (dryRun) {
    // Show the osmChange that would be uploaded
    const polygonGroups = candidates.map((c) => ({ segmentId: c.segment.segment_id, polygons: c.polygons }));
    const osmChange = buildOsmChangePayload("CHANGESET_ID", polygonGroups);
    console.log("--- Dry run: osmChange XML that would be uploaded ---");
    console.log(osmChange);
    console.log("");
    console.log("To actually upload, run again with --upload");
    return;
  }

  // Verify token
  const token = process.env[keyEnv];
  if (!token) {
    throw new Error(`Missing ${keyEnv} in the environment. Run with --help for setup instructions.`);
  }

  // Verify auth works
  console.log("Checking OSM API credentials...");
  const userResponse = await osmFetch(baseUrl.replace("/api/0.6", ""), "/api/0.6/user/details.json", token);
  const userDetails = await userResponse.json();
  const displayName = userDetails.user?.display_name || "unknown";
  console.log(`Authenticated as: ${displayName}`);
  console.log("");

  if (api === "prod") {
    console.log("*** UPLOADING TO PRODUCTION OSM ***");
  }

  // Step 1: create changeset
  console.log("Creating changeset...");
  const createResponse = await osmFetch(baseUrl, "/changeset/create", token, {
    method: "PUT",
    headers: { "Content-Type": "text/xml" },
    body: buildChangesetXml(changesetComment)
  });
  const changesetId = (await createResponse.text()).trim();
  console.log(`Changeset created: ${changesetId}`);

  // Step 2: upload the diff
  const polygonGroups = candidates.map((c) => ({ segmentId: c.segment.segment_id, polygons: c.polygons }));
  const osmChange = buildOsmChangePayload(changesetId, polygonGroups);
  console.log(`Uploading ${totalPolygons} polygons (${candidates.length} segments)...`);

  try {
    const uploadResponse = await osmFetch(baseUrl, `/changeset/${changesetId}/upload`, token, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: osmChange
    });
    const diffResult = await uploadResponse.text();
    console.log("Upload successful.");
    console.log("API response:", diffResult.slice(0, 500));
  } catch (error) {
    console.error("Upload failed:", error.message);
    console.log("Closing changeset without successful upload...");
    await osmFetch(baseUrl, `/changeset/${changesetId}/close`, token, { method: "PUT" }).catch(() => {});
    throw error;
  }

  // Step 3: close changeset
  await osmFetch(baseUrl, `/changeset/${changesetId}/close`, token, { method: "PUT" });
  console.log(`Changeset ${changesetId} closed.`);

  const changesetUrl = baseUrl.replace("/api/0.6", "") + `/changeset/${changesetId}`;
  console.log("");
  console.log(`Done. View at: ${changesetUrl}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await uploadToOsm(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
