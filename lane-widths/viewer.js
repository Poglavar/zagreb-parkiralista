// Lane Width Measurement Viewer — shows road segments on a Leaflet map with
// lane boundary polylines, cross-section profiles, and measurement details.

const ANALYSIS_URL = "data/lane-widths.json";
const PROFILE_BASE = "data/debug";
const GEOJSON_URL = "data/lane-boundaries.geojson";

// Local cadastre-data API for road queries (avoids Overpass timeouts).
const API_BASE = (() => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("apiBase");
  if (explicit) return explicit.replace(/\/$/, "");
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostname = window.location.hostname || "localhost";
  return `${protocol}//${hostname}:3001`;
})();

const ZAGREB_CENTER = [45.808, 15.975];
const DEFAULT_ZOOM = 15;

let allResults = [];
let filteredResults = [];
let currentIndex = 0;
let map = null;
let polylineLayer = null;
let highlightLayer = null;
let allBoundariesLayer = null;
let osmWaysLayer = null;

// ───────── Helpers ─────────

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ───────── Sorting + filtering ─────────

function applySort(results, key) {
  const arr = [...results];
  switch (key) {
    case "confidence_desc":
      arr.sort((a, b) => b.measurement.confidence - a.measurement.confidence);
      break;
    case "width_desc":
      arr.sort((a, b) => (b.measurement.total_carriageway_m || 0) - (a.measurement.total_carriageway_m || 0));
      break;
    case "lanes_desc":
      arr.sort((a, b) => (b.measurement.lane_count || 0) - (a.measurement.lane_count || 0));
      break;
    case "name":
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || "", "hr"));
      break;
  }
  return arr;
}

function applyFilter(results, key) {
  switch (key) {
    case "marking_detection":
      return results.filter((r) => r.measurement.method === "marking_detection");
    case "edge_divided_by_osm_lanes":
      return results.filter((r) => r.measurement.method === "edge_divided_by_osm_lanes");
    case "has_polylines":
      return results.filter((r) => r.lane_boundary_polylines && r.lane_boundary_polylines.length > 0);
    case "insufficient_data":
      return results.filter((r) => r.measurement.method === "insufficient_data");
    default:
      return results;
  }
}

function refreshList() {
  const sortKey = document.getElementById("sort-select").value;
  const filterKey = document.getElementById("filter-select").value;
  filteredResults = applyFilter(applySort(allResults, sortKey), filterKey);
  currentIndex = 0;
  document.getElementById("filter-count").textContent = `${filteredResults.length} of ${allResults.length}`;
  renderCurrent();
}

// ───────── Rendering ─────────

const METHOD_LABELS = {
  marking_detection: "Lane markings detected",
  edge_divided_by_osm_lanes: "Road edges ÷ OSM lanes",
  cadastral_corridor_estimate: "Cadastral corridor estimate",
  insufficient_data: "Insufficient data",
};

function renderCurrent() {
  if (filteredResults.length === 0) {
    document.getElementById("counter").textContent = "0 / 0";
    document.getElementById("road-name").textContent = "No results";
    return;
  }

  const r = filteredResults[currentIndex];
  const m = r.measurement;
  document.getElementById("counter").textContent = `${currentIndex + 1} / ${filteredResults.length}`;

  // Road info
  document.getElementById("road-name").textContent = r.name || `OSM ${r.osm_id}`;
  document.getElementById("road-meta").innerHTML = [
    `<strong>${r.highway}</strong>`,
    `OSM ID: ${r.osm_id}`,
    `Length: ${r.segment_length_m} m`,
    r.osm_lanes ? `OSM lanes: ${r.osm_lanes}` : null,
    m.corridor_width_m ? `Cadastral corridor: ${m.corridor_width_m.toFixed(1)} m` : null,
  ].filter(Boolean).join(" · ");

  // Stats
  const confClass = m.confidence >= 0.7 ? "high" : m.confidence >= 0.4 ? "medium" : "low";
  document.getElementById("stat-grid").innerHTML = `
    <div class="stat-item"><span class="stat-value">${m.lane_count ?? "—"}</span><span class="stat-label">Lanes</span></div>
    <div class="stat-item"><span class="stat-value ${confClass}">${m.confidence.toFixed(2)}</span><span class="stat-label">Confidence</span></div>
    <div class="stat-item"><span class="stat-value">${m.total_carriageway_m != null ? m.total_carriageway_m + " m" : "—"}</span><span class="stat-label">Carriageway</span></div>
    <div class="stat-item"><span class="stat-value">${m.corridor_width_m != null ? m.corridor_width_m.toFixed(1) + " m" : "—"}</span><span class="stat-label">Corridor</span></div>
    <div style="grid-column: span 2"><span class="method-tag ${m.method}">${METHOD_LABELS[m.method] || m.method}</span></div>
  `;

  // Lane width bars
  const widths = m.lane_widths_m || [];
  const maxWidth = Math.max(...widths, 4);
  if (widths.length > 0) {
    document.getElementById("lane-bars").innerHTML = widths.map((w, i) => {
      const pct = Math.max(10, (w / maxWidth) * 100);
      return `<div class="lane-bar-row">
        <span class="lane-bar-label">Lane ${i + 1}</span>
        <div class="lane-bar lane" style="width: ${pct}%">${w} m</div>
      </div>`;
    }).join("");
  } else {
    document.getElementById("lane-bars").innerHTML = '<span class="meta-line">No lane widths measured</span>';
  }

  // Profile image
  const profileImg = document.getElementById("profile-img");
  const profilePath = `${PROFILE_BASE}/profile_${r.osm_id}.png`;
  profileImg.src = profilePath;
  profileImg.onerror = () => { profileImg.src = ""; };
  document.getElementById("profile-caption").textContent = `profile_${r.osm_id}.png`;

  // Map: show polylines for this segment
  renderMapForSegment(r);
}

function renderMapForSegment(r) {
  // Clear previous highlight
  if (highlightLayer) {
    map.removeLayer(highlightLayer);
    highlightLayer = null;
  }

  const polylines = r.lane_boundary_polylines || [];
  if (polylines.length === 0) {
    // Just fly to centroid
    if (r.centroid) {
      map.setView([r.centroid[1], r.centroid[0]], 17);
    }
    return;
  }

  // Draw this segment's polylines in highlight colors
  const features = polylines.map((coords, i) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      type: (i === 0 || i === polylines.length - 1) ? "edge" : "marking",
      index: i,
    },
  }));

  highlightLayer = L.geoJSON({ type: "FeatureCollection", features }, {
    style: (feature) => {
      const isEdge = feature.properties.type === "edge";
      return {
        color: isEdge ? "#2563eb" : "#dc2626",
        weight: isEdge ? 4 : 3,
        opacity: 0.9,
        dashArray: isEdge ? null : "6,4",
      };
    },
  }).addTo(map);

  try {
    map.fitBounds(highlightLayer.getBounds(), { padding: [60, 60], maxZoom: 19 });
  } catch (e) {}
}

// ───────── Navigation ─────────

function goNext() {
  if (filteredResults.length === 0) return;
  currentIndex = (currentIndex + 1) % filteredResults.length;
  renderCurrent();
}

function goPrev() {
  if (filteredResults.length === 0) return;
  currentIndex = (currentIndex - 1 + filteredResults.length) % filteredResults.length;
  renderCurrent();
}

// ───────── Init ─────────

async function init() {
  try {
    // Load analysis data
    const res = await fetch(ANALYSIS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${ANALYSIS_URL}: HTTP ${res.status}`);
    const data = await res.json();
    allResults = data.results || [];

    // Init map with multiple base layers
    map = L.map("map", { zoomControl: true }).setView(ZAGREB_CENTER, DEFAULT_ZOOM);

    const osmBase = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 20,
    });

    const zagreb2018 = L.tileLayer("https://tms.osm-hr.org/zagreb-2018/{z}/{x}/{y}.png", {
      tms: true,
      attribution: '&copy; OSM-HR · Zagreb 2018',
      maxZoom: 20,
    });

    const cdof2022 = L.tileLayer.wms("https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer", {
      layers: "ZG_CDOF2022",
      format: "image/jpeg",
      transparent: false,
      attribution: "Grad Zagreb CDOF 2022",
      maxZoom: 20,
    });

    osmBase.addTo(map);

    L.control.layers({
      "OSM karta": osmBase,
      "Zagreb 2018 (aerial)": zagreb2018,
      "CDOF 2022 (aerial)": cdof2022,
    }, {}, { position: "topright" }).addTo(map);

    // Load all boundary polylines as a faint background layer
    try {
      const geoRes = await fetch(GEOJSON_URL, { cache: "no-store" });
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        allBoundariesLayer = L.geoJSON(geoData, {
          style: (feature) => {
            const isEdge = feature.properties.boundary_type === "road_edge";
            return {
              color: isEdge ? "#93c5fd" : "#fca5a5",
              weight: isEdge ? 2 : 1.5,
              opacity: 0.4,
              dashArray: isEdge ? null : "4,4",
            };
          },
          onEachFeature: (feature, layer) => {
            const p = feature.properties;
            layer.bindPopup(`
              <strong>${escapeHtml(p.name)}</strong><br>
              ${p.boundary_type} · ${p.method}<br>
              Widths: ${(p.lane_widths_m || []).join(", ")} m
            `, { maxWidth: 280 });
          },
        }).addTo(map);

        // Fit to all boundaries
        if (allBoundariesLayer.getBounds().isValid()) {
          map.fitBounds(allBoundariesLayer.getBounds(), { padding: [30, 30] });
        }
      }
    } catch (e) {
      console.warn("Could not load lane-boundaries.geojson:", e);
    }

    document.getElementById("loading").classList.add("hidden");
    refreshList();

    // Wire controls
    document.getElementById("btn-prev").addEventListener("click", goPrev);
    document.getElementById("btn-next").addEventListener("click", goNext);
    document.getElementById("sort-select").addEventListener("change", refreshList);
    document.getElementById("filter-select").addEventListener("change", refreshList);

    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); goNext(); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); goPrev(); }
    });

    // OSM ways query button
    document.getElementById("btn-osm-ways").addEventListener("click", fetchOsmWays);
  } catch (err) {
    document.getElementById("loading").textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

// ───────── OSM ways overlay ─────────

const LANE_COLORS = {
  "1": "#94a3b8",
  "2": "#3b82f6",
  "3": "#8b5cf6",
  "4": "#dc2626",
  "5": "#ea580c",
  "6": "#ca8a04",
};

async function fetchOsmWays() {
  const btn = document.getElementById("btn-osm-ways");
  btn.disabled = true;
  btn.textContent = "Loading…";

  // Clear previous
  if (osmWaysLayer) {
    map.removeLayer(osmWaysLayer);
    osmWaysLayer = null;
  }

  const bounds = map.getBounds();
  // Query the local cadastre-data API which reads from osm_road in PostGIS —
  // no Overpass timeouts, instant response. Falls back to Overpass if the
  // local API isn't available.
  let features;
  try {
    features = await fetchFromLocalApi(bounds);
  } catch (localErr) {
    console.warn("Local API failed, trying Overpass:", localErr.message);
    try {
      features = await fetchFromOverpass(bounds);
    } catch (overpassErr) {
      console.error("Both sources failed:", overpassErr);
      btn.textContent = "OSM ways (error)";
      btn.disabled = false;
      return;
    }
  }

  renderOsmWays(features, btn);
}

async function fetchFromLocalApi(bounds) {
  // The osm_road table has geometry in EPSG:3765. The API endpoint serves
  // roads as GeoJSON within a bbox. We'll use a direct query through the
  // borders-style API pattern.
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
  const url = `${API_BASE}/api/roads?bbox=${bbox}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const data = await res.json();
  if (!data.features) throw new Error("No features in response");
  return data.features;
}

async function fetchFromOverpass(bounds) {
  const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
  const query = `[out:json][timeout:15];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)$"](${bbox}););out body geom;`;

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();

  const features = [];
  for (const elem of data.elements || []) {
    if (elem.type !== "way" || !elem.geometry) continue;
    const coords = elem.geometry.map((p) => [p.lon, p.lat]);
    if (coords.length < 2) continue;
    const tags = elem.tags || {};
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        osm_id: elem.id,
        highway: tags.highway || "?",
        name: tags.name || tags.ref || "",
        lanes: tags.lanes || null,
        oneway: tags.oneway || "no",
        surface: tags.surface || null,
      },
    });
  }
  return features;
}

function renderOsmWays(features, btn) {
  const laneLabels = [];  // collect labels, add after layer is created
  try {
    osmWaysLayer = L.geoJSON({ type: "FeatureCollection", features }, {
      style: (feature) => {
        const lanes = feature.properties.lanes;
        const color = lanes ? (LANE_COLORS[lanes] || "#f97316") : "#d1d5db";
        const weight = lanes ? Math.min(Number(lanes) + 1, 6) : 2;
        return { color, weight, opacity: 0.7 };
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const lanesText = p.lanes ? `<strong>${p.lanes} lanes</strong>` : "<em>no lanes tag</em>";
        layer.bindPopup(`
          <strong>${escapeHtml(p.name || "unnamed")}</strong><br>
          ${p.highway} · ${lanesText}<br>
          oneway: ${p.oneway} · surface: ${p.surface || "?"}
        `, { maxWidth: 280 });

        // Collect lane count labels to add after layer creation
        if (p.lanes) {
          const latlngs = layer.getLatLngs();
          const mid = latlngs[Math.floor(latlngs.length / 2)];
          if (mid) {
            laneLabels.push({ latlng: mid, lanes: p.lanes });
          }
        }
      },
    }).addTo(map);

    // Now add lane count labels
    for (const { latlng, lanes } of laneLabels) {
      const marker = L.marker(latlng, {
        icon: L.divIcon({
          className: "lane-count-label",
          html: `<span>${lanes}</span>`,
          iconSize: [20, 16],
          iconAnchor: [10, 8],
        }),
        interactive: false,
      });
      osmWaysLayer.addLayer(marker);
    }

    const withLanes = features.filter((f) => f.properties.lanes).length;
    btn.textContent = `OSM ways (${features.length}, ${withLanes} with lanes)`;
  } catch (err) {
    console.error("Failed to render OSM ways:", err);
    btn.textContent = "OSM ways (error)";
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
