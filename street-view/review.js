// Reviewer for parking area polygons. Loads data from the parking API, not from local JSON bundles.
import { activeParkingPolygons } from "./scripts/lib/osm-submit.mjs";
import { buildParkingSidePolygons } from "./scripts/lib/parking.mjs";
import { interpolateAlongPolyline, polylineLengthMeters } from "./scripts/lib/geo.mjs";
import { toLatLngPath } from "./scripts/lib/review-map.mjs";

const PARKING_API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:3001/api/parking"
  : "/parkiralista/api/parking";
// Aerial imagery sources (switch by swapping the tile layer in ensureLeafletMap)
const AERIAL_TMS_URL = "https://tms.osm-hr.org/zagreb-2018/{z}/{x}/{y}.png"; // DOF Zagreb 2018, TMS
// Fallback: const CDOF_WMS_URL = "https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/GradZagreb_CDOF2022_Public/ows";
const OSM_PARKING_URL = "./data/osm/parking_zagreb.geojson";

const state = {
  segments: [],
  formPreview: null,
  isPopulatingForm: false,
  editMode: false,
  manualAddMode: false,
  manualRing: null,
  manualHandles: null, // { a: [lon, lat], b: [lon, lat] }
  manualSegmentId: null, // set for new polygons, null when re-editing an existing manual segment
  prevIndex: null, // saved segment index when entering new-polygon mode (state.index becomes -1)
  map: { instance: null, satellite: null, tileLayer: null, overlayLayer: null, satelliteOverlay: null, dragState: null },
  index: 0,
  filters: { search: "", review: "all" }
};

const els = {
  areaSelect: document.getElementById("areaSelect"),
  reviewFilterField: document.getElementById("reviewFilterField"),
  captureGrid: document.getElementById("captureGrid"),
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
  reviewerNotesField: document.getElementById("reviewerNotesField"),
  undoButton: document.getElementById("undoButton"),
  addParkingButton: document.getElementById("addParkingButton"),
  leftFieldset: document.getElementById("leftFieldset"),
  rightFieldset: document.getElementById("rightFieldset"),
  sideFieldsetsWrapper: document.getElementById("sideFieldsetsWrapper"),
  manualFieldset: document.getElementById("manualFieldset"),
  manualPresentField: document.getElementById("manualPresentField"),
  manualMannerField: document.getElementById("manualMannerField"),
  manualLevelField: document.getElementById("manualLevelField"),
  manualFormalityField: document.getElementById("manualFormalityField")
};

function formatNumber(value, fractionDigits = 1) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(fractionDigits);
}

function setOsmStatus(html, tone = "muted") {
  els.osmSubmitStatus.className = `status-line ${tone}`;
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
  // Reviewer needs inactive areas for review; captures are loaded per-segment on selection
  params.set("include_inactive", "true");

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
    clearUndo();
    console.log(`Loaded ${state.segments.length} segments for area: ${areaName || "all"}`);
    populateSegmentDropdown();
    renderAllPolygons();
    render();
  } catch (err) {
    console.error("Failed to load area:", err.message);
    setOsmStatus(`Failed to load data: ${err.message}`, "needs-attention");
  }
}

// Fetch captures for a single segment from the per-segment endpoint and cache them.
async function ensureCaptures(segment) {
  if (!segment || segment.captures?.length > 0 || segment._capturesLoaded) return;
  try {
    const resp = await fetch(`${PARKING_API_BASE}/areas/${encodeURIComponent(segment.segment_id)}`);
    if (!resp.ok) { console.warn(`Failed to load captures for ${segment.segment_id}: HTTP ${resp.status}`); return; }
    const data = await resp.json();
    segment.captures = data.captures || [];
    segment._capturesLoaded = true;
  } catch (err) {
    console.warn(`Error loading captures for ${segment.segment_id}:`, err.message);
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
  // In manual add mode the L/R checkboxes are unchecked but meaningless — use saved data
  if (!state.manualAddMode && state.formPreview?.segmentId === segment.segment_id) return state.formPreview.assessment;
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

function recomputePolygonRings(segment, side, sideAssessment) {
  if (!segment?.geometry?.coordinates || !sideAssessment?.parking_present) return [];
  return buildParkingSidePolygons(segment.geometry.coordinates, {
    side,
    roadWidthM: segment.width_m || 7,
    parkingLevel: sideAssessment.parking_level,
    parkingManner: sideAssessment.parking_manner,
    endSetbackM: 3
  });
}

function effectivePolygonRings(segment, assessment, side) {
  const overrides = state.formPreview?.segmentId === segment?.segment_id ? state.formPreview.polygonOverrides : null;
  if (overrides?.[side]) {
    const o = overrides[side];
    return Array.isArray(o[0]?.[0]) ? o : [o];
  }
  // If form preview is active, recompute from the current form values
  if (state.formPreview?.segmentId === segment?.segment_id && assessment) {
    const sa = side === "left" ? assessment.segment_left : assessment.segment_right;
    const recomputed = recomputePolygonRings(segment, side, sa);
    if (recomputed.length > 0) return recomputed;
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

function updateSideFieldsetVisibility(segment) {
  if (!segment || state.manualAddMode) return;
  const isManualSegment = segment.segment_id?.startsWith("manual-");
  els.leftFieldset.hidden = isManualSegment || segment.sides?.left?.inactive === true;
  els.rightFieldset.hidden = isManualSegment || segment.sides?.right?.inactive === true;
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
  setOsmStatus("Svojstva izmjenjena — kliknite Potvrdi za spremanje", "needs-attention");
}

function updateConfirmButton(segment) {
  const status = !state.formPreview ? segment?.review_status : null;
  const isConfirmed = status === "confirmed";
  els.acceptAiButton.textContent = isConfirmed ? "Potvrđeno" : "Potvrdi";
  els.acceptAiButton.classList.remove("btn-delete");
  els.acceptAiButton.classList.toggle("btn-confirmed", isConfirmed);
  els.acceptAiButton.classList.toggle("btn-confirm", !isConfirmed);
  const isSuspect = status === "suspect";
  els.suspectButton.textContent = isSuspect ? "Označeno sumnjivim" : "Sumnjivo";
  els.suspectButton.classList.toggle("btn-suspect-active", isSuspect);
}

function updateFormPreview(changedSide) {
  const segment = currentSegment();
  if (!segment || state.isPopulatingForm) return;
  const prev = state.formPreview?.segmentId === segment.segment_id ? state.formPreview.polygonOverrides || {} : {};
  // Only clear the override for the side that changed; preserve the other side's drag position
  const overrides = { ...prev };
  if (changedSide) {
    delete overrides[changedSide];
  } else {
    // Unknown which side — clear both
    delete overrides.left;
    delete overrides.right;
  }
  state.formPreview = { segmentId: segment.segment_id, assessment: formAssessment(), polygonOverrides: overrides };
  updateConfirmButton(segment);
  renderSelection(segment);
  setOsmStatus("Svojstva izmjenjena — kliknite Potvrdi za spremanje", "needs-attention");
}

// --- Rendering ---

function renderMeta(segment) {
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
  if (side === "left") return { stroke: "#9a3412", fill: "#f59e0b" };
  if (side === "manual") return { stroke: "#166534", fill: "#dcfce7" }; // light green while drawing
  return { stroke: "#1d4ed8", fill: "#3b82f6" };
}

// Half-width in metres for each parking manner — matches bandWidthForManner in parking.mjs
function mannerHalfWidth(manner) {
  const CAR_LENGTH = 5.50;
  const CAR_WIDTH = 2.50;
  if (manner === "perpendicular") return CAR_LENGTH / 2;
  if (manner === "diagonal") return (Math.sin(45 * Math.PI / 180) * CAR_LENGTH) / 2;
  return CAR_WIDTH / 2; // parallel, mixed, unknown
}

// Build a rectangle ring from two handle positions (midpoints of the two short ends).
// The long sides are parallel to the a→b axis; short ends pass through a and b.
function buildRectFromHandles(a, b, halfWidthM) {
  const [aLon, aLat] = a;
  const [bLon, bLat] = b;
  const midLat = (aLat + bLat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * cosLat;

  const dx = (bLon - aLon) * mPerDegLon;
  const dy = (bLat - aLat) * mPerDegLat;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.1) return null;

  // Perpendicular unit vector in degree space (normalised in metric)
  const perpLon = -(dy / len) / mPerDegLon;
  const perpLat = (dx / len) / mPerDegLat;
  const pLon = perpLon * halfWidthM;
  const pLat = perpLat * halfWidthM;

  return [
    [aLon + pLon, aLat + pLat],
    [bLon + pLon, bLat + pLat],
    [bLon - pLon, bLat - pLat],
    [aLon - pLon, aLat - pLat],
    [aLon + pLon, aLat + pLat],
  ];
}

// GeoJSON LineString from the two axis handles — used as synthetic segment geometry.
function lineGeomFromHandles() {
  const { a, b } = state.manualHandles;
  return { type: "LineString", coordinates: [a, b] };
}

// Rebuild ring from current handles + manner and push to map layers without re-rendering.
function refreshManualPolygon() {
  if (!state.manualHandles || !editablePolygons.manual) return;
  const { a, b } = state.manualHandles;
  const manner = els.manualMannerField.value;
  const hw = mannerHalfWidth(manner);
  const ring = buildRectFromHandles(a, b, hw);
  if (!ring) return;
  state.manualRing = ring;
  for (const l of editablePolygons.manual.layers) l.setLatLngs(toLatLngPath(ring));
  setPolygonPreview("manual", ring);
  updateDividers("manual", ring, manner);
}

function enterManualAddMode(existingRing = null, existingManner = null) {
  state.manualAddMode = true;
  // New polygon gets a synthetic segment ID; re-editing an existing manual segment keeps its own ID.
  state.manualSegmentId = existingRing ? null : `manual-${crypto.randomUUID()}`;
  // Deselect the current road segment when starting a new polygon
  if (!existingRing) { state.prevIndex = state.index; state.index = -1; }

  els.manualPresentField.checked = true;
  els.manualMannerField.value = existingManner || "perpendicular";

  if (existingRing) {
    // Derive handles from saved ring: midpoints of the two short ends
    const a = [(existingRing[0][0] + existingRing[3][0]) / 2, (existingRing[0][1] + existingRing[3][1]) / 2];
    const b = [(existingRing[1][0] + existingRing[2][0]) / 2, (existingRing[1][1] + existingRing[2][1]) / 2];
    state.manualHandles = { a, b };
    state.manualRing = existingRing;
  } else {
    // New polygon: fit length to ~60% of the viewport width
    const bounds = state.map.instance.getBounds();
    const halfLenLon = (bounds.getEast() - bounds.getWest()) * 0.3;
    const center = state.map.instance.getCenter();
    const a = [center.lng - halfLenLon, center.lat];
    const b = [center.lng + halfLenLon, center.lat];
    state.manualHandles = { a, b };
    state.manualRing = buildRectFromHandles(a, b, mannerHalfWidth("perpendicular"));
  }

  // Uncheck left/right so saveReview marks them inactive
  els.leftPresentField.checked = false;
  els.rightPresentField.checked = false;

  els.addParkingButton.disabled = true;
  els.sideFieldsetsWrapper.hidden = true;
  els.manualFieldset.hidden = false;

  // Reuse undo button as a Cancel while in manual mode
  els.undoButton.textContent = "Poništi";
  els.undoButton.hidden = false;

  state.suppressMapFly = true;
  renderSelection(currentSegment()); // null when starting a new polygon (index === -1)
  setOsmStatus("Ručno dodavanje — postavite poligon i kliknite Potvrdi.", "needs-attention");
}

function exitManualAddMode() {
  state.manualAddMode = false;
  state.manualRing = null;
  state.manualHandles = null;
  state.manualSegmentId = null;
  if (state.prevIndex !== null) { state.index = state.prevIndex; state.prevIndex = null; }
  editablePolygons.manual = null;
  els.addParkingButton.disabled = false;
  els.sideFieldsetsWrapper.hidden = false;
  els.manualFieldset.hidden = true;
  els.undoButton.hidden = true;
  els.undoButton.textContent = "Poništi";
  updateSideFieldsetVisibility(currentSegment());
}

function bgColorForSegment(seg, side) {
  const sideData = seg.sides?.[side];
  const isSuspect = seg.review_status === "suspect";
  const isConfirmed = seg.review_status === "confirmed";
  const isInactive = sideData?.inactive;
  if (isInactive) return { color: "#94a3b8", fill: "#e2e8f0", fillOpacity: 0.15, dashArray: null };
  if (side === "manual") return { color: "#166534", fill: "#dcfce7", fillOpacity: isConfirmed ? 0.25 : 0.3, dashArray: null };
  const color = isSuspect ? "#991b1b" : isConfirmed ? "#166534" : (side === "left" ? "#9a3412" : "#1d4ed8");
  const fill = isSuspect ? "#ef4444" : isConfirmed ? "#22c55e" : (side === "left" ? "#f59e0b" : "#3b82f6");
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
  const manner = side === "left" ? els.leftMannerField.value : els.rightMannerField.value;
  updateDividers(side, ring, manner);
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

  // Manual polygon: translate both handles together
  if (drag.side === "manual") {
    state.manualHandles.a = [drag.originalHandleA[0] + dLon, drag.originalHandleA[1] + dLat];
    state.manualHandles.b = [drag.originalHandleB[0] + dLon, drag.originalHandleB[1] + dLat];
    const ll = { a: window.L.latLng(state.manualHandles.a[1], state.manualHandles.a[0]), b: window.L.latLng(state.manualHandles.b[1], state.manualHandles.b[0]) };
    for (const m of (editablePolygons.manual?.aMarkers || [])) m.setLatLng(ll.a);
    for (const m of (editablePolygons.manual?.bMarkers || [])) m.setLatLng(ll.b);
    refreshManualPolygon();
    return;
  }

  const next = drag.mode === "move" ? translateRing(drag.originalRing, dLon, dLat) : movePolygonEdge(drag.originalRing, drag.edge, dLon, dLat);
  applyEditablePolygonRing(drag.side, next);
}

function startMapDrag({ side, mode, edge = null, ring, startLatLng, sourceMap }) {
  const originalHandleA = side === "manual" ? [...state.manualHandles.a] : null;
  const originalHandleB = side === "manual" ? [...state.manualHandles.b] : null;
  state.map.dragState = { side, mode, edge, originalRing: ring ? cloneRing(ring) : null, originalHandleA, originalHandleB, startLatLng, sourceMap };
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
  marker.on("dragend", () => {
    parentMap.dragging.enable();
    const segment = currentSegment();
    if (segment) { state.suppressMapFly = true; renderSelection(segment); }
  });
  return marker;
}

function selectionColorForStatus(status, side, inactive) {
  if (inactive) return { stroke: "#94a3b8", fill: "#e2e8f0" };
  if (status === "confirmed") return { stroke: "#166534", fill: "#22c55e" };
  if (status === "suspect") return { stroke: "#991b1b", fill: "#ef4444" };
  return leafletColorForSide(side);
}

// Car spacing along the road edge per manner (meters between divider lines)
const SPACE_INTERVAL = { parallel: 5.5, perpendicular: 2.5, diagonal: 3.0 };
const DIAGONAL_OFFSET_FRAC = 0.4; // How much diagonal lines shift along the axis

// Compute divider lines directly from the polygon's long axis (handle a→b) and half-width.
// All lines are perpendicular to the axis, guaranteeing correct orientation regardless of rotation.
function buildDividerLinesFromAxis(axisA, axisB, halfWidthM, manner) {
  const [aLon, aLat] = axisA;
  const [bLon, bLat] = axisB;
  const midLat = (aLat + bLat) / 2;
  const mPerDegLon = 111320 * Math.cos(midLat * Math.PI / 180);
  const mPerDegLat = 111320;

  const dx_m = (bLon - aLon) * mPerDegLon;
  const dy_m = (bLat - aLat) * mPerDegLat;
  const len_m = Math.hypot(dx_m, dy_m);
  if (len_m < 0.1) return [];

  const interval = SPACE_INTERVAL[manner] || SPACE_INTERVAL.parallel;
  if (len_m < interval) return [];

  // Perpendicular unit vector in degree space (rotated 90° from axis)
  const perpLon = -dy_m / len_m / mPerDegLon;
  const perpLat = dx_m / len_m / mPerDegLat;
  // Axis unit vector in degree space
  const axisLon = dx_m / len_m / mPerDegLon;
  const axisLat = dy_m / len_m / mPerDegLat;

  const isDiagonal = manner === "diagonal";
  const diagonalShiftM = isDiagonal ? interval * DIAGONAL_OFFSET_FRAC : 0;

  const lines = [];
  for (let d = interval; d < len_m - 0.5; d += interval) {
    const t = d / len_m;
    const cLon = aLon + t * (bLon - aLon);
    const cLat = aLat + t * (bLat - aLat);

    // Outer point: on the +perp side at position d
    const p1Lon = cLon + halfWidthM * perpLon;
    const p1Lat = cLat + halfWidthM * perpLat;
    // Inner point: on the -perp side, shifted along axis for diagonal
    const p2Lon = cLon - halfWidthM * perpLon + diagonalShiftM * axisLon;
    const p2Lat = cLat - halfWidthM * perpLat + diagonalShiftM * axisLat;

    lines.push([[p1Lat, p1Lon], [p2Lat, p2Lon]]); // Leaflet [lat, lon]
  }
  return lines;
}

function buildDividerLines(ring, manner) {
  if (!ring || ring.length < 5) return [];
  const half = ringHalf(ring);
  // Outer edge: ring[0..half-1], inner edge: ring[half..2*half-1] (reversed relative to outer)
  const outer = ring.slice(0, half);
  const inner = ring.slice(half, half * 2).reverse();
  if (outer.length < 2 || inner.length < 2) return [];

  const outerLen = polylineLengthMeters(outer);
  const interval = SPACE_INTERVAL[manner] || SPACE_INTERVAL.parallel;
  if (outerLen < interval) return [];

  const isDiagonal = manner === "diagonal";
  const innerLen = polylineLengthMeters(inner);
  const lines = [];

  for (let d = interval; d < outerLen - 0.5; d += interval) {
    const outerPt = interpolateAlongPolyline(outer, d).coord;
    const innerD = isDiagonal
      ? Math.min(innerLen, d + interval * DIAGONAL_OFFSET_FRAC)
      : d * (innerLen / outerLen);
    const innerPt = interpolateAlongPolyline(inner, innerD).coord;
    lines.push([[outerPt[1], outerPt[0]], [innerPt[1], innerPt[0]]]);
  }
  return lines;
}

function addPolygonToLayer(ring, sideKey, active, layer, status, manner, inactive, drawDividers = true) {
  if (!ring || ring.length < 4) return null;
  const c = inactive ? selectionColorForStatus(null, sideKey, true) : status ? selectionColorForStatus(status, sideKey) : leafletColorForSide(sideKey);
  const poly = window.L.polygon(toLatLngPath(ring), { color: c.stroke, weight: active ? 3 : 2, fillColor: c.fill, fillOpacity: active ? 0.32 : 0.12 });
  poly.addTo(layer);

  // Draw space divider lines (skipped for editable polygons — those use dividerGroups instead)
  if (manner && active && drawDividers) {
    let dividers;
    if (sideKey === "manual" && ring.length === 5) {
      // Reconstruct long axis from the 4-corner manual ring for correct orientation
      const axisA = [(ring[0][0] + ring[3][0]) / 2, (ring[0][1] + ring[3][1]) / 2];
      const axisB = [(ring[1][0] + ring[2][0]) / 2, (ring[1][1] + ring[2][1]) / 2];
      const hw = mannerHalfWidth(manner);
      dividers = buildDividerLinesFromAxis(axisA, axisB, hw, manner);
    } else {
      dividers = buildDividerLines(ring, manner);
    }
    for (const line of dividers) {
      window.L.polyline(line, { color: "#000", weight: 1, opacity: 0.7 }).addTo(layer);
    }
  }

  return poly;
}

// Redraw divider lines for a live-editable polygon into its stored dividerGroups.
// For manual polygons, uses handle axis directly so lines stay perpendicular to the
// handle axis regardless of rotation. For L/R road polygons, uses ring edges.
function updateDividers(side, ring, manner) {
  const entry = editablePolygons[side];
  if (!entry?.dividerGroups) return;

  let lines = [];
  if (manner) {
    if (side === "manual" && state.manualHandles) {
      const hw = mannerHalfWidth(manner);
      lines = buildDividerLinesFromAxis(state.manualHandles.a, state.manualHandles.b, hw, manner);
    } else {
      lines = buildDividerLines(ring, manner);
    }
  }

  for (const group of entry.dividerGroups) {
    group.clearLayers();
    for (const line of lines) {
      window.L.polyline(line, { color: "#000", weight: 1, opacity: 0.7 }).addTo(group);
    }
  }
}

function ensureLeafletMap() {
  if (!window.L) return null;
  if (!state.map.instance) {
    const mapOpts = { zoomControl: true, attributionControl: true, preferCanvas: true, scrollWheelZoom: true, zoomSnap: 0.25, zoomDelta: 0.5 };
    // segmentMap = satellite (default visible), satelliteMap = OSM (hidden)
    state.map.instance = window.L.map(els.segmentMap, mapOpts);
    window.L.tileLayer(AERIAL_TMS_URL, { tms: true, maxZoom: 20, maxNativeZoom: 20, attribution: "DOF &copy; Grad Zagreb 2018" }).addTo(state.map.instance);
    // Fallback WMS: window.L.tileLayer.wms(CDOF_WMS_URL, { layers: "ZG_CDOF2022", format: "image/jpeg", version: "1.1.1", transparent: false, maxZoom: 22, attribution: "CDOF 2022 &copy; Grad Zagreb" }).addTo(state.map.instance);

    state.map.satellite = window.L.map(els.satelliteMap, { ...mapOpts, zoomControl: false });
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 22, maxNativeZoom: 19, attribution: "&copy; OSM" }).addTo(state.map.satellite);

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

    // Load OSM parking as a reference layer (below our polygons).
    // Two separate L.geoJSON instances are required because canvas-rendered layers
    // cannot be shared between maps (layer._map/_renderer get overwritten).
    fetch(OSM_PARKING_URL).then((r) => r.ok ? r.json() : null).then((fc) => {
      if (!fc?.features) return;
      const osmStyle = { radius: 4, weight: 0.5, color: "#be185d", fillColor: "#f472b6", fillOpacity: 0.6 };
      const polyStyle = { weight: 1.5, color: "#be185d", fillColor: "#fbcfe8", fillOpacity: 0.25 };
      function makeOsmLayer(map) {
        const layer = window.L.geoJSON(fc, {
          pointToLayer: (f, ll) => window.L.circleMarker(ll, osmStyle),
          style: () => polyStyle,
          onEachFeature: (f, l) => {
            const p = f.properties || {};
            l.bindTooltip(p.name || "OSM parking", { direction: "top", className: "segment-tooltip" });
          }
        });
        layer.addTo(map);
        layer.bringToBack();
        return layer;
      }
      makeOsmLayer(state.map.instance);
      makeOsmLayer(state.map.satellite);
    }).catch((err) => console.warn("OSM parking layer failed to load:", err));
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
    for (const side of ["left", "right", "manual"]) {
      if (seg.sides?.[side]?.inactive) continue; // confirmed-deleted, don't render
      const rings = segmentPolygonRings(seg, side);
      for (const ring of rings) {
        const bc = bgColorForSegment(seg, side);
        const style = { color: bc.color, weight: 1.5, fillColor: bc.fill, fillOpacity: bc.fillOpacity, dashArray: bc.dashArray };

        const osmP = window.L.polygon(toLatLngPath(ring), style).addTo(mc.bgLayer);
        const satP = window.L.polygon(toLatLngPath(ring), style).addTo(mc.bgLayerSat);
        osmP._segIndex = segIndex;
        osmP._side = side;
        satP._segIndex = segIndex;
        satP._side = side;

        if (side === "manual") {
          // One click: select segment + enter edit mode for the manual polygon
          const clickRing = ring;
          const clickManner = seg.sides.manual?.tags?.parking_manner || "perpendicular";
          osmP.on("click", async () => { if (await selectSegment(segIndex)) enterManualAddMode(clickRing, clickManner); });
        } else {
          osmP.on("click", () => selectSegment(segIndex));
        }
      }
    }
  }

  // Fit map to all polygons only on initial area load, not on confirm/save
  if (!state.suppressMapFly) {
    const bounds = mc.bgLayer.getBounds();
    if (bounds.isValid()) mc.instance.fitBounds(bounds.pad(0.05));
  }
}

function disableEditMode() {
  if (!state.editMode) return;
  state.editMode = false;
  const btn = document.getElementById("editModeBtn");
  btn.textContent = "Uredi poligone";
  btn.classList.remove("edit-mode-active");
  for (const m of [state.map.instance, state.map.satellite]) {
    if (!m) continue;
    m.dragging.enable();
    m.touchZoom.enable();
    m.scrollWheelZoom.enable();
    m.doubleClickZoom.enable();
  }
}

function hasUnsavedChanges() {
  return state.formPreview !== null || state.manualAddMode;
}

// Returns a promise that resolves true if safe to proceed (no changes, or user confirmed).
function confirmDiscardChanges() {
  if (!hasUnsavedChanges()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const modal = document.getElementById("discardChangesModal");
    const cancelBtn = document.getElementById("discardModalCancel");
    const proceedBtn = document.getElementById("discardModalProceed");
    function close(result) {
      modal.hidden = true;
      cancelBtn.removeEventListener("click", onCancel);
      proceedBtn.removeEventListener("click", onProceed);
      resolve(result);
    }
    function onCancel() { close(false); }
    function onProceed() { close(true); }
    cancelBtn.addEventListener("click", onCancel);
    proceedBtn.addEventListener("click", onProceed);
    modal.hidden = false;
  });
}

async function selectSegment(index) {
  // Only warn when switching to a different segment — clicking the already-selected one is safe.
  if (index !== state.index && !await confirmDiscardChanges()) return false;
  if (state.manualAddMode) exitManualAddMode();
  state.index = index;
  state.formPreview = null;
  clearUndo();
  disableEditMode();
  render();
  return true;
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
  editablePolygons.manual = null;

  // Hide background polygons for the selected segment, restore others
  const si = state.index;
  for (const bgL of [mc.bgLayer, mc.bgLayerSat]) {
    bgL.eachLayer((l) => {
      if (l._segIndex === si) {
        l.setStyle({ opacity: 0, fillOpacity: 0 });
      } else if (l.options.opacity === 0) {
        const seg = state.segments[l._segIndex];
        if (seg) {
          const bc = bgColorForSegment(seg, l._side || "left");
          l.setStyle({ opacity: 1, fillOpacity: bc.fillOpacity });
        }
      }
    });
  }

  for (const side of segment ? ["left", "right"] : []) {
    const sideA = side === "left" ? assessment?.segment_left : assessment?.segment_right;
    const sideData = segment.sides?.[side];
    const inactive = sideData?.inactive === true;
    const active = Boolean(sideA?.parking_present) && !inactive;

    // Draw as grey only for pending removal (unchecked, not yet confirmed as deleted).
    // Confirmed-inactive sides (sideData.inactive === true) are not shown at all.
    if (!active && !inactive && sideData?.polygon) {
      const rings = sideData.polygon.coordinates.map((r) => r);
      for (const ring of rings) {
        addPolygonToLayer(ring, side, false, mc.overlayLayer, null, null, true);
        addPolygonToLayer(ring, side, false, mc.satelliteOverlay, null, null, true);
      }
      continue;
    }
    if (!active) continue; // confirmed-inactive or no polygon — skip
    const rings = effectivePolygonRings(segment, assessment, side);
    const status = segment.review_status;
    const manner = sideA?.parking_manner || "parallel";

    rings.forEach((ring, ri) => {
      // drawDividers=false — dividers are managed live via dividerGroups
      const osmP = addPolygonToLayer(ring, side, true, mc.overlayLayer, status, manner, undefined, false);
      const satP = addPolygonToLayer(ring, side, true, mc.satelliteOverlay, status, manner, undefined, false);

      if (osmP && satP && ri === 0) {
        const osmDivGroup = window.L.featureGroup().addTo(mc.overlayLayer);
        const satDivGroup = window.L.featureGroup().addTo(mc.satelliteOverlay);
        const entry = { layers: [osmP, satP], handleSets: [], dividerGroups: [osmDivGroup, satDivGroup] };
        for (const [map, layer] of [[mc.instance, mc.overlayLayer], [mc.satellite, mc.satelliteOverlay]]) {
          const hs = { currentRing: cloneRing(ring) };
          hs.start = createEdgeHandle(side, "start", ring, map).addTo(layer);
          hs.end = createEdgeHandle(side, "end", ring, map).addTo(layer);
          entry.handleSets.push(hs);
        }
        editablePolygons[side] = entry;
        updateDividers(side, ring, manner);
        for (const [poly, srcMap] of [[osmP, mc.instance], [satP, mc.satellite]]) {
          poly.on("mousedown", (e) => { window.L.DomEvent.stop(e); startMapDrag({ side, mode: "move", ring: currentRingForSide(side), startLatLng: e.latlng, sourceMap: srcMap }); });
        }
      }
    });
  }

  // Show a previously saved manual polygon; clicking it re-enters edit mode
  if (segment && !state.manualAddMode && segment.sides["manual"]?.polygon && segment.sides["manual"]?.inactive !== true) {
    const sideData = segment.sides["manual"];
    const manner = sideData.tags?.parking_manner || "perpendicular";
    for (const ring of sideData.polygon.coordinates) {
      const osmP = addPolygonToLayer(ring, "manual", true, mc.overlayLayer, sideData.review_status, manner);
      const satP = addPolygonToLayer(ring, "manual", true, mc.satelliteOverlay, sideData.review_status, manner);
      for (const poly of [osmP, satP]) {
        if (poly) poly.on("click", () => enterManualAddMode(ring, manner));
      }
    }
  }

  // Manual add mode: draw freehand parking polygon with two rotation handles.
  // Each handle is the midpoint of one short end. Dragging rotates/stretches
  // while keeping the other handle fixed; the polygon is always a rectangle.
  if (state.manualAddMode && state.manualHandles) {
    const { a, b } = state.manualHandles;
    const hw = mannerHalfWidth(els.manualMannerField.value);
    const ring = (segment && state.formPreview?.segmentId === segment.segment_id
      ? state.formPreview?.polygonOverrides?.["manual"]
      : null) || buildRectFromHandles(a, b, hw) || state.manualRing;

    if (ring) {
      // drawDividers=false — managed live via dividerGroups
      const osmP = addPolygonToLayer(ring, "manual", true, mc.overlayLayer, null, null, undefined, false);
      const satP = addPolygonToLayer(ring, "manual", true, mc.satelliteOverlay, null, null, undefined, false);

      const osmDivGroup = window.L.featureGroup().addTo(mc.overlayLayer);
      const satDivGroup = window.L.featureGroup().addTo(mc.satelliteOverlay);
      editablePolygons.manual = { layers: [osmP, satP], aMarkers: [], bMarkers: [], dividerGroups: [osmDivGroup, satDivGroup] };
      updateDividers("manual", ring, els.manualMannerField.value);

      for (const [poly, srcMap] of [[osmP, mc.instance], [satP, mc.satellite]]) {
        poly.on("mousedown", (e) => { window.L.DomEvent.stop(e); startMapDrag({ side: "manual", mode: "move", ring: null, startLatLng: e.latlng, sourceMap: srcMap }); });
      }

      const iconA = window.L.divIcon({ className: "edge-handle edge-handle-manual edge-handle-start", iconSize: [14, 14] });
      const iconB = window.L.divIcon({ className: "edge-handle edge-handle-manual edge-handle-end", iconSize: [14, 14] });

      for (const [, layer] of [[mc.instance, mc.overlayLayer], [mc.satellite, mc.satelliteOverlay]]) {
        const posA = window.L.latLng(a[1], a[0]);
        const posB = window.L.latLng(b[1], b[0]);
        const mA = window.L.marker(posA, { draggable: true, keyboard: false, icon: iconA }).addTo(layer);
        const mB = window.L.marker(posB, { draggable: true, keyboard: false, icon: iconB }).addTo(layer);

        editablePolygons.manual.aMarkers.push(mA);
        editablePolygons.manual.bMarkers.push(mB);

        mA.on("drag", (e) => {
          const ll = e.target.getLatLng();
          state.manualHandles.a = [ll.lng, ll.lat];
          for (const m of editablePolygons.manual.aMarkers) if (m !== mA) m.setLatLng(ll);
          refreshManualPolygon();
        });
        mB.on("drag", (e) => {
          const ll = e.target.getLatLng();
          state.manualHandles.b = [ll.lng, ll.lat];
          for (const m of editablePolygons.manual.bMarkers) if (m !== mB) m.setLatLng(ll);
          refreshManualPolygon();
        });
      }
    }
  }

  // Segment centerline (skipped for synthetic manual segments — their geometry IS the handle axis)
  if (segment?.geometry && !segment.segment_id?.startsWith("manual-")) {
    const path = toLatLngPath(segment.geometry.coordinates);
    const style = { color: "#122033", weight: 4, opacity: 0.85 };
    window.L.polyline(path, style).addTo(mc.overlayLayer);
    window.L.polyline(path, style).addTo(mc.satelliteOverlay);
  }

  // Viewpoint markers
  const stations = new Map();
  for (const cap of segment?.captures || []) {
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

function populateSegmentDropdown() {
  const dd = document.getElementById("segmentJump");
  const currentVal = dd.value;
  dd.innerHTML = "";
  state.segments.forEach((seg, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    const sides = Object.keys(seg.sides || {}).join("+") || "—";
    const statusShort = { pending: "č", confirmed: "p", suspect: "s" }[seg.review_status] || "?";
    opt.textContent = `#${seg.segment_id} [${statusShort}]`;
    if (i === state.index) opt.selected = true;
    dd.appendChild(opt);
  });
}

function updateSegmentDropdownOption(index, segment) {
  const dd = document.getElementById("segmentJump");
  const opt = dd.querySelector(`option[value="${index}"]`);
  if (!opt) return;
  const statusShort = { pending: "č", confirmed: "p", suspect: "s" }[segment.review_status] || "?";
  opt.textContent = `#${segment.segment_id} [${statusShort}]`;
}

function renderEmptyState() {
  els.segmentMeta.innerHTML = "";
  els.prevButton.disabled = true;
  els.nextButton.disabled = true;
  setOsmStatus("Nema parkirnih zona za odabrano područje/filter.", "muted");
}

async function render() {
  if (!state.segments.length) { renderEmptyState(); return; }

  const visible = visibleSegmentIndexes();
  // Don't reset index when in new-polygon mode (index === -1 is intentional)
  if (state.index !== -1 && !visible.includes(state.index)) state.index = visible[0] ?? 0;

  if (!visible.length) { renderEmptyState(); return; }

  const segment = currentSegment(); // null when state.index === -1 (new polygon mode)
  if (segment) {
    renderMeta(segment);
    // Lazy-load captures for the selected segment before rendering them
    await ensureCaptures(segment);
    renderCaptures(segment);
    populateForm(segment);
    updateSideFieldsetVisibility(segment);
    // Just update selected value; full dropdown rebuild happens in loadArea
    document.getElementById("segmentJump").value = state.index;

    const pos = visible.indexOf(state.index);
    els.prevButton.disabled = pos <= 0;
    els.nextButton.disabled = pos >= visible.length - 1;

    const hasSides = Object.keys(segment.sides || {}).length;
    const statusLabels = { pending: "na čekanju", confirmed: "potvrđeno", suspect: "sumnjivo" };
    setOsmStatus(`${hasSides} strana · ${statusLabels[segment.review_status] || segment.review_status}`, "muted");
  } else {
    // New polygon mode: no road segment selected
    els.segmentMeta.innerHTML = "";
    els.captureGrid.innerHTML = "";
    els.prevButton.disabled = true;
    els.nextButton.disabled = true;
  }
  updateConfirmButton(segment);
  renderSelection(segment);
}

function stepVisible(dir) {
  const visible = visibleSegmentIndexes();
  const pos = visible.indexOf(state.index);
  const next = pos + dir;
  if (next >= 0 && next < visible.length) selectSegment(visible[next]);
}

// --- Undo support ---

function clearUndo() {
  state.lastSave = null;
  els.undoButton.hidden = true;
}

async function undoLastSave() {
  // While in manual add mode, undo button acts as Cancel
  if (state.manualAddMode) {
    exitManualAddMode(); // restores state.index from state.prevIndex if applicable
    state.suppressMapFly = true;
    render();
    setOsmStatus("Dodavanje poništeno.", "muted");
    return;
  }

  const saved = state.lastSave;
  if (!saved) return;

  const segment = state.segments.find((s) => s.segment_id === saved.segmentId);
  if (!segment) { clearUndo(); return; }

  els.undoButton.disabled = true;
  let apiOk = true;

  // Re-POST the previous side data to restore the old state
  for (const prev of saved.sides) {
    try {
      const resp = await fetch(`${PARKING_API_BASE}/areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segment_id: String(saved.segmentId),
          side: prev.side,
          geom: prev.geom,
          tags: prev.tags,
          confidence: prev.confidence,
          review_status: saved.reviewStatus,
          active: prev.active,
          updated_by: "street-view-reviewer"
        })
      });
      if (!resp.ok) { console.error(`Undo API failed ${saved.segmentId}/${prev.side}:`, await resp.text()); apiOk = false; }
      else console.log(`Undo ${saved.segmentId}/${prev.side} → [${saved.reviewStatus}]`);
    } catch (err) { console.error(`Undo error ${saved.segmentId}/${prev.side}:`, err.message); apiOk = false; }
  }

  // Restore local state
  segment.review_status = saved.reviewStatus;
  for (const prev of saved.sides) {
    segment.sides[prev.side] = structuredClone(prev.sideData);
  }

  clearUndo();
  els.undoButton.disabled = false;

  if (!apiOk) setOsmStatus("Poništavanje nije potpuno uspjelo — provjerite konzolu.", "needs-attention");
  else setOsmStatus("Poništeno.", "muted");

  state.suppressMapFly = true;
  updateSegmentDropdownOption(state.index, segment);
  renderAllPolygons();
  render();
}

// --- Save to API ---

async function saveReview(reviewStatus, suspectReason = null) {
  const segment = currentSegment();
  // Allow saving when in manual add mode even if no road segment is selected (index === -1)
  if (!segment && !state.manualAddMode) return;

  // Snapshot the current state for undo before making changes (only for road segments)
  if (segment) {
    const prevSides = [];
    for (const side of ["left", "right"]) {
      const sd = segment.sides?.[side];
      if (sd) {
        prevSides.push({
          side,
          sideData: structuredClone(sd),
          geom: sd.polygon || null,
          tags: sd.tags ? { ...sd.tags } : {},
          confidence: sd.confidence || 0,
          active: !sd.inactive,
        });
      }
    }
    state.lastSave = {
      segmentId: segment.segment_id,
      reviewStatus: segment.review_status,
      sides: prevSides,
    };
  }

  const assessment = formAssessment();
  const polyOverrides = state.formPreview?.polygonOverrides || null;
  // Capture manual ring before formPreview is cleared (only when checkbox is checked)
  const manualPresent = state.manualAddMode ? els.manualPresentField.checked : false;
  const manualRing = manualPresent
    ? (polyOverrides?.["manual"] || state.manualRing)
    : null;

  // Recompute polygons from current form values BEFORE clearing preview
  function resolveRing(seg, assess, side) {
    if (polyOverrides?.[side]) return polyOverrides[side];
    // Recompute from geometry + current manner/level
    const sa = side === "left" ? assess.segment_left : assess.segment_right;
    if (sa?.parking_present && segment.geometry?.coordinates) {
      const rings = recomputePolygonRings(segment, side, sa);
      if (rings.length > 0) return rings[0];
    }
    return effectivePolygonCoords(segment, assess, side);
  }

  state.formPreview = null;

  // Build list of sides to save: active polygons + deactivated sides.
  // In manual add mode skip left/right entirely — independent action.
  const saveSides = [];
  if (!state.manualAddMode) {
    const activePolygons = activeParkingPolygons(
      { ...segment, preview_polygons: {} },
      assessment,
      resolveRing
    );
    for (const polygon of activePolygons) {
      const sa = polygon.side === "left" ? assessment.segment_left : assessment.segment_right;
      saveSides.push({ side: polygon.side, geom: { type: "Polygon", coordinates: [polygon.ring] }, sa, active: true });
    }
    // For sides that were unchecked but have existing geometry, save as inactive
    const activeSideNames = new Set(activePolygons.map((p) => p.side));
    for (const side of ["left", "right"]) {
      if (activeSideNames.has(side)) continue;
      const existing = segment.sides?.[side];
      if (existing?.polygon) {
        const sa = side === "left" ? assessment.segment_left : assessment.segment_right;
        saveSides.push({ side, geom: existing.polygon, sa, active: false });
      }
    }
  }

  els.acceptAiButton.disabled = true;
  els.suspectButton.disabled = true;
  let apiOk = true;

  for (const { side, geom, sa, active } of saveSides) {
    try {
      const resp = await fetch(`${PARKING_API_BASE}/areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segment_id: String(segment.segment_id),
          side,
          geom,
          tags: { parking_manner: sa.parking_manner, parking_level: sa.parking_level, formality: sa.formality, label: segment.label },
          confidence: sa.confidence,
          review_status: reviewStatus,
          suspect_reason: suspectReason,
          active,
          updated_by: "street-view-reviewer"
        })
      });
      if (!resp.ok) { console.error(`API save failed ${segment.segment_id}/${side}:`, await resp.text()); apiOk = false; }
      else console.log(`Saved ${segment.segment_id}/${side} [${reviewStatus}] active=${active}`);
    } catch (err) { console.error(`API error ${segment.segment_id}/${side}:`, err.message); apiOk = false; }
  }

  // Save manually drawn polygon, or remove it if checkbox was unchecked
  if (state.manualAddMode && !manualPresent && !state.manualSegmentId) {
    // Delete existing manual polygon: re-post with active=false
    const existingManual = segment.sides?.manual;
    if (existingManual?.polygon) {
      // Optimistic update — hide from map immediately; rollback on API failure
      segment.sides["manual"] = { ...existingManual, inactive: true };
      try {
        const resp = await fetch(`${PARKING_API_BASE}/areas`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            segment_id: segment.segment_id,
            side: "manual",
            geom: existingManual.polygon,
            tags: existingManual.tags || {},
            confidence: existingManual.confidence || 1.0,
            review_status: reviewStatus,
            active: false,
            updated_by: "street-view-reviewer",
          })
        });
        if (!resp.ok) {
          segment.sides["manual"] = existingManual; // rollback
          console.error(`Manual remove failed for ${segment.segment_id}:`, await resp.text()); apiOk = false;
        } else {
          console.log(`Removed manual polygon for ${segment.segment_id}`);
        }
      } catch (err) {
        segment.sides["manual"] = existingManual; // rollback
        console.error(`Manual remove error for ${segment.segment_id}:`, err.message); apiOk = false;
      }
    }
    exitManualAddMode();
  } else if (manualRing) {
    const isNewManual = Boolean(state.manualSegmentId);
    const manualSegId = state.manualSegmentId || segment.segment_id;
    const segGeom = isNewManual ? lineGeomFromHandles() : null;
    const sa = {
      parking_manner: els.manualMannerField.value,
      parking_level: els.manualLevelField.value,
      formality: els.manualFormalityField.value,
    };
    const manualTags = { parking_manner: sa.parking_manner, parking_level: sa.parking_level, formality: sa.formality, source: "manual", label: "Ručno" };
    try {
      const resp = await fetch(`${PARKING_API_BASE}/areas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segment_id: manualSegId,
          side: "manual",
          geom: { type: "Polygon", coordinates: [manualRing] },
          tags: manualTags,
          confidence: 1.0,
          review_status: reviewStatus,
          active: true,
          updated_by: "street-view-reviewer",
          segment_geom: segGeom,
        })
      });
      if (!resp.ok) { console.error(`Manual polygon save failed for ${manualSegId}:`, await resp.text()); apiOk = false; }
      else {
        console.log(`Saved manual polygon ${manualSegId} [${reviewStatus}] (new=${isNewManual})`);
        const manualSideData = {
          polygon: { type: "Polygon", coordinates: [manualRing] },
          review_status: reviewStatus,
          tags: manualTags,
          confidence: 1.0,
        };
        if (isNewManual) {
          // Add a new standalone segment entry so it appears in the background layer
          state.segments.push({
            segment_id: manualSegId,
            label: "Ručno",
            width_m: 0, length_m: 0,
            area_labels: [],
            captures: [],
            geometry: segGeom,
            review_status: reviewStatus,
            sides: { manual: manualSideData },
          });
          // Select the new segment and clear prevIndex so exitManualAddMode keeps this index
          state.prevIndex = null;
          state.index = state.segments.length - 1;
          populateSegmentDropdown();
        } else {
          segment.sides["manual"] = manualSideData;
        }
      }
    } catch (err) { console.error(`Manual polygon save error for ${manualSegId}:`, err.message); apiOk = false; }
    exitManualAddMode();
  }

  els.acceptAiButton.disabled = false;
  els.suspectButton.disabled = false;

  // Update local state — only touch the road segment when sides were actually saved for it
  if (saveSides.length > 0) {
    segment.review_status = reviewStatus;
    for (const { side, geom, sa, active } of saveSides) {
      if (!segment.sides[side]) segment.sides[side] = {};
      if (active) {
        segment.sides[side].polygon = geom;
      }
      segment.sides[side].review_status = reviewStatus;
      segment.sides[side].tags = { parking_manner: sa.parking_manner, parking_level: sa.parking_level, formality: sa.formality, label: segment.label };
      segment.sides[side].confidence = sa.confidence;
      // Mark side as inactive but keep geometry for grey background rendering
      if (!active) {
        segment.sides[side] = { ...segment.sides[side], polygon: geom, inactive: true, review_status: reviewStatus };
      }
    }
    updateSegmentDropdownOption(state.index, segment);
  }

  if (!apiOk) {
    setOsmStatus("Spremanje na API nije uspjelo — provjerite konzolu.", "needs-attention");
    clearUndo(); // Don't offer undo if save failed
  } else {
    // Show undo button after a successful save
    els.undoButton.hidden = false;
  }
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
    opt.textContent = `${a.label} (${a.confirmed_count} potvrđeno, ${a.pending_count} čeka, ${a.suspect_count} sumnjivo)`;
    els.areaSelect.appendChild(opt);
  }

  // Load initial data
  await loadArea(els.areaSelect.value);

  // Events
  els.areaSelect.addEventListener("change", () => loadArea(els.areaSelect.value));
  els.reviewFilterField.addEventListener("change", () => loadArea(els.areaSelect.value));

  // Segment jump dropdown
  const segmentJump = document.getElementById("segmentJump");
  segmentJump.addEventListener("change", () => {
    const idx = Number(segmentJump.value);
    if (!isNaN(idx) && idx >= 0 && idx < state.segments.length) selectSegment(idx);
  });
  els.prevButton.addEventListener("click", () => stepVisible(-1));
  els.nextButton.addEventListener("click", () => stepVisible(1));
  els.undoButton.addEventListener("click", () => undoLastSave());
  els.acceptAiButton.addEventListener("click", () => saveReview("confirmed"));
  els.addParkingButton.addEventListener("click", () => {
    if (state.manualAddMode) exitManualAddMode();
    else enterManualAddMode();
  });
  els.manualPresentField.addEventListener("change", () => { if (state.manualAddMode) setOsmStatus("Svojstva izmjenjena — kliknite Potvrdi za spremanje", "needs-attention"); });
  els.manualMannerField.addEventListener("change", () => { if (state.manualAddMode) refreshManualPolygon(); });
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

  const leftFields = [els.leftPresentField, els.leftMannerField, els.leftLevelField, els.leftFormalityField];
  const rightFields = [els.rightPresentField, els.rightMannerField, els.rightLevelField, els.rightFormalityField];
  leftFields.forEach((f) => { f.addEventListener("input", () => updateFormPreview("left")); f.addEventListener("change", () => updateFormPreview("left")); });
  rightFields.forEach((f) => { f.addEventListener("input", () => updateFormPreview("right")); f.addEventListener("change", () => updateFormPreview("right")); });

  // AI reasoning popups
  const aiReasonModal = document.getElementById("aiReasonModal");
  const aiReasonTitle = document.getElementById("aiReasonTitle");
  const aiReasonContent = document.getElementById("aiReasonContent");
  document.getElementById("aiReasonClose").addEventListener("click", () => { aiReasonModal.hidden = true; });
  aiReasonModal.addEventListener("click", (e) => { if (e.target === aiReasonModal) aiReasonModal.hidden = true; });

  function showAiReason(side) {
    const segment = currentSegment();
    if (!segment) return;
    const sideData = segment.sides?.[side];
    const tags = sideData?.tags || {};
    const sideLabel = side === "left" ? "Lijeva strana" : "Desna strana";
    aiReasonTitle.textContent = `AI obrazloženje — ${sideLabel}`;

    const parts = [];
    if (tags.decision) parts.push(`<strong>Odluka:</strong> ${tags.decision}`);
    if (sideData?.confidence != null) parts.push(`<strong>Pouzdanost:</strong> ${Number(sideData.confidence).toFixed(2)}`);
    if (tags.parking_manner) parts.push(`<strong>Način:</strong> ${tags.parking_manner}`);
    if (tags.parking_level) parts.push(`<strong>Razina:</strong> ${tags.parking_level}`);
    if (tags.formality) parts.push(`<strong>Formalnost:</strong> ${tags.formality}`);
    if (tags.overall_notes) parts.push(`<strong>Bilješke:</strong> ${tags.overall_notes}`);
    if (sideData?.provider) {
      const modelLabel = sideData.provider === "openai" ? "Model 2" : sideData.provider === "anthropic" ? "Model 1" : "AI";
      parts.push(`<strong>Model:</strong> ${modelLabel}`);
    }

    aiReasonContent.innerHTML = parts.length > 0
      ? `<ul>${parts.map((p) => `<li>${p}</li>`).join("")}</ul>`
      : "<p class='muted'>Nema dostupnog obrazloženja.</p>";
    aiReasonModal.hidden = false;
  }

  document.getElementById("leftReasonBtn").addEventListener("click", () => showAiReason("left"));
  document.getElementById("rightReasonBtn").addEventListener("click", () => showAiReason("right"));

  // Map toggle: switch between satellite (default) and OSM
  const mapToggleBtn = document.getElementById("mapToggleBtn");
  let showingOsm = false;
  mapToggleBtn.addEventListener("click", () => {
    showingOsm = !showingOsm;
    els.segmentMap.hidden = showingOsm;
    els.satelliteMap.hidden = !showingOsm;
    mapToggleBtn.textContent = showingOsm ? "Satelit" : "OSM karta";
    const visibleMap = showingOsm ? state.map.satellite : state.map.instance;
    visibleMap.invalidateSize();
  });

  // Edit mode: freeze map for polygon editing on touch devices
  const editModeBtn = document.getElementById("editModeBtn");
  editModeBtn.addEventListener("click", () => {
    state.editMode = !state.editMode;
    editModeBtn.textContent = state.editMode ? "Otključaj kartu" : "Uredi poligone";
    editModeBtn.classList.toggle("edit-mode-active", state.editMode);
    for (const m of [state.map.instance, state.map.satellite]) {
      if (!m) continue;
      if (state.editMode) {
        m.dragging.disable();
        m.touchZoom.disable();
        m.scrollWheelZoom.disable();
        m.doubleClickZoom.disable();
      } else {
        m.dragging.enable();
        m.touchZoom.enable();
        m.scrollWheelZoom.enable();
        m.doubleClickZoom.enable();
      }
    }
  });
}

init().catch((err) => {
  document.body.innerHTML = `<main style="padding:2rem;font-family:Georgia,serif;"><h1>Preglednik nedostupan</h1><p>${err.message}</p><p>Je li parking API pokrenut?</p></main>`;
});
