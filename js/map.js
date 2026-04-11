// Leaflet preglednik za zagreb-parkiralista. Učitava OSM parking iz
// data/osm/parking_zagreb.geojson, dijeli ih na otvorena (poligoni vidljivi iz
// zraka) i zatvorena (uglavnom node-only podzemne i etažne garaže), prikazuje
// ih različitim stilom, dohvaća granice administrativnih razina iz dijeljenog
// zagreb-api i agregira parking statistiku po području koristeći turf.js.

const ZAGREB_CENTER = [45.815, 15.98];
const DEFAULT_ZOOM = 13;

// API_BASE pattern from zagreb-buildings: ?apiBase=… override, then localStorage,
// then production proxy detection, then localhost:3001 fallback for dev.
const API_BASE = (() => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("apiBase") || window.localStorage.getItem("zagrebApiBase");
  if (explicit) return explicit.replace(/\/$/, "");
  if (window.location.pathname.startsWith("/parkirališta") ||
      window.location.pathname.startsWith("/parkiralista")) {
    return window.location.origin + window.location.pathname.replace(/\/$/, "");
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostname = window.location.hostname || "localhost";
  return `${protocol}//${hostname}:3001`;
})();

const ADMIN_LEVEL_LABELS = {
  1: "Gradske četvrti",
  2: "Naselja",
  3: "Mjesni odbori",
};

// Layer state populated as data loads / user toggles things.
const layers = {
  osmOpen: null,
  osmEnclosed: null,
  ml: null,
  informal: null,
  llmAnthropic: null,    // Phase 5 LLM proposals from Claude
  llmOpenai: null,       // Phase 5 LLM proposals from GPT
  admin: null,           // Leaflet GeoJSON layer for current admin level
  adminHighlight: null,  // single-feature highlight layer for the selected row
};

// In-memory caches keyed by URL so re-selecting an admin level is instant.
const bordersCache = new Map();

// Source-of-truth slices used for aggregation. Populated by loadOsmLayer() and loadStreetViewLayer().
let osmFeatureCollection = null;
// Per-feature aggregation handles. Each entry:
//   { lon, lat, kind, source, capacity, area_m2 }
let osmHandles = null;
let streetViewHandles = [];
let currentAggregation = null;
let currentSortKey = "capacity";
let selectedAdminName = null;

// Car footprints for capacity estimation (m² per spot)
const CAR_FOOTPRINT = { parallel: 13.75, perpendicular: 6.88, diagonal: 9.73, mixed: 10, unknown: 13.75 };

// ───────── Utility / formatting ─────────

function capacityColor(capacity) {
  if (capacity == null || isNaN(capacity)) return "#999999";
  if (capacity < 20) return "#cfe2ff";
  if (capacity < 50) return "#93c5fd";
  if (capacity < 100) return "#3b82f6";
  if (capacity < 250) return "#1d4ed8";
  return "#1e3a8a";
}

function osmOpenStyle(feature) {
  return {
    color: "#1e3a8a",
    weight: 1,
    fillColor: capacityColor(feature?.properties?.capacity),
    fillOpacity: 0.55,
  };
}

function osmEnclosedPolygonStyle(feature) {
  // Multi-storey garages mapped as ways: distinct purple stroke + lighter fill
  // so they don't blend with open-air surface lots.
  return {
    color: "#581c87",
    weight: 1.5,
    fillColor: "#7c3aed",
    fillOpacity: 0.35,
    dashArray: "3,3",
  };
}

function adminBaseStyle() {
  return {
    color: "#0f172a",
    weight: 1.5,
    opacity: 0.6,
    fillColor: "#0f172a",
    fillOpacity: 0.04,
    interactive: false,
  };
}

function adminHighlightStyle() {
  return {
    color: "#dc2626",
    weight: 3,
    opacity: 0.95,
    fillColor: "#dc2626",
    fillOpacity: 0.12,
    interactive: false,
  };
}

const NUM_FMT = new Intl.NumberFormat("hr-HR");
const NUM_FMT_DEC = new Intl.NumberFormat("hr-HR", { maximumFractionDigits: 2 });

function formatNumber(n) {
  if (n == null || !isFinite(n)) return "—";
  return NUM_FMT.format(Math.round(n));
}

function formatArea(m2) {
  if (m2 == null || !isFinite(m2)) return "—";
  if (m2 >= 10000) return `${NUM_FMT_DEC.format(m2 / 10000)} ha`;
  return `${formatNumber(m2)} m²`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ───────── Marker icon for enclosed (point) parking ─────────

// Custom div-icon "P" pin used for OSM nodes (mostly underground / multi-storey
// garages). Sized down for non-named small parkings to keep the city skyline
// from drowning under big icons.
function buildParkingPinIcon(small) {
  const cls = small ? "parking-pin-inner parking-pin-small" : "parking-pin-inner";
  return L.divIcon({
    className: "parking-pin",
    html: `<div class="${cls}">P</div>`,
    iconSize: small ? [18, 18] : [24, 24],
    iconAnchor: small ? [9, 9] : [12, 12],
    popupAnchor: [0, small ? -10 : -14],
  });
}

const PARKING_PIN_LARGE = buildParkingPinIcon(false);
const PARKING_PIN_SMALL = buildParkingPinIcon(true);

// ───────── Popup HTML ─────────

function buildPopupHtml(feature) {
  const p = feature.properties || {};
  const name = p.name || "(parkiralište bez imena)";
  const capSourceLabel = {
    osm: "tagirano u OSM-u",
    area_estimate: "procjena iz površine",
    stall_detection: "detekcija mjesta",
  }[p.capacity_source] || (p.capacity_source ?? "—");
  const kindLabel = p.parking_kind === "enclosed" ? "zatvoreno (garaža)" : "otvoreno";
  const osmUrl = p.osm_type && p.osm_id
    ? `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`
    : null;

  const parkingValue = p.parking || (p.parking_kind === "enclosed" ? "garage" : "surface");

  return `
    <strong>${escapeHtml(name)}</strong>
    <table class="popup-table">
      <tr><th>Vrsta</th><td>${escapeHtml(kindLabel)} · ${escapeHtml(parkingValue)}</td></tr>
      ${p.area_m2 != null ? `<tr><th>Površina</th><td>${formatArea(p.area_m2)}</td></tr>` : ""}
      <tr><th>Kapacitet</th><td>${formatNumber(p.capacity)}</td></tr>
      <tr><th>Izvor</th><td>${capSourceLabel}</td></tr>
      ${p.fee ? `<tr><th>Naplata</th><td>${escapeHtml(p.fee)}</td></tr>` : ""}
      ${p.operator ? `<tr><th>Operater</th><td>${escapeHtml(p.operator)}</td></tr>` : ""}
      ${osmUrl ? `<tr><th>OSM</th><td><a href="${osmUrl}" target="_blank" rel="noopener">${p.osm_type}/${p.osm_id}</a></td></tr>` : ""}
    </table>
  `;
}

// ───────── OSM parking — split into two layers ─────────

function buildOsmHandles(fc) {
  // One handle per feature, regardless of geometry type. Polygons contribute
  // their centroid; nodes contribute their own coords. The shape is uniform so
  // aggregateByAdmin() doesn't need to special-case anything.
  const out = [];
  fc.features.forEach((feature, i) => {
    const props = feature.properties || {};
    const kind = props.parking_kind === "enclosed" ? "enclosed" : "open_air";
    let lon, lat;
    if (feature.geometry?.type === "Point") {
      [lon, lat] = feature.geometry.coordinates;
    } else {
      try {
        const c = turf.centroid(feature);
        [lon, lat] = c.geometry.coordinates;
      } catch (err) {
        return;  // skip degenerate
      }
    }
    out.push({
      lon,
      lat,
      kind,
      source: "osm",
      capacity: Number(props.capacity) || 0,
      area_m2: Number(props.area_m2) || 0,
      featureIndex: i,
    });
  });
  return out;
}

function updateHeadline(metadata) {
  const totalSpots = metadata?.total_estimated_capacity ?? 0;
  const openSpots = metadata?.capacity_open_air ?? 0;
  const enclosedSpots = metadata?.capacity_enclosed ?? 0;
  const totalLots = metadata?.feature_count ?? 0;
  const openLots = metadata?.feature_count_open_air ?? 0;
  const enclosedLots = metadata?.feature_count_enclosed ?? 0;
  const totalAreaKm2 = (metadata?.total_polygon_area_m2 ?? 0) / 1e6;

  document.getElementById("hs-spots").textContent = formatNumber(totalSpots);
  document.getElementById("hs-spots-sub").textContent =
    `${formatNumber(openSpots)} otv. · ${formatNumber(enclosedSpots)} zatv.`;
  document.getElementById("hs-lots").textContent = formatNumber(totalLots);
  document.getElementById("hs-lots-sub").textContent =
    `${formatNumber(openLots)} otv. · ${formatNumber(enclosedLots)} zatv.`;
  document.getElementById("hs-area").textContent = NUM_FMT_DEC.format(totalAreaKm2);
}

// Build a single Leaflet layer for one parking_kind. Handles polygons and points
// with the right rendering for each.
function buildOsmKindLayer(features, kind) {
  return L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: (feature) => {
        if (feature.geometry?.type === "Point") return null;  // unused for points
        return kind === "enclosed" ? osmEnclosedPolygonStyle(feature) : osmOpenStyle(feature);
      },
      pointToLayer: (feature, latlng) => {
        // Use the larger pin if the lot is named (likely a real garage); smaller
        // for unnamed point features so the map doesn't get buried.
        const named = !!feature.properties?.name;
        return L.marker(latlng, { icon: named ? PARKING_PIN_LARGE : PARKING_PIN_SMALL });
      },
      onEachFeature: (feature, lyr) => {
        lyr.bindPopup(buildPopupHtml(feature), { maxWidth: 320 });
      },
    }
  );
}

async function loadOsmLayer(map) {
  try {
    const res = await fetch("data/osm/parking_zagreb.geojson", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    osmFeatureCollection = await res.json();

    const openFeatures = osmFeatureCollection.features.filter(
      (f) => f.properties?.parking_kind !== "enclosed"
    );
    const enclosedFeatures = osmFeatureCollection.features.filter(
      (f) => f.properties?.parking_kind === "enclosed"
    );

    layers.osmOpen = buildOsmKindLayer(openFeatures, "open_air").addTo(map);
    layers.osmEnclosed = buildOsmKindLayer(enclosedFeatures, "enclosed").addTo(map);

    osmHandles = buildOsmHandles(osmFeatureCollection);
    document.getElementById("count-osm-open").textContent = formatNumber(openFeatures.length);
    document.getElementById("count-osm-enclosed").textContent = formatNumber(enclosedFeatures.length);
    updateHeadline(osmFeatureCollection.metadata);
  } catch (err) {
    console.error("Failed to load OSM parking layer:", err);
    document.getElementById("hs-spots").textContent = "—";
    document.getElementById("hs-lots").textContent = "err";
    document.getElementById("hs-area").textContent = "—";
    document.getElementById("admin-status").textContent =
      "Greška pri učitavanju OSM sloja — pokreni 00_fetch_osm.py";
  }
}

// ───────── Phase 3 informal parking layer ─────────

// Color scheme for the informal_type field. Buckets are coarsened from the
// fine-grained landuse kinds the classifier emits (see 21_fetch_landuse.py).
// Green = parking on a green space. Red = parking on civic / school land.
// Purple = courtyard. Gray = on the road / unknown / roadside.
function informalColor(informalType) {
  switch (informalType) {
    case "park_or_playground":
    case "green_space":
    case "wood":
    case "farmland":
      return { fill: "#16a34a", stroke: "#14532d" };  // green
    case "school_grounds":
      return { fill: "#f97316", stroke: "#7c2d12" };  // orange
    case "hospital_grounds":
    case "civic_grounds":
    case "square":
      return { fill: "#dc2626", stroke: "#7f1d1d" };  // red
    case "residential_block":
      return { fill: "#a855f7", stroke: "#581c87" };  // purple (courtyard)
    case "industrial_yard":
    case "commercial_area":
      return { fill: "#0ea5e9", stroke: "#0c4a6e" };  // blue
    case "construction_site":
      return { fill: "#facc15", stroke: "#713f12" };  // yellow
    case "water":
      return { fill: "#06b6d4", stroke: "#164e63" };  // cyan (almost certainly classifier error)
    case "roadside_or_unknown":
    case "unknown":
    default:
      return { fill: "#6b7280", stroke: "#1f2937" };  // gray
  }
}

// Composites generated by 30_render_composite.py — stitched aerial + OSM roads +
// existing parking + YOLO dots + legend. Same images the LLM cartographer saw.
const COMPOSITE_BASE = "data/composites/cdof2022";
const COMPOSITE_NATIVE_SIZE = 1024;
const COMPOSITE_CROP_SIZE = 320;

// Build a cropped preview of the Phase 5 composite image showing the area the LLM
// flagged, with a red box at the bbox_pct position. Same CSS trick as for tiles.
function buildCompositeCropHtml(props) {
  if (!props || !props.bbox_pct || !props.source_composite) return "";

  const [x0, y0, x1, y1] = props.bbox_pct;
  const cx = ((x0 + x1) / 2) * COMPOSITE_NATIVE_SIZE;
  const cy = ((y0 + y1) / 2) * COMPOSITE_NATIVE_SIZE;
  const bw = (x1 - x0) * COMPOSITE_NATIVE_SIZE;
  const bh = (y1 - y0) * COMPOSITE_NATIVE_SIZE;

  const cropX = clamp(cx - COMPOSITE_CROP_SIZE / 2, 0, COMPOSITE_NATIVE_SIZE - COMPOSITE_CROP_SIZE);
  const cropY = clamp(cy - COMPOSITE_CROP_SIZE / 2, 0, COMPOSITE_NATIVE_SIZE - COMPOSITE_CROP_SIZE);

  // Bbox position relative to the crop top-left, with minimum visible size.
  const minDim = 20;
  const dispW = Math.max(bw, minDim);
  const dispH = Math.max(bh, minDim);
  const dispX = cx - cropX - dispW / 2;
  const dispY = cy - cropY - dispH / 2;

  const url = `${COMPOSITE_BASE}/${encodeURIComponent(props.source_composite)}.png`;
  return `
    <div class="tile-crop" style="width: ${COMPOSITE_CROP_SIZE}px; height: ${COMPOSITE_CROP_SIZE}px; background-image: url('${url}'); background-size: ${COMPOSITE_NATIVE_SIZE}px ${COMPOSITE_NATIVE_SIZE}px; background-position: -${cropX}px -${cropY}px;">
      <div class="tile-crop-bbox" style="left: ${dispX}px; top: ${dispY}px; width: ${dispW}px; height: ${dispH}px;"></div>
    </div>
    <div class="tile-crop-caption">${escapeHtml(props.source_composite)} · ${props.confidence || "?"} confidence</div>
  `;
}

// Tiles served by 12_export_tile_jpegs.py — same filename stem as the source
// GeoTIFF, just with a .jpg extension. Native pixel size is 1024×1024 to match
// the YOLO inference resolution; we crop a 256×256 window centered on the
// detection inside the popup.
const TILE_JPG_BASE = "data/tiles_jpg/cdof2022";
const TILE_NATIVE_SIZE = 1024;
const TILE_CROP_SIZE = 256;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// Build the cropped-preview HTML for a vehicle detection. Returns empty string
// when the detection lacks the pixel-space bbox fields (old vehicles.geojson
// from before bbox_px was added).
function buildTileCropHtml(props) {
  if (!props || props.bbox_px_cx == null || !props.source_tile) return "";

  const tile = props.source_tile;
  const cx = props.bbox_px_cx;
  const cy = props.bbox_px_cy;
  const bw = props.bbox_px_w || 0;
  const bh = props.bbox_px_h || 0;
  const tileW = props.tile_px_w || TILE_NATIVE_SIZE;
  const tileH = props.tile_px_h || TILE_NATIVE_SIZE;

  // Centre the 256×256 crop on the detection, then clamp so we never request
  // pixels outside the source image. Edge cases push the detection toward
  // the visual edge of the crop instead of off-screen.
  const cropX = clamp(cx - TILE_CROP_SIZE / 2, 0, tileW - TILE_CROP_SIZE);
  const cropY = clamp(cy - TILE_CROP_SIZE / 2, 0, tileH - TILE_CROP_SIZE);

  // Bbox position relative to the crop's top-left, with a minimum visible
  // size — actual cars are ~10×4 px which is too tiny to see at 256 px.
  const minDim = 16;
  const dispW = Math.max(bw, minDim);
  const dispH = Math.max(bh, minDim);
  const dispX = cx - cropX - dispW / 2;
  const dispY = cy - cropY - dispH / 2;

  const url = `${TILE_JPG_BASE}/${encodeURIComponent(tile)}.jpg`;
  return `
    <div class="tile-crop" style="background-image: url('${url}'); background-position: -${cropX}px -${cropY}px;">
      <div class="tile-crop-bbox" style="left: ${dispX}px; top: ${dispY}px; width: ${dispW}px; height: ${dispH}px;"></div>
    </div>
    <div class="tile-crop-caption">crop ${cropX.toFixed(0)},${cropY.toFixed(0)} → ${cropX + TILE_CROP_SIZE},${cropY + TILE_CROP_SIZE} of ${escapeHtml(tile)}</div>
  `;
}

const INFORMAL_TYPE_LABELS = {
  park_or_playground: "park / igralište",
  green_space: "zelena površina",
  wood: "šuma",
  farmland: "obradiva površina",
  school_grounds: "škola",
  hospital_grounds: "bolnica",
  civic_grounds: "javna zgrada",
  square: "trg",
  residential_block: "stambeno dvorište",
  industrial_yard: "industrijsko dvorište",
  commercial_area: "trgovačko",
  construction_site: "gradilište",
  water: "voda (vjerojatno greška)",
  roadside_or_unknown: "uz cestu / nepoznato",
  unknown: "nepoznato",
};

async function loadInformalLayer(map) {
  const url = "data/final/informal_parking.geojson";
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  let fc;
  try {
    fc = await res.json();
  } catch (err) {
    console.warn("informal_parking.geojson present but malformed:", err);
    return null;
  }
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;

  const layer = L.geoJSON(fc, {
    pointToLayer: (feature, latlng) => {
      const t = feature.properties?.informal_type || "unknown";
      const c = informalColor(t);
      return L.circleMarker(latlng, {
        radius: 5,
        color: c.stroke,
        weight: 1,
        fillColor: c.fill,
        fillOpacity: 0.85,
      });
    },
    onEachFeature: (feature, lyr) => {
      const p = feature.properties || {};
      const typeLabel = INFORMAL_TYPE_LABELS[p.informal_type] || p.informal_type || "—";
      const cropHtml = buildTileCropHtml(p);
      const html = `
        <strong>Neslužbeno parkiranje (Faza 3)</strong>
        ${cropHtml}
        <table class="popup-table">
          <tr><th>Vozilo</th><td>${escapeHtml(p.class || "vozilo")}</td></tr>
          <tr><th>Lokacija</th><td>${escapeHtml(typeLabel)}</td></tr>
          <tr><th>Confidence</th><td>${p.confidence ?? "—"}</td></tr>
          <tr><th>Veličina</th><td>${p.bbox_w_m ?? "—"} × ${p.bbox_h_m ?? "—"} m</td></tr>
          <tr><th>Udaljenost do službenog</th><td>${p.distance_to_official_m != null ? p.distance_to_official_m + " m" : "—"}</td></tr>
        </table>
      `;
      lyr.bindPopup(html, { maxWidth: 320 });
    },
  });

  layer.addTo(map);
  layers.informal = layer;

  const cb = document.getElementById("toggle-informal");
  cb.disabled = false;
  cb.checked = true;
  document.getElementById("count-informal").textContent = formatNumber(fc.features.length);

  // Surface a non-prominent informal-count in the headline so the user can see
  // the running total without having to open a layer.
  const sub = document.getElementById("hs-informal-sub");
  if (sub) {
    sub.textContent = `${formatNumber(fc.features.length)} neslužbenih`;
  }

  // Render a small breakdown of informal types under the layer toggle, drawn
  // from the metadata block written by 20_detect_informal.py.
  const byType = fc.metadata?.informal_by_type || {};
  const breakdownEl = document.getElementById("informal-breakdown");
  if (breakdownEl) {
    const sortedTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    breakdownEl.innerHTML = sortedTypes
      .map(([t, n]) => {
        const c = informalColor(t);
        const label = INFORMAL_TYPE_LABELS[t] || t;
        return `<div class="informal-row">
          <span class="informal-dot" style="background:${c.fill};border-color:${c.stroke}"></span>
          <span class="informal-label">${escapeHtml(label)}</span>
          <span class="count">${formatNumber(n)}</span>
        </div>`;
      })
      .join("");
  }

  return layer;
}

// ───────── Phase 5 LLM cartographer layers (one per provider) ─────────

// Provider-specific color palette. Anthropic = teal, OpenAI = magenta. Each
// provider's confidence levels share the same hue at varying opacities so
// "high-confidence Claude" and "low-confidence Claude" look related but
// distinct from anything GPT proposed.
const LLM_PALETTE = {
  anthropic: {
    high:   { fill: "#0d9488", stroke: "#134e4a", weight: 3.0, fillOpacity: 0.50 },
    medium: { fill: "#14b8a6", stroke: "#0f766e", weight: 2.5, fillOpacity: 0.35 },
    low:    { fill: "#5eead4", stroke: "#0f766e", weight: 2.0, fillOpacity: 0.20 },
  },
  openai: {
    high:   { fill: "#be185d", stroke: "#831843", weight: 3.0, fillOpacity: 0.50 },
    medium: { fill: "#ec4899", stroke: "#9d174d", weight: 2.5, fillOpacity: 0.35 },
    low:    { fill: "#f9a8d4", stroke: "#9d174d", weight: 2.0, fillOpacity: 0.20 },
  },
};

function llmStyleFor(feature) {
  const provider = feature?.properties?.provider || "anthropic";
  const conf = feature?.properties?.confidence || "low";
  const palette = LLM_PALETTE[provider] || LLM_PALETTE.anthropic;
  const s = palette[conf] || palette.low;
  return {
    color: s.stroke,
    weight: s.weight,
    fillColor: s.fill,
    fillOpacity: s.fillOpacity,
    dashArray: "6,3",  // dashed border to distinguish from solid OSM polygons
  };
}

function llmPopupHtml(feature) {
  const p = feature.properties || {};
  const providerLabel = p.provider === "openai" ? "Model 2" : "Model 1";
  const kindLabel = {
    street_parking: "ulično parkiranje",
    lot: "parkiralište",
    courtyard: "dvorište",
  }[p.kind] || p.kind || "—";
  const confLabel = {
    high: "visoka",
    medium: "srednja",
    low: "niska",
  }[p.confidence] || p.confidence || "—";
  const cropHtml = buildCompositeCropHtml(p);
  return `
    <strong>LLM prijedlog (Faza 5) — ${escapeHtml(providerLabel)}</strong>
    ${cropHtml}
    <table class="popup-table">
      <tr><th>Model</th><td>${escapeHtml(p.model || "—")}</td></tr>
      <tr><th>Vrsta</th><td>${escapeHtml(kindLabel)}</td></tr>
      <tr><th>Pouzdanost</th><td>${escapeHtml(confLabel)}</td></tr>
      <tr><th>Razlog</th><td>${escapeHtml(p.reason || "—")}</td></tr>
    </table>
  `;
}

async function loadLlmLayer(map) {
  const url = "data/candidates/llm_parking_candidates.geojson";
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  let fc;
  try {
    fc = await res.json();
  } catch (err) {
    console.warn("llm_parking_candidates.geojson present but malformed:", err);
    return null;
  }
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;
  if (fc.features.length === 0) return null;  // empty file from a dry-run, skip

  // Split by provider so the user can toggle each independently for A/B review.
  const byProvider = { anthropic: [], openai: [] };
  for (const feat of fc.features) {
    const prov = feat.properties?.provider || "anthropic";
    if (!byProvider[prov]) byProvider[prov] = [];
    byProvider[prov].push(feat);
  }

  const buildLayer = (features) => {
    if (!features.length) return null;
    return L.geoJSON({ type: "FeatureCollection", features }, {
      style: llmStyleFor,
      onEachFeature: (feature, lyr) => {
        lyr.bindPopup(llmPopupHtml(feature), { maxWidth: 360 });
      },
    });
  };

  const anthropicLayer = buildLayer(byProvider.anthropic);
  const openaiLayer = buildLayer(byProvider.openai);

  if (anthropicLayer) {
    anthropicLayer.addTo(map);
    layers.llmAnthropic = anthropicLayer;
    const cb = document.getElementById("toggle-llm-anthropic");
    if (cb) { cb.disabled = false; cb.checked = true; }
    const ctr = document.getElementById("count-llm-anthropic");
    if (ctr) ctr.textContent = formatNumber(byProvider.anthropic.length);
  }
  if (openaiLayer) {
    openaiLayer.addTo(map);
    layers.llmOpenai = openaiLayer;
    const cb = document.getElementById("toggle-llm-openai");
    if (cb) { cb.disabled = false; cb.checked = true; }
    const ctr = document.getElementById("count-llm-openai");
    if (ctr) ctr.textContent = formatNumber(byProvider.openai.length);
  }
  return { anthropicLayer, openaiLayer };
}

// ───────── Phase 1 ML candidates layer ─────────

async function loadMlLayer(map) {
  const url = "data/candidates/missing_parking.geojson";
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  let fc;
  try {
    fc = await res.json();
  } catch (err) {
    console.warn("ML candidates file present but malformed:", err);
    return null;
  }
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;

  const layer = L.geoJSON(fc, {
    style: () => ({
      color: "#b45309",
      weight: 1.5,
      fillColor: "#f59e0b",
      fillOpacity: 0.55,
    }),
    onEachFeature: (feature, lyr) => {
      const p = feature.properties || {};
      const html = `
        <strong>ML kandidat (Phase 1)</strong>
        <table class="popup-table">
          <tr><th>Površina</th><td>${formatArea(p.area_m2)}</td></tr>
          <tr><th>Kompaktnost</th><td>${p.compactness ?? "—"}</td></tr>
          <tr><th>IoU vs OSM</th><td>${p.best_iou_with_osm ?? "0"}</td></tr>
          <tr><th>Source tile</th><td>${escapeHtml(p.source_tile || "—")}</td></tr>
        </table>
      `;
      lyr.bindPopup(html, { maxWidth: 320 });
    },
  });

  layer.addTo(map);
  layers.ml = layer;

  const cb = document.getElementById("toggle-ml");
  cb.disabled = false;
  cb.checked = true;
  document.getElementById("count-ml").textContent = formatNumber(fc.features.length);
}

// ───────── Admin borders + per-area aggregation ─────────

function setAdminStatus(text) {
  document.getElementById("admin-status").textContent = text || "";
}

async function fetchAdminBorders(level) {
  // Endpoint is `/api/borders` in the shared cadastre-data API. The viewer-
  // side function name kept "Admin" for the UI labels (Administrativne razine);
  // only the URL changed.
  const url = `${API_BASE}/api/borders?city=Zagreb&level=${level}`;
  if (bordersCache.has(url)) return bordersCache.get(url);
  setAdminStatus(`učitavam ${ADMIN_LEVEL_LABELS[level] || ""}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API HTTP ${res.status} from ${url}`);
  const fc = await res.json();
  bordersCache.set(url, fc);
  return fc;
}

// Aggregate parking handles into the admin areas. Returns an array of
// { name, lots, lots_open, lots_enclosed, area_m2, capacity_open, capacity_enclosed,
//   capacity_total, feature } sorted later by user choice.
function aggregateByAdmin(adminFc, handles) {
  const buckets = new Map();
  adminFc.features.forEach((feature) => {
    buckets.set(feature.properties.name, {
      name: feature.properties.name,
      lots: 0,
      lots_open: 0,
      lots_enclosed: 0,
      area_m2: 0,
      capacity_open: 0,
      capacity_enclosed: 0,
      capacity_total: 0,
      feature,
    });
  });

  // Bbox prefilter cuts the expensive booleanPointInPolygon by ~10×.
  const adminBboxes = adminFc.features.map((f) => turf.bbox(f));

  for (const h of handles) {
    const pt = [h.lon, h.lat];
    for (let i = 0; i < adminFc.features.length; i++) {
      const [minX, minY, maxX, maxY] = adminBboxes[i];
      if (pt[0] < minX || pt[0] > maxX || pt[1] < minY || pt[1] > maxY) continue;
      if (turf.booleanPointInPolygon(pt, adminFc.features[i])) {
        const b = buckets.get(adminFc.features[i].properties.name);
        if (b) {
          b.lots += 1;
          b.area_m2 += h.area_m2;
          b.capacity_total += h.capacity;
          if (h.kind === "enclosed") {
            b.lots_enclosed += 1;
            b.capacity_enclosed += h.capacity;
          } else {
            b.lots_open += 1;
            b.capacity_open += h.capacity;
          }
        }
        break;
      }
    }
  }

  return Array.from(buckets.values());
}

function sortAggregation(rows, sortKey) {
  const arr = [...rows];
  switch (sortKey) {
    case "lots":
      arr.sort((a, b) => b.lots - a.lots || a.name.localeCompare(b.name, "hr"));
      break;
    case "capacity-open":
      arr.sort((a, b) => b.capacity_open - a.capacity_open || a.name.localeCompare(b.name, "hr"));
      break;
    case "capacity-enclosed":
      arr.sort((a, b) => b.capacity_enclosed - a.capacity_enclosed || a.name.localeCompare(b.name, "hr"));
      break;
    case "name":
      arr.sort((a, b) => a.name.localeCompare(b.name, "hr"));
      break;
    case "capacity":
    default:
      arr.sort((a, b) => b.capacity_total - a.capacity_total || a.name.localeCompare(b.name, "hr"));
  }
  return arr;
}

function renderTotalsTable(rows, sortKey) {
  const tbody = document.getElementById("totals-tbody");
  const sorted = sortAggregation(rows, sortKey);
  tbody.innerHTML = sorted.map((r) => {
    const openCell = r.capacity_open > 0 ? formatNumber(r.capacity_open) : '<span class="muted">0</span>';
    const enclosedCell = r.capacity_enclosed > 0 ? formatNumber(r.capacity_enclosed) : '<span class="muted">0</span>';
    const selected = r.name === selectedAdminName ? " selected" : "";
    return `
      <tr data-name="${escapeHtml(r.name)}" class="${selected}">
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${formatNumber(r.lots)}</td>
        <td class="num">${openCell}</td>
        <td class="num">${enclosedCell}</td>
        <td class="num"><strong>${formatNumber(r.capacity_total)}</strong></td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      tbody.querySelectorAll("tr.selected").forEach((row) => row.classList.remove("selected"));
      tr.classList.add("selected");
      selectedAdminName = tr.dataset.name;
      const row = currentAggregation.find((x) => x.name === selectedAdminName);
      if (row) selectAdminArea(row.feature);
    });
  });

  // Highlight active sort header
  document.querySelectorAll(".totals-table th.sortable").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === sortKey);
  });
}

function showTotalsContent(level, rows) {
  document.getElementById("totals-content").hidden = false;
}

function hideTotalsContent() {
  document.getElementById("totals-content").hidden = true;
  currentAggregation = null;
}

function selectAdminArea(feature) {
  const map = mapRef;
  if (layers.adminHighlight) {
    map.removeLayer(layers.adminHighlight);
    layers.adminHighlight = null;
  }
  layers.adminHighlight = L.geoJSON(feature, { style: adminHighlightStyle() }).addTo(map);
  try {
    map.fitBounds(layers.adminHighlight.getBounds(), { padding: [40, 40], maxZoom: 16 });
  } catch (err) {}
}

function clearAdminLayers() {
  if (layers.admin) {
    mapRef.removeLayer(layers.admin);
    layers.admin = null;
  }
  if (layers.adminHighlight) {
    mapRef.removeLayer(layers.adminHighlight);
    layers.adminHighlight = null;
  }
}

async function selectAdminLevel(value) {
  clearAdminLayers();

  if (value === "city") {
    hideTotalsContent();
    setAdminStatus("");
    return;
  }

  if (!osmHandles && !streetViewHandles.length) {
    setAdminStatus("Nema učitanih podataka");
    return;
  }

  const level = Number(value);
  try {
    const adminFc = await fetchAdminBorders(level);
    const allHandles = [...(osmHandles || []), ...streetViewHandles];
    setAdminStatus(`agregiram ${formatNumber(allHandles.length)} parkirališta…`);

    layers.admin = L.geoJSON(adminFc, { style: adminBaseStyle() }).addTo(mapRef);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = aggregateByAdmin(adminFc, allHandles);
    currentAggregation = rows;

    renderTotalsTable(rows, currentSortKey);
    showTotalsContent(level, rows);
    setAdminStatus(`${adminFc.features.length} područja iz API-ja`);
  } catch (err) {
    console.error(err);
    setAdminStatus(`Greška: ${err.message}. Je li zagreb-api pokrenut na ${API_BASE}?`);
    hideTotalsContent();
  }
}

// ───────── Street View reviewed parking layer ─────────

async function loadStreetViewLayer(map) {
  const url = `${API_BASE}/api/parking/areas`;
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return null;
  }
  if (!res.ok) return null;

  let fc;
  try {
    fc = await res.json();
  } catch (err) {
    console.warn("Street View parking API response malformed:", err);
    return null;
  }
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;
  if (fc.features.length === 0) return null;

  // Compute area and capacity for each feature
  for (const f of fc.features) {
    try {
      const area = turf.area(f);
      f.properties._area_m2 = area;
      const manner = f.properties?.tags?.parking_manner || "parallel";
      const footprint = CAR_FOOTPRINT[manner] || CAR_FOOTPRINT.parallel;
      f.properties._capacity = Math.round(area / footprint);
    } catch { f.properties._area_m2 = 0; f.properties._capacity = 0; }
  }

  // Build aggregation handles
  streetViewHandles = [];
  for (const f of fc.features) {
    const p = f.properties || {};
    try {
      const c = turf.centroid(f);
      const [lon, lat] = c.geometry.coordinates;
      streetViewHandles.push({
        lon, lat,
        kind: "street_view",
        source: "street_view",
        status: p.review_status || "pending",
        capacity: p._capacity || 0,
        area_m2: p._area_m2 || 0,
      });
    } catch {}
  }

  const byStatus = { confirmed: [], pending: [], suspect: [] };
  for (const f of fc.features) {
    const s = f.properties?.review_status || "pending";
    (byStatus[s] || byStatus.pending).push(f);
  }

  const statusStyles = {
    confirmed: { color: "#475569", fillColor: "#64748b", fillOpacity: 0.3, dashArray: null },
    pending: { color: "#6d28d9", fillColor: "#8b5cf6", fillOpacity: 0.45, dashArray: null },
    suspect: { color: "#b45309", fillColor: "#fbbf24", fillOpacity: 0.35, dashArray: "6 4" },
  };

  const statusLabels = { confirmed: "potvrđeno", pending: "čeka", suspect: "sumnjivo" };

  function streetViewPopup(feature, lyr) {
    const p = feature.properties || {};
    const tags = p.tags || {};
    const reviewUrl = `unos/review.html`;
    const html = `
      <strong>Street View · ${escapeHtml(statusLabels[p.review_status] || p.review_status)}</strong>
      <table class="popup-table">
        <tr><th>Segment</th><td>${escapeHtml(p.segment_id || "—")} · ${escapeHtml(p.side || "—")}</td></tr>
        <tr><th>Način</th><td>${escapeHtml(tags.parking_manner || "—")}</td></tr>
        <tr><th>Razina</th><td>${escapeHtml(tags.parking_level || "—")}</td></tr>
        <tr><th>Formalnost</th><td>${escapeHtml(tags.formality || "—")}</td></tr>
        <tr><th>Pouzdanost</th><td>${p.confidence != null ? Number(p.confidence).toFixed(2) : "—"}</td></tr>
        <tr><th>Površina</th><td>${formatArea(p._area_m2)}</td></tr>
        <tr><th>Kapacitet</th><td>~${p._capacity || 0} mjesta</td></tr>
      </table>
      <a href="${reviewUrl}" class="popup-review-link" target="_blank" rel="noopener">Pregledaj</a>
    `;
    lyr.bindPopup(html, { maxWidth: 320 });
  }

  for (const [status, features] of Object.entries(byStatus)) {
    const style = statusStyles[status];
    const layer = L.geoJSON({ type: "FeatureCollection", features }, {
      style: () => ({ color: style.color, weight: 2, fillColor: style.fillColor, fillOpacity: style.fillOpacity, dashArray: style.dashArray }),
      onEachFeature: streetViewPopup,
    });
    if (features.length > 0) layer.addTo(map);

    const key = `streetView${status.charAt(0).toUpperCase() + status.slice(1)}`;
    layers[key] = layer;

    const countEl = document.getElementById(`count-street-view-${status}`);
    const toggleEl = document.getElementById(`toggle-street-view-${status}`);
    if (countEl) countEl.textContent = features.length;
    if (toggleEl) toggleEl.disabled = false;
  }

  const allCountEl = document.getElementById("count-street-view-all");
  if (allCountEl) allCountEl.textContent = fc.features.length;

  // Update headline to include street view data
  reaggregateTotals();
}

// ───────── Layer toggles ─────────

function wireToggle(checkboxId, layerName) {
  const cb = document.getElementById(checkboxId);
  cb.addEventListener("change", () => {
    const layer = layers[layerName];
    if (!layer) return;
    if (cb.checked) layer.addTo(mapRef);
    else mapRef.removeLayer(layer);
    reaggregateTotals();
  });
}

function visibleHandles() {
  const osmOpenVisible = document.getElementById("toggle-osm-open")?.checked !== false;
  const osmEnclosedVisible = document.getElementById("toggle-osm-enclosed")?.checked !== false;
  const svConfirmedVisible = document.getElementById("toggle-street-view-confirmed")?.checked !== false;
  const svPendingVisible = document.getElementById("toggle-street-view-pending")?.checked !== false;
  const svSuspectVisible = document.getElementById("toggle-street-view-suspect")?.checked !== false;

  const filtered = [];
  if (osmHandles) {
    for (const h of osmHandles) {
      if (h.kind === "open_air" && !osmOpenVisible) continue;
      if (h.kind === "enclosed" && !osmEnclosedVisible) continue;
      filtered.push(h);
    }
  }
  for (const h of streetViewHandles) {
    if (h.status === "confirmed" && !svConfirmedVisible) continue;
    if (h.status === "pending" && !svPendingVisible) continue;
    if (h.status === "suspect" && !svSuspectVisible) continue;
    filtered.push(h);
  }
  return filtered;
}

function updateHeadlineFromHandles(handles) {
  const totals = { spots: 0, open: 0, enclosed: 0, lots: 0, lotsOpen: 0, lotsEnclosed: 0, area: 0 };
  for (const h of handles) {
    totals.spots += h.capacity;
    totals.lots += 1;
    totals.area += h.area_m2;
    if (h.kind === "enclosed") { totals.enclosed += h.capacity; totals.lotsEnclosed += 1; }
    else { totals.open += h.capacity; totals.lotsOpen += 1; }
  }
  document.getElementById("hs-spots").textContent = formatNumber(totals.spots);
  document.getElementById("hs-spots-sub").textContent = `${formatNumber(totals.open)} otv. · ${formatNumber(totals.enclosed)} zatv.`;
  document.getElementById("hs-lots").textContent = formatNumber(totals.lots);
  document.getElementById("hs-lots-sub").textContent = `${formatNumber(totals.lotsOpen)} otv. · ${formatNumber(totals.lotsEnclosed)} zatv.`;
  document.getElementById("hs-area").textContent = NUM_FMT_DEC.format(totals.area / 1e6);
}

function reaggregateTotals() {
  const filtered = visibleHandles();
  updateHeadlineFromHandles(filtered);

  if (!currentAggregation) return;
  const level = document.getElementById("admin-level")?.value;
  if (!level || level === "city") return;

  // Re-aggregate with current visible handles but keep existing sort and selection
  const adminFc = { type: "FeatureCollection", features: currentAggregation.map((r) => r.feature) };
  const rows = aggregateByAdmin(adminFc, filtered);
  currentAggregation = rows;

  // Update numbers in existing rows without resorting
  const tbody = document.getElementById("totals-tbody");
  const rowsByName = new Map(rows.map((r) => [r.name, r]));
  tbody.querySelectorAll("tr").forEach((tr) => {
    const r = rowsByName.get(tr.dataset.name);
    if (!r) return;
    const cells = tr.querySelectorAll("td");
    if (cells.length >= 5) {
      cells[1].textContent = formatNumber(r.lots);
      cells[2].innerHTML = r.capacity_open > 0 ? formatNumber(r.capacity_open) : '<span class="muted">0</span>';
      cells[3].innerHTML = r.capacity_enclosed > 0 ? formatNumber(r.capacity_enclosed) : '<span class="muted">0</span>';
      cells[4].innerHTML = `<strong>${formatNumber(r.capacity_total)}</strong>`;
    }
  });
}

// ───────── Init ─────────

let mapRef = null;

function init() {
  mapRef = L.map("map", { zoomControl: true }).setView(ZAGREB_CENTER, DEFAULT_ZOOM);
  L.control.scale({ imperial: false }).addTo(mapRef);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(mapRef);

  loadOsmLayer(mapRef);
  loadMlLayer(mapRef);
  loadInformalLayer(mapRef);
  loadLlmLayer(mapRef);
  loadStreetViewLayer(mapRef);

  wireToggle("toggle-osm-open", "osmOpen");
  wireToggle("toggle-osm-enclosed", "osmEnclosed");
  wireToggle("toggle-ml", "ml");
  wireToggle("toggle-informal", "informal");
  wireToggle("toggle-llm-anthropic", "llmAnthropic");
  wireToggle("toggle-llm-openai", "llmOpenai");
  wireToggle("toggle-street-view-confirmed", "streetViewConfirmed");
  wireToggle("toggle-street-view-pending", "streetViewPending");
  wireToggle("toggle-street-view-suspect", "streetViewSuspect");

  document.getElementById("admin-level").addEventListener("change", (e) => {
    selectAdminLevel(e.target.value);
  });

  // Sortable column headers
  document.querySelectorAll(".totals-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      currentSortKey = th.dataset.sort;
      if (currentAggregation) renderTotalsTable(currentAggregation, currentSortKey);
    });
  });

  // Mobile panel toggles
  const legendEl = document.getElementById("legend");
  const totalsEl = document.getElementById("totals-panel");
  const layersBtn = document.getElementById("toggle-layers-btn");
  const statsBtn = document.getElementById("toggle-stats-btn");

  layersBtn.addEventListener("click", () => {
    const opening = !legendEl.classList.contains("mobile-open");
    legendEl.classList.toggle("mobile-open", opening);
    totalsEl.classList.remove("mobile-open");
    layersBtn.classList.toggle("active", opening);
    statsBtn.classList.remove("active");
  });

  statsBtn.addEventListener("click", () => {
    const opening = !totalsEl.classList.contains("mobile-open");
    totalsEl.classList.toggle("mobile-open", opening);
    legendEl.classList.remove("mobile-open");
    statsBtn.classList.toggle("active", opening);
    layersBtn.classList.remove("active");
  });

  // Tap map to close panels on mobile
  mapRef.on("click", () => {
    legendEl.classList.remove("mobile-open");
    totalsEl.classList.remove("mobile-open");
    layersBtn.classList.remove("active");
    statsBtn.classList.remove("active");
  });
}

document.addEventListener("DOMContentLoaded", init);
