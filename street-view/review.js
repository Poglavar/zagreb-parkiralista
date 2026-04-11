// Reviewer for parking area polygons. Loads data from the parking API, not from local JSON bundles.
import { activeParkingPolygons } from "./scripts/lib/osm-submit.mjs";
import { chooseParkingPolygonKeys, toLatLngPath } from "./scripts/lib/review-map.mjs";

const PARKING_API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:3001/api/parking"
  : "/parkiralista/api/parking";
const CDOF_WMS_URL = "https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/GradZagreb_CDOF2022_Public/ows";
const OSM_PARKING_URL = "./data/osm/parking_zagreb.geojson";

const state = {
  segments: [],
  formPreview: null,
  isPopulatingForm: false,
  map: { instance: null, satellite: null, tileLayer: null, overlayLayer: null, satelliteOverlay: null, dragState: null },
  index: 0,
  filters: { search: "", review: "all" }
};

const els = {
  areaSelect: document.getElementById("areaSelect"),
  reviewFilterField: document.getElementById("reviewFilterField"),
  captureGrid: document.getElementById("captureGrid"),
  segmentTitle: document.getElementById("segmentTitle"),
  segmentMeta: document.getElementById("segmentMeta"),
  diagramShell: document.getElementById("diagramShell"),
  segmentMap: document.getElementById("segmentMap"),
  satelliteMap: document.getElementById("satelliteMap"),
  osmSubmitStatus: document.getElementById("osmSubmitStatus"),
  leftConfidenceDisplay: document.getElementById("leftConfidenceDisplay"),
  rightConfidenceDisplay: document.getElementById("rightConfidenceDisplay"),
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  acceptAiButton: document.getElementById("acceptAiButton"),
  suspectButton: document.getElementById("suspectButton"),
  overrideForm: document.getElementById("overrideForm"),
  decisionField: document.getElementById("decisionField"),
  confidenceField: document.getElementById("confidenceField"),
  leftPresentField: document.getElementById("leftPresentField"),
  leftMannerField: document.getElementById("leftMannerField"),
  leftLevelField: document.getElementById("leftLevelField"),
  leftFormalityField: document.getElementById("leftFormalityField"),
  leftConfidenceField: document.getElementById("leftConfidenceField"),
  rightPresentField: document.getElementById("rightPresentField"),
  rightMannerField: document.getElementById("rightMannerField"),
  rightLevelField: document.getElementById("rightLevelField"),
  rightFormalityField: document.getElementById("rightFormalityField"),
  rightConfidenceField: document.getElementById("rightConfidenceField"),
  reviewerNotesField: document.getElementById("reviewerNotesField")
};

function formatNumber(value, fractionDigits = 1) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(fractionDigits);
}

function setOsmStatus(html, tone = "muted") {
  els.osmSubmitStatus.className = `summary-block ${tone}`;
  els.osmSubmitStatus.innerHTML = html;
}

// --- Data loading from API ---

async function loadAreaList() {
  try {
    const resp = await fetch(`${PARKING_API_BASE}/meta`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.areas || [];
  } catch (err) {
    console.error("Failed to load area list:", err.message);
    return [];
  }
}

// Transform API features (one per segment+side) into grouped segment objects
// that the rest of the viewer expects.
function groupFeaturesIntoSegments(fc) {
  const bySegment = new Map();

  for (const feature of fc.features) {
    const p = feature.properties;
    const segId = p.segment_id;
    if (!bySegment.has(segId)) {
      bySegment.set(segId, {
        segment_id: segId,
        label: p.tags?.label || segId,
        width_m: p.width_m || 0,
        length_m: p.length_m || 0,
        area_labels: p.area_labels || [],
        captures: p.captures || [],
        geometry: p.segment_geometry || null,
        review_status: p.review_status,
        sides: {}
      });
    }
    const seg = bySegment.get(segId);
    seg.sides[p.side] = {
      polygon: feature.geometry,
      tags: p.tags || {},
      confidence: p.confidence,
      review_status: p.review_status,
      version: p.version,
      provider: p.provider,
      model: p.model
    };
    // Use the worst review_status for the segment-level display
    if (p.review_status === "pending" || seg.review_status === "pending") {
      seg.review_status = "pending";
    } else if (p.review_status === "suspect") {
      seg.review_status = "suspect";
    }
  }

  return [...bySegment.values()];
}

async function loadArea(areaName) {
  const params = new URLSearchParams();
  if (areaName && areaName !== "all") params.set("area", areaName);
  const statusFilter = els.reviewFilterField.value;
  if (statusFilter && statusFilter !== "all") params.set("review_status", statusFilter);

  try {
    const resp = await fetch(`${PARKING_API_BASE}/areas?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const fc = await resp.json();
    state.segments = groupFeaturesIntoSegments(fc);
    // Sort: pending first, then suspect, then confirmed
    state.segments.sort((a, b) => {
      const order = { pending: 0, suspect: 1, confirmed: 2 };
      return (order[a.review_status] ?? 1) - (order[b.review_status] ?? 1);
    });
    state.index = 0;
    state.formPreview = null;
    console.log(`Loaded ${state.segments.length} segments for area: ${areaName || "all"}`);
    renderAllPolygons();
    render();
  } catch (err) {
    console.error("Failed to load area:", err.message);
    setOsmStatus(`Failed to load data: ${err.message}`, "needs-attention");
  }
}

// --- Segment accessors ---

function currentSegment() {
  return state.segments[state.index] || null;
}

function sideAssessmentFromSegment(segment, side) {
  const sideData = segment?.sides?.[side];
  if (!sideData) return { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0, evidence: [] };
  return {
    parking_present: true,
    parking_manner: sideData.tags?.parking_manner || "parallel",
    parking_level: sideData.tags?.parking_level || "road_level",
    formality: sideData.tags?.formality || "unknown",
    confidence: sideData.confidence || 0,
    evidence: []
  };
}

function segmentAssessment(segment) {
  if (!segment) return null;
  if (state.formPreview?.segmentId === segment.segment_id) return state.formPreview.assessment;
  const left = sideAssessmentFromSegment(segment, "left");
  const right = sideAssessmentFromSegment(segment, "right");
  const hasLeft = left.parking_present;
  const hasRight = right.parking_present;
  return {
    decision: hasLeft && hasRight ? "both" : hasLeft ? "left" : hasRight ? "right" : "none",
    confidence: Math.min(left.confidence || 0, right.confidence || 0),
    overall_notes: "",
    segment_left: left,
    segment_right: right
  };
}

function segmentPolygonRings(segment, side) {
  const sideData = segment?.sides?.[side];
  if (!sideData?.polygon) return [];
  const coords = sideData.polygon.coordinates;
  // GeoJSON Polygon has coordinates as array of rings
  return coords.map((ring) => ring);
}

function effectivePolygonRings(segment, assessment, side) {
  const overrides = state.formPreview?.segmentId === segment?.segment_id ? state.formPreview.polygonOverrides : null;
  if (overrides?.[side]) {
    const o = overrides[side];
    return Array.isArray(o[0]?.[0]) ? o : [o];
  }
  return segmentPolygonRings(segment, side);
}

function effectivePolygonCoords(segment, assessment, side) {
  const rings = effectivePolygonRings(segment, assessment, side);
  return rings.length > 0 ? rings[0] : null;
}

function defaultPolygonCoords(segment, assessment, side) {
  return effectivePolygonCoords(segment, assessment, side);
}

// --- Form ---

function deriveDecision() {
  const left = els.leftPresentField.checked;
  const right = els.rightPresentField.checked;
  if (left && right) return "both";
  if (left) return "left";
  if (right) return "right";
  return "none";
}

function formAssessment() {
  return {
    decision: deriveDecision(),
    confidence: Number(els.confidenceField.value || 0),
    overall_notes: "",
    segment_left: {
      parking_present: els.leftPresentField.checked,
      parking_manner: els.leftMannerField.value,
      parking_level: els.leftLevelField.value,
      formality: els.leftFormalityField.value,
      confidence: Number(els.leftConfidenceField.value || 0),
      evidence: []
    },
    segment_right: {
      parking_present: els.rightPresentField.checked,
      parking_manner: els.rightMannerField.value,
      parking_level: els.rightLevelField.value,
      formality: els.rightFormalityField.value,
      confidence: Number(els.rightConfidenceField.value || 0),
      evidence: []
    }
  };
}

function populateForm(segment) {
  state.isPopulatingForm = true;
  const assessment = segmentAssessment(segment) || {
    decision: "none", confidence: 0, segment_left: { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0 },
    segment_right: { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0 }
  };
  els.leftPresentField.checked = assessment.segment_left.parking_present;
  els.leftMannerField.value = assessment.segment_left.parking_manner;
  els.leftLevelField.value = assessment.segment_left.parking_level;
  els.leftFormalityField.value = assessment.segment_left.formality;
  els.leftConfidenceField.value = assessment.segment_left.confidence;
  els.leftConfidenceDisplay.textContent = `conf ${formatNumber(assessment.segment_left.confidence, 2)}`;
  els.rightPresentField.checked = assessment.segment_right.parking_present;
  els.rightMannerField.value = assessment.segment_right.parking_manner;
  els.rightLevelField.value = assessment.segment_right.parking_level;
  els.rightFormalityField.value = assessment.segment_right.formality;
  els.rightConfidenceField.value = assessment.segment_right.confidence;
  els.rightConfidenceDisplay.textContent = `conf ${formatNumber(assessment.segment_right.confidence, 2)}`;
  els.confidenceField.value = assessment.confidence;
  els.decisionField.value = assessment.decision;
  state.isPopulatingForm = false;
}

function ensurePreviewState(segment) {
  if (!segment) return null;
  if (state.formPreview?.segmentId === segment.segment_id) return state.formPreview;
  return { segmentId: segment.segment_id, assessment: formAssessment(), polygonOverrides: {} };
}

function setPolygonPreview(side, ring) {
  const segment = currentSegment();
  if (!segment) return;
  const preview = ensurePreviewState(segment);
  preview.polygonOverrides = { ...(preview.polygonOverrides || {}), [side]: ring };
  preview.assessment = formAssessment();
  state.formPreview = preview;
  updateConfirmButton(segment);
  setOsmStatus("Nespremljeni promjene — kliknite Potvrdi ili Sumnjivo.", "needs-attention");
}

function updateConfirmButton(segment) {
  const status = !state.formPreview ? segment?.review_status : null;
  const isConfirmed = status === "confirmed";
  els.acceptAiButton.textContent = isConfirmed ? "Potvrđeno" : "Potvrdi";
  els.acceptAiButton.classList.toggle("btn-confirmed", isConfirmed);
  els.acceptAiButton.classList.toggle("btn-confirm", !isConfirmed);
  const isSuspect = status === "suspect";
  els.suspectButton.textContent = isSuspect ? "Označeno sumnjivim" : "Sumnjivo";
  els.suspectButton.classList.toggle("btn-suspect-active", isSuspect);
}

function updateFormPreview() {
  const segment = currentSegment();
  if (!segment || state.isPopulatingForm) return;
  const preview = ensurePreviewState(segment);
  state.formPreview = { segmentId: segment.segment_id, assessment: formAssessment(), polygonOverrides: { ...(preview?.polygonOverrides || {}) } };
  updateConfirmButton(segment);
  renderSelection(segment);
}

// --- Rendering ---

function renderMeta(segment) {
  els.segmentTitle.textContent = segment.label || segment.segment_id;
  const parts = [
    `#${segment.segment_id}`,
    segment.length_m ? `${formatNumber(segment.length_m)}m` : null,
    segment.width_m ? `w ${formatNumber(segment.width_m, 2)}m` : null,
    segment.review_status,
    ...(segment.area_labels || [])
  ].filter(Boolean);
  els.segmentMeta.innerHTML = `<span class="meta-inline">${parts.join(" · ")}</span>`;
}

function renderCaptures(segment) {
  els.captureGrid.innerHTML = "";
  const captures = segment.captures || [];
  if (!captures.length) return;

  for (const cap of captures) {
    const card = document.createElement("article");
    card.className = "capture-card";

    const isForward = cap.direction === "forward";
    // In forward images: image-left = segment-left (L), image-right = segment-right (D)
    // In reverse images: image-left = segment-right (D), image-right = segment-left (L)
    const imgLeftSide = isForward ? "left" : "right";
    const imgRightSide = isForward ? "right" : "left";
    const imgLeftLabel = isForward ? "L" : "D";
    const imgRightLabel = isForward ? "D" : "L";

    const media = document.createElement("div");
    media.className = "capture-media";
    if (cap.image_path) {
      const img = document.createElement("img");
      img.src = cap.image_path;
      img.alt = `${cap.capture_id}`;
      media.appendChild(img);
    }
    media.insertAdjacentHTML("beforeend",
      `<span class="capture-overlay capture-overlay-left side-${imgLeftSide}">${imgLeftLabel}</span>` +
      `<span class="capture-overlay capture-overlay-right side-${imgRightSide}">${imgRightLabel}</span>`
    );
    card.appendChild(media);

    const meta = document.createElement("div");
    meta.className = "capture-meta";
    meta.innerHTML = `
      <p><strong>${cap.capture_id}</strong> · ${cap.direction} · ${formatNumber(cap.heading)}°</p>
      ${cap.maps_url ? `<p><a href="${cap.maps_url}" target="_blank" rel="noopener">Otvori panoramu</a></p>` : ""}
    `;
    card.appendChild(meta);
    els.captureGrid.appendChild(card);
  }
}

function visibleSegmentIndexes() {
  const search = state.filters.search.trim().toLowerCase();
  return state.segments
    .map((seg, i) => ({ seg, i }))
    .filter(({ seg }) => {
      if (search) {
        const hay = [seg.segment_id, seg.label, ...(seg.area_labels || [])].join(" ").toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    })
    .map(({ i }) => i);
}

function renderSegmentList() {
  const visible = visibleSegmentIndexes();
  els.segmentCount.textContent = `${visible.length} segmenata`;
  els.segmentList.innerHTML = "";

  for (const index of visible) {
    const seg = state.segments[index];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `segment-chip ${index === state.index ? "active" : ""}`;
    const sides = Object.keys(seg.sides).join("+") || "—";
    const statusLabelsChip = { pending: "na čekanju", confirmed: "potvrđeno", suspect: "sumnjivo" };
    const statusClass = seg.review_status === "confirmed" ? "reviewed" : seg.review_status === "pending" ? "needs-review" : "";
    btn.innerHTML = `
      <div class="chip-topline">
        <strong>${seg.label || seg.segment_id}</strong>
        <span class="chip-badge ${statusClass}">${statusLabelsChip[seg.review_status] || seg.review_status}</span>
      </div>
      <div class="chip-footline">
        <span>#${seg.segment_id} · ${sides}</span>
        <span class="muted">${formatNumber(seg.sides?.left?.confidence || seg.sides?.right?.confidence, 2)}</span>
      </div>
    `;
    btn.addEventListener("click", () => selectSegment(index));
    els.segmentList.appendChild(btn);
  }
}

// --- Map ---

function leafletColorForSide(side) {
  return side === "left" ? { stroke: "#9a3412", fill: "#f59e0b" } : { stroke: "#1d4ed8", fill: "#3b82f6" };
}

function bgColorForSegment(seg, side) {
  const isSuspect = seg.review_status === "suspect";
  const isConfirmed = seg.review_status === "confirmed";
  const color = isSuspect ? "#b45309" : isConfirmed ? "#64748b" : (side === "left" ? "#9a3412" : "#1d4ed8");
  const fill = isSuspect ? "#fbbf24" : isConfirmed ? "#cbd5e1" : (side === "left" ? "#f59e0b" : "#3b82f6");
  const fillOpacity = isConfirmed ? 0.25 : 0.3;
  return { color, fill, fillOpacity, dashArray: isSuspect ? "4 3" : null };
}

function midpointLatLng(a, b) {
  return [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2];
}

function cloneRing(ring) {
  return (ring || []).map(([lon, lat]) => [lon, lat]);
}

function translateRing(ring, dLon, dLat) {
  return ring.map(([lon, lat]) => [lon + dLon, lat + dLat]);
}

function ringHalf(ring) { return Math.floor((ring.length - 1) / 2); }

function movePolygonEdge(ring, edge, dLon, dLat) {
  const next = cloneRing(ring);
  const half = ringHalf(ring);
  const last = next.length - 2;
  if (edge === "start") { next[0][0] += dLon; next[0][1] += dLat; next[last][0] += dLon; next[last][1] += dLat; }
  else if (edge === "end") { next[half - 1][0] += dLon; next[half - 1][1] += dLat; next[half][0] += dLon; next[half][1] += dLat; }
  next[next.length - 1] = [...next[0]];
  return next;
}

function edgePosition(ring, edge) {
  const half = ringHalf(ring);
  const last = ring.length - 2;
  return edge === "start" ? midpointLatLng(ring[0], ring[last]) : midpointLatLng(ring[half - 1], ring[half]);
}

const editablePolygons = {};

function applyEditablePolygonRing(side, ring) {
  const path = toLatLngPath(ring);
  const entry = editablePolygons[side];
  if (!entry) return;
  for (const layer of entry.layers) layer.setLatLngs(path);
  for (const h of entry.handleSets) {
    h.currentRing = cloneRing(ring);
    h.start.setLatLng(edgePosition(ring, "start"));
    h.end.setLatLng(edgePosition(ring, "end"));
  }
  setPolygonPreview(side, ring);
}

function currentRingForSide(side) { return editablePolygons[side]?.handleSets[0]?.currentRing || null; }

function stopMapDrag() {
  const drag = state.map.dragState;
  if (drag?.sourceMap) { drag.sourceMap.dragging.enable(); drag.sourceMap.off("mousemove", onMapDragMove); drag.sourceMap.off("mouseup", stopMapDrag); }
  window.removeEventListener("mouseup", stopMapDrag);
  state.map.dragState = null;
}

function onMapDragMove(event) {
  const drag = state.map.dragState;
  if (!drag) return;
  const dLon = event.latlng.lng - drag.startLatLng.lng;
  const dLat = event.latlng.lat - drag.startLatLng.lat;
  const next = drag.mode === "move" ? translateRing(drag.originalRing, dLon, dLat) : movePolygonEdge(drag.originalRing, drag.edge, dLon, dLat);
  applyEditablePolygonRing(drag.side, next);
}

function startMapDrag({ side, mode, edge = null, ring, startLatLng, sourceMap }) {
  state.map.dragState = { side, mode, edge, originalRing: cloneRing(ring), startLatLng, sourceMap };
  sourceMap.dragging.disable();
  sourceMap.on("mousemove", onMapDragMove);
  sourceMap.on("mouseup", stopMapDrag);
  window.addEventListener("mouseup", stopMapDrag, { once: true });
}

function createEdgeHandle(side, edge, ring, parentMap) {
  const marker = window.L.marker(edgePosition(ring, edge), {
    draggable: true, keyboard: false,
    icon: window.L.divIcon({ className: `edge-handle edge-handle-${side} edge-handle-${edge}`, iconSize: [14, 14] })
  });
  const ds = { startLatLng: null, originalRing: null };
  marker.on("dragstart", (e) => { ds.startLatLng = e.target.getLatLng(); ds.originalRing = cloneRing(currentRingForSide(side)); parentMap.dragging.disable(); });
  marker.on("drag", (e) => { const c = e.target.getLatLng(); applyEditablePolygonRing(side, movePolygonEdge(ds.originalRing, edge, c.lng - ds.startLatLng.lng, c.lat - ds.startLatLng.lat)); });
  marker.on("dragend", () => parentMap.dragging.enable());
  return marker;
}

function addPolygonToLayer(ring, sideKey, active, layer) {
  if (!ring || ring.length < 4) return null;
  const c = leafletColorForSide(sideKey);
  const poly = window.L.polygon(toLatLngPath(ring), { color: c.stroke, weight: active ? 3 : 2, fillColor: c.fill, fillOpacity: active ? 0.32 : 0.12 });
  poly.addTo(layer);
  return poly;
}

function ensureLeafletMap() {
  if (!window.L) return null;
  if (!state.map.instance) {
    const mapOpts = { zoomControl: true, attributionControl: true, preferCanvas: true, scrollWheelZoom: true, zoomSnap: 0.25, zoomDelta: 0.5 };
    state.map.instance = window.L.map(els.segmentMap, mapOpts);
    state.map.tileLayer = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 22, maxNativeZoom: 19, attribution: "&copy; OSM" }).addTo(state.map.instance);

    state.map.satellite = window.L.map(els.satelliteMap, { ...mapOpts, zoomControl: false });
    window.L.tileLayer.wms(CDOF_WMS_URL, { layers: "ZG_CDOF2022", format: "image/jpeg", version: "1.1.1", transparent: false, maxZoom: 22, attribution: "CDOF 2022 &copy; Grad Zagreb" }).addTo(state.map.satellite);

    // Layers: background (all polygons) + selection (current segment details)
    state.map.bgLayer = window.L.featureGroup().addTo(state.map.instance);
    state.map.bgLayerSat = window.L.featureGroup().addTo(state.map.satellite);
    state.map.overlayLayer = window.L.featureGroup().addTo(state.map.instance);
    state.map.satelliteOverlay = window.L.featureGroup().addTo(state.map.satellite);

    let syncing = false;
    function sync(src, tgt) {
      src.on("moveend zoomend", () => { if (syncing) return; syncing = true; tgt.setView(src.getCenter(), src.getZoom(), { animate: false }); syncing = false; });
    }
    sync(state.map.instance, state.map.satellite);
    sync(state.map.satellite, state.map.instance);

    // Load OSM parking as a reference layer (below our polygons)
    fetch(OSM_PARKING_URL).then((r) => r.ok ? r.json() : null).then((fc) => {
      if (!fc?.features) return;
      const osmStyle = { radius: 3, weight: 0.5, color: "#475569", fillColor: "#94a3b8", fillOpacity: 0.4 };
      const polyStyle = { weight: 1, color: "#475569", fillColor: "#94a3b8", fillOpacity: 0.15 };
      const osmLayer = window.L.geoJSON(fc, {
        pointToLayer: (f, ll) => window.L.circleMarker(ll, osmStyle),
        style: () => polyStyle,
        onEachFeature: (f, l) => {
          const p = f.properties || {};
          l.bindTooltip(p.name || "OSM parking", { direction: "top", className: "segment-tooltip" });
        }
      });
      osmLayer.addTo(state.map.instance);
      osmLayer.addTo(state.map.satellite);
      // Move OSM layer behind our polygons
      osmLayer.bringToBack();
    }).catch(() => {});
  }
  state.map.instance.invalidateSize();
  state.map.satellite.invalidateSize();
  return state.map;
}

// Draw all segments' polygons as a clickable background layer. Called once per area load.
function renderAllPolygons() {
  const mc = ensureLeafletMap();
  if (!mc) return;

  mc.bgLayer.clearLayers();
  mc.bgLayerSat.clearLayers();

  for (let i = 0; i < state.segments.length; i += 1) {
    const seg = state.segments[i];
    const segIndex = i;
    for (const side of ["left", "right"]) {
      const rings = segmentPolygonRings(seg, side);
      for (const ring of rings) {
        const bc = bgColorForSegment(seg, side);
        const style = { color: bc.color, weight: 1.5, fillColor: bc.fill, fillOpacity: bc.fillOpacity, dashArray: bc.dashArray };

        const osmP = window.L.polygon(toLatLngPath(ring), style).addTo(mc.bgLayer);
        const satP = window.L.polygon(toLatLngPath(ring), style).addTo(mc.bgLayerSat);
        osmP._segIndex = segIndex;
        satP._segIndex = segIndex;

        osmP.on("click", () => selectSegment(segIndex));
      }
    }
  }

  // Fit map to all polygons only on initial area load, not on confirm/save
  if (!state.suppressMapFly) {
    const bounds = mc.bgLayer.getBounds();
    if (bounds.isValid()) mc.instance.fitBounds(bounds.pad(0.05));
  }
}

function selectSegment(index) {
  state.index = index;
  state.formPreview = null;
  render();
}

// Draw the selected segment's editable polygons, centerline, and viewpoints on the selection layer.
function renderSelection(segment) {
  const assessment = segmentAssessment(segment);
  const mc = ensureLeafletMap();
  if (!mc) return;

  mc.overlayLayer.clearLayers();
  mc.satelliteOverlay.clearLayers();
  editablePolygons.left = null;
  editablePolygons.right = null;

  // Hide background polygons for the selected segment, restore others
  const si = state.index;
  for (const bgL of [mc.bgLayer, mc.bgLayerSat]) {
    bgL.eachLayer((l) => {
      if (l._segIndex === si) {
        l.setStyle({ opacity: 0, fillOpacity: 0 });
      } else if (l.options.opacity === 0) {
        const seg = state.segments[l._segIndex];
        if (seg) {
          const bc = bgColorForSegment(seg, "left");
          l.setStyle({ opacity: 1, fillOpacity: bc.fillOpacity });
        }
      }
    });
  }

  for (const side of ["left", "right"]) {
    const sideA = side === "left" ? assessment?.segment_left : assessment?.segment_right;
    if (!sideA?.parking_present) continue;
    const rings = effectivePolygonRings(segment, assessment, side);

    rings.forEach((ring, ri) => {
      const osmP = addPolygonToLayer(ring, side, true, mc.overlayLayer);
      const satP = addPolygonToLayer(ring, side, true, mc.satelliteOverlay);

      if (osmP && satP && ri === 0) {
        const entry = { layers: [osmP, satP], handleSets: [] };
        for (const [map, layer] of [[mc.instance, mc.overlayLayer], [mc.satellite, mc.satelliteOverlay]]) {
          const hs = { currentRing: cloneRing(ring) };
          hs.start = createEdgeHandle(side, "start", ring, map).addTo(layer);
          hs.end = createEdgeHandle(side, "end", ring, map).addTo(layer);
          entry.handleSets.push(hs);
        }
        editablePolygons[side] = entry;
        for (const [poly, srcMap] of [[osmP, mc.instance], [satP, mc.satellite]]) {
          poly.on("mousedown", (e) => { window.L.DomEvent.stop(e); startMapDrag({ side, mode: "move", ring: currentRingForSide(side), startLatLng: e.latlng, sourceMap: srcMap }); });
        }
      }
    });
  }

  // Segment centerline
  if (segment.geometry) {
    const path = toLatLngPath(segment.geometry.coordinates);
    const style = { color: "#122033", weight: 4, opacity: 0.85 };
    window.L.polyline(path, style).addTo(mc.overlayLayer);
    window.L.polyline(path, style).addTo(mc.satelliteOverlay);
  }

  // Viewpoint markers
  const stations = new Map();
  for (const cap of segment.captures || []) {
    if (!cap.viewpoint) continue;
    const key = cap.station_index ?? cap.capture_id;
    if (!stations.has(key)) stations.set(key, { viewpoint: cap.viewpoint, captureIds: [] });
    stations.get(key).captureIds.push(cap.capture_id);
  }
  for (const [, station] of stations) {
    const pos = [station.viewpoint.lat, station.viewpoint.lon];
    const opts = { radius: 7, weight: 2, color: "#122033", fillColor: "#e2e8f0", fillOpacity: 0.9 };
    const ids = station.captureIds;
    function onClick() {
      const cards = els.captureGrid.querySelectorAll(".capture-card");
      cards.forEach((c) => c.classList.remove("capture-highlight"));
      let first = null;
      for (const c of cards) {
        if (ids.includes(c.querySelector("strong")?.textContent)) { c.classList.add("capture-highlight"); if (!first) first = c; }
      }
      if (first) first.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    window.L.circleMarker(pos, opts).bindTooltip(ids.join(" + "), { direction: "top", offset: [0, -4], className: "segment-tooltip" }).on("click", onClick).addTo(mc.overlayLayer);
    window.L.circleMarker(pos, opts).on("click", onClick).addTo(mc.satelliteOverlay);
  }

  // Pan to selected segment unless suppressed (e.g. after confirm)
  if (!state.suppressMapFly) {
    const bounds = mc.overlayLayer.getBounds();
    if (bounds.isValid()) mc.instance.flyToBounds(bounds.pad(0.08), { maxZoom: 21, duration: 0.4 });
  }
  state.suppressMapFly = false;
}

// --- Render ---

function renderEmptyState() {
  els.segmentTitle.textContent = "Nema segmenata";
  els.segmentMeta.innerHTML = "";
  els.prevButton.disabled = true;
  els.nextButton.disabled = true;
  setOsmStatus("Nema parkirnih zona za odabrano područje/filter.", "muted");
}

function render() {
  if (!state.segments.length) { renderEmptyState(); return; }

  const visible = visibleSegmentIndexes();
  if (!visible.includes(state.index)) state.index = visible[0] ?? 0;

  if (!visible.length) { renderEmptyState(); return; }

  const segment = currentSegment();
  renderMeta(segment);
  renderCaptures(segment);
  populateForm(segment);
  updateConfirmButton(segment);
  renderSelection(segment);

  const pos = visible.indexOf(state.index);
  els.prevButton.disabled = pos <= 0;
  els.nextButton.disabled = pos >= visible.length - 1;

  const hasSides = Object.keys(segment.sides || {}).length;
  const statusLabels = { pending: "na čekanju", confirmed: "potvrđeno", suspect: "sumnjivo" };
  setOsmStatus(`${hasSides} strana · ${statusLabels[segment.review_status] || segment.review_status}`, "muted");
}

function stepVisible(dir) {
  const visible = visibleSegmentIndexes();
  const pos = visible.indexOf(state.index);
  const next = pos + dir;
  if (next >= 0 && next < visible.length) { state.index = visible[next]; state.formPreview = null; render(); }
}

// --- Save to API ---

async function saveReview(reviewStatus, suspectReason = null) {
  const segment = currentSegment();
  if (!segment) return;

  const assessment = formAssessment();
  const polyOverrides = state.formPreview?.polygonOverrides || null;
  state.formPreview = null;

  const polygons = activeParkingPolygons(
    { ...segment, preview_polygons: {} },
    assessment,
    (seg, assess, side) => polyOverrides?.[side] || effectivePolygonCoords(segment, assess, side)
  );

  els.acceptAiButton.disabled = true;
  els.suspectButton.disabled = true;
  let apiOk = true;

  for (const polygon of polygons) {
    const sa = polygon.side === "left" ? assessment.segment_left : assessment.segment_right;
    try {
      const resp = await fetch(`${PARKING_API_BASE}/areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segment_id: String(segment.segment_id),
          side: polygon.side,
          geom: { type: "Polygon", coordinates: [polygon.ring] },
          tags: { parking_manner: sa.parking_manner, parking_level: sa.parking_level, formality: sa.formality, label: segment.label },
          confidence: sa.confidence,
          review_status: reviewStatus,
          suspect_reason: suspectReason,
          active: true,
          updated_by: "street-view-reviewer"
        })
      });
      if (!resp.ok) { console.error(`API save failed ${segment.segment_id}/${polygon.side}:`, await resp.text()); apiOk = false; }
      else console.log(`Saved ${segment.segment_id}/${polygon.side} [${reviewStatus}]`);
    } catch (err) { console.error(`API error ${segment.segment_id}/${polygon.side}:`, err.message); apiOk = false; }
  }

  els.acceptAiButton.disabled = false;
  els.suspectButton.disabled = false;

  // Update local state to reflect new status and polygon geometry
  segment.review_status = reviewStatus;
  for (const polygon of polygons) {
    if (!segment.sides[polygon.side]) {
      segment.sides[polygon.side] = {};
    }
    segment.sides[polygon.side].polygon = { type: "Polygon", coordinates: [polygon.ring] };
    segment.sides[polygon.side].review_status = reviewStatus;
    segment.sides[polygon.side].tags = {
      parking_manner: (polygon.side === "left" ? assessment.segment_left : assessment.segment_right).parking_manner,
      parking_level: (polygon.side === "left" ? assessment.segment_left : assessment.segment_right).parking_level,
      formality: (polygon.side === "left" ? assessment.segment_left : assessment.segment_right).formality,
      label: segment.label
    };
    segment.sides[polygon.side].confidence = (polygon.side === "left" ? assessment.segment_left : assessment.segment_right).confidence;
  }

  if (!apiOk) setOsmStatus("Spremanje na API nije uspjelo — provjerite konzolu.", "needs-attention");
  state.suppressMapFly = true;
  renderAllPolygons();
  render();
}

// --- Init ---

async function init() {
  // Load area list and populate dropdown
  const areas = await loadAreaList();
  const totals = areas.reduce((t, a) => ({ p: t.p + Number(a.pending_count), c: t.c + Number(a.confirmed_count), s: t.s + Number(a.suspect_count) }), { p: 0, c: 0, s: 0 });
  els.areaSelect.innerHTML = `<option value="all">Sva područja (${totals.c} potvrđeno, ${totals.p} čeka, ${totals.s} sumnjivo)</option>`;
  for (const a of areas) {
    const opt = document.createElement("option");
    opt.value = a.label;
    opt.textContent = `${a.label} (${a.pending_count}p / ${a.confirmed_count}c / ${a.suspect_count}s)`;
    els.areaSelect.appendChild(opt);
  }

  // Load initial data
  await loadArea(els.areaSelect.value);

  // Events
  els.areaSelect.addEventListener("change", () => loadArea(els.areaSelect.value));
  els.reviewFilterField.addEventListener("change", () => loadArea(els.areaSelect.value));
  els.prevButton.addEventListener("click", () => stepVisible(-1));
  els.nextButton.addEventListener("click", () => stepVisible(1));
  els.acceptAiButton.addEventListener("click", () => saveReview("confirmed"));
  const suspectModal = document.getElementById("suspectModal");
  const suspectReasonField = document.getElementById("suspectReasonField");
  els.suspectButton.addEventListener("click", () => {
    suspectReasonField.value = "";
    suspectModal.hidden = false;
    suspectReasonField.focus();
  });
  document.getElementById("suspectModalCancel").addEventListener("click", () => {
    suspectModal.hidden = true;
  });
  document.getElementById("suspectModalConfirm").addEventListener("click", () => {
    suspectModal.hidden = true;
    saveReview("suspect", suspectReasonField.value.trim() || null);
  });
  suspectReasonField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("suspectModalConfirm").click(); }
    if (e.key === "Escape") { suspectModal.hidden = true; }
  });

  [els.leftPresentField, els.leftMannerField, els.leftLevelField, els.leftFormalityField,
   els.rightPresentField, els.rightMannerField, els.rightLevelField, els.rightFormalityField
  ].forEach((field) => {
    field.addEventListener("input", updateFormPreview);
    field.addEventListener("change", updateFormPreview);
  });
}

init().catch((err) => {
  document.body.innerHTML = `<main style="padding:2rem;font-family:Georgia,serif;"><h1>Preglednik nedostupan</h1><p>${err.message}</p><p>Je li parking API pokrenut?</p></main>`;
});
