// YOLO Street View Viewer — loads yolo-analysis.json, displays images with
// YOLO bounding-box overlays, side-of-street classification, and derived
// parking signals. Navigation by arrow keys or buttons.

// Images are accessible via a symlink: yolo-street-view/images → ../street-view/out/images.
// This avoids path-traversal issues when serving from inside yolo-street-view/ with npx serve.
const IMAGE_BASE = "images";
const ANALYSIS_URL = "out/yolo-analysis.json";
const DISPLAY_SIZE = 500;  // px — the rendered image container size
const NATIVE_SIZE = 640;   // px — the source image dimensions
const SCALE = DISPLAY_SIZE / NATIVE_SIZE;

let allImages = [];     // full dataset from the JSON
let filteredImages = []; // after applying filter
let currentIndex = 0;

// ───────── Data loading ─────────

async function loadData() {
  const res = await fetch(ANALYSIS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${ANALYSIS_URL}: HTTP ${res.status}`);
  return res.json();
}

// ───────── Sorting + filtering ─────────

function applySort(images, sortKey) {
  const arr = [...images];
  switch (sortKey) {
    case "parking_score_desc":
      arr.sort((a, b) => (b.analysis.parking_score - a.analysis.parking_score) || b.analysis.car_count - a.analysis.car_count);
      break;
    case "car_count_desc":
      arr.sort((a, b) => b.analysis.car_count - a.analysis.car_count);
      break;
    case "car_count_asc":
      arr.sort((a, b) => a.analysis.car_count - b.analysis.car_count);
      break;
    case "filename":
      arr.sort((a, b) => a.filename.localeCompare(b.filename));
      break;
  }
  return arr;
}

function applyFilter(images, filterKey) {
  switch (filterKey) {
    case "likely_parking":
      return images.filter((img) => img.analysis.parking_assessment === "likely_parking");
    case "possible_parking":
      return images.filter((img) => img.analysis.parking_assessment === "possible_parking");
    case "no_clear_signal":
      return images.filter((img) => img.analysis.parking_assessment === "no_clear_signal");
    case "no_vehicles":
      return images.filter((img) => img.analysis.parking_assessment === "no_vehicles");
    case "has_vehicles":
      return images.filter((img) => img.analysis.car_count > 0);
    default:
      return images;
  }
}

function refreshList() {
  const sortKey = document.getElementById("sort-select").value;
  const filterKey = document.getElementById("filter-select").value;
  const sorted = applySort(allImages, sortKey);
  filteredImages = applyFilter(sorted, filterKey);
  currentIndex = 0;
  document.getElementById("filter-count").textContent = `${filteredImages.length} of ${allImages.length}`;
  renderCurrent();
}

// ───────── Rendering ─────────

function renderCurrent() {
  if (filteredImages.length === 0) {
    document.getElementById("counter").textContent = "0 / 0";
    document.getElementById("street-img").src = "";
    document.getElementById("bbox-overlay").innerHTML = "";
    document.getElementById("stat-grid").innerHTML = "<em>No images match filter</em>";
    return;
  }
  const img = filteredImages[currentIndex];
  document.getElementById("counter").textContent = `${currentIndex + 1} / ${filteredImages.length}`;

  // Image
  document.getElementById("street-img").src = `${IMAGE_BASE}/${img.filename}`;

  // Bounding boxes
  const overlay = document.getElementById("bbox-overlay");
  overlay.innerHTML = img.detections
    .map((d, i) => {
      const [x1, y1, x2, y2] = d.bbox;
      const left = x1 * SCALE;
      const top = y1 * SCALE;
      const width = (x2 - x1) * SCALE;
      const height = (y2 - y1) * SCALE;
      return `<div class="det-box side-${d.side}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;" title="${d.class} ${(d.confidence * 100).toFixed(0)}%">
        <span class="det-box-label">${d.class} ${(d.confidence * 100).toFixed(0)}%</span>
      </div>`;
    })
    .join("");

  // Side labels
  document.getElementById("label-left").textContent = `← L: ${img.analysis.left_count}`;
  document.getElementById("label-right").textContent = `R: ${img.analysis.right_count} →`;

  // Meta line
  const vp = img.viewpoint;
  const vpText = vp ? `${vp.lat.toFixed(5)}, ${vp.lon.toFixed(5)}` : "—";
  document.getElementById("image-meta").innerHTML =
    `<strong>${img.filename}</strong> · segment ${img.segment_id || "?"} · ${img.direction || "?"} · heading ${img.heading != null ? img.heading.toFixed(0) + "°" : "?"} · ${vpText}` +
    (img.road_width_m ? ` · road ${img.road_width_m.toFixed(1)} m wide` : "");

  // Stats
  const a = img.analysis;
  const scoreClass = a.parking_score >= 0.4 ? "score-high" : a.parking_score >= 0.2 ? "score-mid" : "score-low";
  document.getElementById("stat-grid").innerHTML = `
    <div class="stat-item"><span class="stat-value">${a.car_count}</span><span class="stat-label">Vehicles</span></div>
    <div class="stat-item"><span class="stat-value ${scoreClass}">${a.parking_score.toFixed(2)}</span><span class="stat-label">Parking score</span></div>
    <div class="stat-item"><span class="stat-value" style="color:#22c55e">${a.left_count}</span><span class="stat-label">Left side</span></div>
    <div class="stat-item"><span class="stat-value" style="color:#3b82f6">${a.right_count}</span><span class="stat-label">Right side</span></div>
    <div class="stat-item"><span class="stat-value" style="color:#94a3b8">${a.center_count}</span><span class="stat-label">Center / road</span></div>
    <div class="stat-item"><span class="stat-value">${a.avg_car_area_px > 0 ? Math.round(a.avg_car_area_px) : "—"}</span><span class="stat-label">Avg car area (px²)</span></div>
  `;

  // Assessment
  const assessClass = a.parking_assessment === "likely_parking" ? "likely" : a.parking_assessment === "possible_parking" ? "possible" : "none";
  const assessLabel = {
    likely_parking: "Likely parking",
    possible_parking: "Possible parking",
    no_clear_signal: "No clear signal",
    no_vehicles: "No vehicles detected",
  }[a.parking_assessment] || a.parking_assessment;
  document.getElementById("assessment-detail").innerHTML = `
    <span class="assessment-tag ${assessClass}">${assessLabel}</span>
    <div class="assessment-detail-row"><strong>Dominant side:</strong> ${a.dominant_side}</div>
    <div class="assessment-detail-row"><strong>Pattern:</strong> ${a.pattern}</div>
    <div class="assessment-detail-row"><strong>Size std dev:</strong> ${a.car_area_std_px > 0 ? Math.round(a.car_area_std_px) + " px²" : "—"}</div>
  `;

  // Detection table
  document.getElementById("detection-count").textContent = img.detections.length;
  document.getElementById("det-tbody").innerHTML = img.detections
    .map((d, i) => `<tr>
      <td>${i + 1}</td>
      <td>${d.class}</td>
      <td>${(d.confidence * 100).toFixed(0)}%</td>
      <td><span class="side-tag ${d.side}">${d.side}</span></td>
      <td>${Math.round(d.w_px)}×${Math.round(d.h_px)}</td>
      <td>${d.aspect_ratio.toFixed(1)}</td>
    </tr>`)
    .join("");
}

// ───────── Navigation ─────────

function goNext() {
  if (filteredImages.length === 0) return;
  currentIndex = (currentIndex + 1) % filteredImages.length;
  renderCurrent();
}

function goPrev() {
  if (filteredImages.length === 0) return;
  currentIndex = (currentIndex - 1 + filteredImages.length) % filteredImages.length;
  renderCurrent();
}

// ───────── Init ─────────

async function init() {
  try {
    const data = await loadData();
    allImages = data.images || [];
    document.getElementById("loading").classList.add("hidden");
    refreshList();

    // Wire controls
    document.getElementById("btn-prev").addEventListener("click", goPrev);
    document.getElementById("btn-next").addEventListener("click", goNext);
    document.getElementById("sort-select").addEventListener("change", refreshList);
    document.getElementById("filter-select").addEventListener("change", refreshList);

    // Keyboard navigation
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); goNext(); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); goPrev(); }
    });
  } catch (err) {
    document.getElementById("loading").textContent = `Error: ${err.message}`;
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", init);
