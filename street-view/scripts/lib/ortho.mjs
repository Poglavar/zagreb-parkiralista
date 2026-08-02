// Fetches an orthophoto crop centred on a road segment, with the segment itself drawn on
// it, for use as an extra input to the parking classifier.
//
// WHY DRAW ON IT. A bare aerial crop is ambiguous: several streets are usually in frame and
// nothing says which one is the subject, so the model answers about whichever is most
// visually salient. Rendering the segment's centreline, its direction of travel, and which
// side is "left" and which is "right" turns the image from scenery into a question about a
// specific kerb. This is the composite-overlay pattern that made the aerial LLM work at all.
//
// WHY IT MIGHT HELP AT ALL. parking_manner (parallel / perpendicular / diagonal) is the most
// consequential field in the schema — it sets how deep a strip of ground is recorded, so
// calling perpendicular parking "parallel" discards more than half the real area. From the
// ground that is an inference; from above it is simply visible. Whether that outweighs the
// extra tokens and the age mismatch with Street View is an empirical question, which is what
// the benchmark exists to answer.
//
// SOURCES. CDOF2022 is the City of Zagreb's own orthophoto at 0.15 m native GSD and is the
// default because at these crop sizes it resolves individual cars. DOF5 is the national DGU
// product at 0.50 m — coarser, but it covers the whole country, so it is the fallback for
// anything outside the city layer's extent.
import proj4 from "proj4";
import sharp from "sharp";

// HTRS96/TM — the native projected CRS of both services, so no server-side reprojection.
proj4.defs("EPSG:3765",
  "+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
const toMetric = proj4("EPSG:4326", "EPSG:3765");

export const ORTHO_SOURCES = {
  cdof2022: {
    url: "https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer",
    layer: "ZG_CDOF2022",
    gsd: 0.15,
    label: "Grad Zagreb CDOF 2022"
  },
  dof5: {
    url: "https://geoportal.dgu.hr/services/inspire/orthophoto_2023_2024/wms",
    layer: "OI.OrthoimageCoverage",
    gsd: 0.5,
    label: "DGU DOF5 2023/2024"
  }
};

const USER_AGENT = "zagreb-parkiralista/0.1 (City of Zagreb)";

// Default render size. Exported so a cached crop's scale can be recomputed without
// re-fetching — the prompt quotes metres-per-pixel to the model, so it has to be right.
export const ORTHO_RENDER_SIZE = 768;

// Padding around the segment. A minimum extent stops a 10 m stub from being blown up to a
// meaningless close-up of two kerbstones; the proportional term keeps context on long ones.
const MIN_EXTENT_M = 70;
const PAD_FRACTION = 0.22;
const MIN_PAD_M = 18;

export function segmentBbox3765(coords, { minExtentM = MIN_EXTENT_M } = {}) {
  const pts = coords.map(([lon, lat]) => toMetric.forward([lon, lat]));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);

  const pad = Math.max(MIN_PAD_M, PAD_FRACTION * Math.max(maxX - minX, maxY - minY));
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;

  // Square it off, so image pixels are square in ground units and the model is not
  // reasoning about a stretched world.
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY, minExtentM);
  return {
    minX: cx - extent / 2, minY: cy - extent / 2,
    maxX: cx + extent / 2, maxY: cy + extent / 2,
    extentM: extent,
    points: pts
  };
}

async function fetchWms(source, bbox, size) {
  const src = ORTHO_SOURCES[source];
  if (!src) throw new Error(`Unknown ortho source: ${source}`);
  const params = new URLSearchParams({
    service: "WMS", request: "GetMap", version: "1.3.0",
    layers: src.layer, styles: "",
    crs: "EPSG:3765",
    bbox: `${bbox.minX.toFixed(2)},${bbox.minY.toFixed(2)},${bbox.maxX.toFixed(2)},${bbox.maxY.toFixed(2)}`,
    width: String(size), height: String(size),
    format: "image/png"
  });
  const resp = await fetch(`${src.url}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`WMS ${source} HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const type = resp.headers.get("content-type") || "";
  // A WMS reports errors as a 200 with an XML body, so the status alone proves nothing.
  if (!type.includes("image")) {
    throw new Error(`WMS ${source} returned ${type}: ${buf.toString("utf8").slice(0, 200)}`);
  }
  return buf;
}

// Build the SVG drawn over the crop. Coordinates are converted from EPSG:3765 metres to
// image pixels; y is flipped because image rows run downward while northings run upward.
function buildOverlay(bbox, size, { label } = {}) {
  const toPx = ([x, y]) => [
    ((x - bbox.minX) / (bbox.maxX - bbox.minX)) * size,
    size - ((y - bbox.minY) / (bbox.maxY - bbox.minY)) * size
  ];
  const px = bbox.points.map(toPx);
  const path = px.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Side markers at the midpoint, offset perpendicular to the local direction. "left" and
  // "right" are relative to travelling along the polyline in its stored direction, which is
  // the same convention segment_left / segment_right use in the schema — the whole point is
  // that the model can map them without inferring anything.
  const mid = Math.floor(px.length / 2);
  const a = px[Math.max(0, mid - 1)];
  const b = px[Math.min(px.length - 1, mid)];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const [ux, uy] = [dx / len, dy / len];
  // Screen y is flipped, so the left-hand normal in world terms is (uy, -ux) here.
  const off = Math.max(22, size * 0.055);
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const leftPt = [mx + uy * off, my - ux * off];
  const rightPt = [mx - uy * off, my + ux * off];

  // Arrowhead at the far end showing direction of travel.
  const last = px[px.length - 1];
  const prev = px[px.length - 2] || px[0];
  const adx = last[0] - prev[0], ady = last[1] - prev[1];
  const alen = Math.hypot(adx, ady) || 1;
  const [ax, ay] = [adx / alen, ady / alen];
  const head = 14;
  const arrow = [
    `${last[0]},${last[1]}`,
    `${last[0] - ax * head - ay * head * 0.5},${last[1] - ay * head + ax * head * 0.5}`,
    `${last[0] - ax * head + ay * head * 0.5},${last[1] - ay * head - ax * head * 0.5}`
  ].join(" ");

  const scaleBarM = bbox.extentM >= 200 ? 50 : 20;
  const scaleBarPx = (scaleBarM / bbox.extentM) * size;

  return Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <path d="${path}" stroke="#000000" stroke-width="7" fill="none" stroke-opacity="0.55"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${path}" stroke="#00e5ff" stroke-width="3" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>
  <polygon points="${arrow}" fill="#00e5ff" stroke="#000000" stroke-width="1"/>
  <g font-family="sans-serif" font-size="${Math.round(size * 0.045)}" font-weight="bold">
    <text x="${leftPt[0].toFixed(0)}" y="${leftPt[1].toFixed(0)}" fill="#000" stroke="#000"
          stroke-width="4" text-anchor="middle" dominant-baseline="middle">L</text>
    <text x="${leftPt[0].toFixed(0)}" y="${leftPt[1].toFixed(0)}" fill="#ffd400"
          text-anchor="middle" dominant-baseline="middle">L</text>
    <text x="${rightPt[0].toFixed(0)}" y="${rightPt[1].toFixed(0)}" fill="#000" stroke="#000"
          stroke-width="4" text-anchor="middle" dominant-baseline="middle">D</text>
    <text x="${rightPt[0].toFixed(0)}" y="${rightPt[1].toFixed(0)}" fill="#ffd400"
          text-anchor="middle" dominant-baseline="middle">D</text>
  </g>
  <g>
    <rect x="10" y="${size - 26}" width="${scaleBarPx.toFixed(1)}" height="6" fill="#fff" stroke="#000" stroke-width="1"/>
    <text x="10" y="${size - 32}" font-family="sans-serif" font-size="13" fill="#fff"
          stroke="#000" stroke-width="3" paint-order="stroke">${scaleBarM} m</text>
    <text x="10" y="${size - 32}" font-family="sans-serif" font-size="13" fill="#fff">${scaleBarM} m</text>
  </g>
  ${label ? `<text x="10" y="22" font-family="sans-serif" font-size="14" fill="#fff" stroke="#000"
        stroke-width="3" paint-order="stroke">${escapeXml(label)}</text>
  <text x="10" y="22" font-family="sans-serif" font-size="14" fill="#fff">${escapeXml(label)}</text>` : ""}
</svg>`);
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

// One annotated orthophoto crop for a segment. Returns a JPEG buffer plus the metadata the
// prompt needs to describe what the model is looking at.
export async function renderSegmentOrtho(segment, {
  source = "cdof2022", size = ORTHO_RENDER_SIZE, fallbackSource = "dof5"
} = {}) {
  const coords = segment.geometry?.coordinates || segment.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error(`segment ${segment.segment_id} has no usable geometry`);
  }
  const bbox = segmentBbox3765(coords);

  let used = source;
  let base;
  try {
    base = await fetchWms(source, bbox, size);
  } catch (err) {
    if (!fallbackSource || fallbackSource === source) throw err;
    // The city layer stops at the city boundary; the national one does not.
    used = fallbackSource;
    base = await fetchWms(fallbackSource, bbox, size);
  }

  const overlay = buildOverlay(bbox, size, { label: segment.street_name || `segment ${segment.segment_id}` });
  const jpeg = await sharp(base)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 82 })
    .toBuffer();

  return {
    buffer: jpeg,
    source: used,
    label: ORTHO_SOURCES[used].label,
    extentM: bbox.extentM,
    metresPerPixel: bbox.extentM / size
  };
}
