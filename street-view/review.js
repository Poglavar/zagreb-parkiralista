// This script powers the static Street View review UI with local bundle loading and localStorage-backed overrides.
const BUNDLE_URL = "./out/review-bundle.json";
const STORAGE_KEY = "street-view-poc-overrides";

const state = {
  bundle: null,
  index: 0,
  overrides: {}
};

const els = {
  segmentCount: document.getElementById("segmentCount"),
  segmentList: document.getElementById("segmentList"),
  segmentTitle: document.getElementById("segmentTitle"),
  segmentMeta: document.getElementById("segmentMeta"),
  mapsLink: document.getElementById("mapsLink"),
  captureGrid: document.getElementById("captureGrid"),
  segmentDiagram: document.getElementById("segmentDiagram"),
  aiSummary: document.getElementById("aiSummary"),
  reviewStatus: document.getElementById("reviewStatus"),
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  exportButton: document.getElementById("exportButton"),
  importInput: document.getElementById("importInput"),
  acceptAiButton: document.getElementById("acceptAiButton"),
  clearOverrideButton: document.getElementById("clearOverrideButton"),
  overrideForm: document.getElementById("overrideForm"),
  decisionField: document.getElementById("decisionField"),
  confidenceField: document.getElementById("confidenceField"),
  leftPresentField: document.getElementById("leftPresentField"),
  leftMannerField: document.getElementById("leftMannerField"),
  leftLevelField: document.getElementById("leftLevelField"),
  leftFormalityField: document.getElementById("leftFormalityField"),
  leftConfidenceField: document.getElementById("leftConfidenceField"),
  leftEvidenceField: document.getElementById("leftEvidenceField"),
  rightPresentField: document.getElementById("rightPresentField"),
  rightMannerField: document.getElementById("rightMannerField"),
  rightLevelField: document.getElementById("rightLevelField"),
  rightFormalityField: document.getElementById("rightFormalityField"),
  rightConfidenceField: document.getElementById("rightConfidenceField"),
  rightEvidenceField: document.getElementById("rightEvidenceField"),
  reviewerNotesField: document.getElementById("reviewerNotesField")
};

function formatNumber(value, fractionDigits = 1) {
  if (value == null || Number.isNaN(Number(value))) {
    return "—";
  }
  return Number(value).toFixed(fractionDigits);
}

function loadStoredOverrides() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function persistOverrides() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.overrides));
}

function currentSegment() {
  return state.bundle?.segments?.[state.index] || null;
}

function effectiveAssessment(segment) {
  const override = state.overrides[segment.segment_id];
  if (override?.effective_assessment) {
    return {
      assessment: override.effective_assessment,
      review_status: override.review_status || "override",
      source: "human_review"
    };
  }

  const aiAssessment = segment.ai_assessment?.assessment;
  if (aiAssessment) {
    return {
      assessment: aiAssessment,
      review_status: "unreviewed",
      source: "openai"
    };
  }

  return null;
}

function createMetaPill(label, value) {
  const div = document.createElement("div");
  div.className = "meta-pill";
  div.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  return div;
}

function renderSegmentList() {
  els.segmentCount.textContent = `${state.bundle.segments.length} segments`;
  els.segmentList.innerHTML = "";

  state.bundle.segments.forEach((segment, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `segment-chip ${index === state.index ? "active" : ""}`;
    const override = state.overrides[segment.segment_id];
    const tag = override ? "reviewed locally" : (segment.ai_assessment ? "AI ready" : "no AI yet");
    button.innerHTML = `
      <strong>${segment.label}</strong>
      <span>${segment.segment_id} · ${segment.station_count} station(s)</span>
      <span class="muted">${tag}</span>
    `;
    button.addEventListener("click", () => {
      state.index = index;
      render();
    });
    els.segmentList.appendChild(button);
  });
}

function renderMeta(segment) {
  els.segmentTitle.textContent = segment.label;
  els.mapsLink.href = segment.captures[0]?.maps_url || "#";
  els.segmentMeta.innerHTML = "";
  [
    ["Segment ID", segment.segment_id],
    ["Length", `${formatNumber(segment.length_m)} m`],
    ["Width", `${formatNumber(segment.width_m, 2)} m`],
    ["Curvature", `${formatNumber(segment.turn_degrees)}°`],
    ["Areas", segment.area_labels.join(" / ") || "—"],
    ["Stations", String(segment.station_count)]
  ].forEach(([label, value]) => {
    els.segmentMeta.appendChild(createMetaPill(label, value));
  });
}

function renderCaptures(segment) {
  const template = document.getElementById("captureCardTemplate");
  els.captureGrid.innerHTML = "";

  segment.captures.forEach((capture) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const media = node.querySelector(".capture-media");
    const meta = node.querySelector(".capture-meta");
    const imagePath = capture.image?.image_path;

    if (imagePath) {
      const img = document.createElement("img");
      img.src = imagePath;
      img.alt = `${segment.label} ${capture.capture_id}`;
      media.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "capture-placeholder";
      placeholder.textContent = "No local image yet. Run Street View capture or use the mock bundle.";
      media.appendChild(placeholder);
    }

    meta.innerHTML = `
      <p><strong>${capture.capture_id}</strong></p>
      <p>${capture.direction} · heading ${formatNumber(capture.heading)}°</p>
      <p>station ${capture.station_index + 1}/${segment.station_count}</p>
      <p class="muted">${capture.metadata?.response?.status || "no metadata"}</p>
      <p><a href="${capture.maps_url}" target="_blank" rel="noopener">Open panorama</a></p>
    `;

    els.captureGrid.appendChild(node);
  });
}

function summarizeSide(title, side) {
  const div = document.createElement("div");
  div.className = "summary-block";
  div.innerHTML = `
    <div class="summary-title">${title}</div>
    <div>${side.parking_present ? "parking present" : "no parking"}</div>
    <div>${side.parking_manner} · ${side.parking_level} · ${side.formality}</div>
    <div>confidence ${formatNumber(side.confidence, 2)}</div>
    <div class="muted">${(side.evidence || []).join(" · ")}</div>
  `;
  return div;
}

function renderAiSummary(segment) {
  const resolved = effectiveAssessment(segment);
  els.aiSummary.innerHTML = "";

  if (!resolved) {
    els.aiSummary.textContent = "No AI assessment found for this segment.";
    return;
  }

  const assessment = resolved.assessment;
  const badge = document.createElement("span");
  badge.className = `decision-badge ${resolved.source === "human_review" ? "reviewed" : ""}`;
  badge.textContent = `${resolved.source} · ${assessment.decision} · ${formatNumber(assessment.confidence, 2)}`;
  els.aiSummary.appendChild(badge);

  const notes = document.createElement("div");
  notes.className = "summary-block";
  notes.innerHTML = `
    <div class="summary-title">Overall Notes</div>
    <div>${assessment.overall_notes || "—"}</div>
  `;
  els.aiSummary.appendChild(notes);
  els.aiSummary.appendChild(summarizeSide("Segment Left", assessment.segment_left));
  els.aiSummary.appendChild(summarizeSide("Segment Right", assessment.segment_right));
}

function pointsToSvgPath(points, width, height, bounds) {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const spanLon = Math.max(0.00001, maxLon - minLon);
  const spanLat = Math.max(0.00001, maxLat - minLat);
  const pad = 28;

  const project = ([lon, lat]) => {
    const x = pad + ((lon - minLon) / spanLon) * (width - pad * 2);
    const y = height - pad - ((lat - minLat) / spanLat) * (height - pad * 2);
    return [x, y];
  };

  return points.map((point, index) => {
    const [x, y] = project(point);
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function geometryBounds(segment) {
  const allPoints = [
    ...segment.geometry.coordinates,
    ...(segment.preview_polygons.left_road_level || []),
    ...(segment.preview_polygons.right_road_level || []),
    ...(segment.preview_polygons.left_sidewalk || []),
    ...(segment.preview_polygons.right_sidewalk || [])
  ];
  return allPoints.reduce(
    (acc, [lon, lat]) => [
      Math.min(acc[0], lon),
      Math.min(acc[1], lat),
      Math.max(acc[2], lon),
      Math.max(acc[3], lat)
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
}

function renderDiagram(segment) {
  const resolved = effectiveAssessment(segment);
  const assessment = resolved?.assessment;
  const svg = els.segmentDiagram;
  svg.innerHTML = "";
  const width = 760;
  const height = 300;
  const bounds = geometryBounds(segment);

  const makePath = (coords, fill, stroke, opacity = 1) => {
    if (!coords || coords.length < 4) return null;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `${pointsToSvgPath(coords, width, height, bounds)} Z`);
    path.setAttribute("fill", fill);
    path.setAttribute("fill-opacity", opacity);
    path.setAttribute("stroke", stroke);
    path.setAttribute("stroke-width", "2");
    return path;
  };

  const leftLevel = assessment?.segment_left?.parking_level === "sidewalk" ? "left_sidewalk" : "left_road_level";
  const rightLevel = assessment?.segment_right?.parking_level === "sidewalk" ? "right_sidewalk" : "right_road_level";

  const leftPath = makePath(
    segment.preview_polygons[leftLevel],
    assessment?.segment_left?.parking_present ? "#f59e0b" : "rgba(245,158,11,0.14)",
    "#9a3412",
    assessment?.segment_left?.parking_present ? 0.5 : 0.18
  );
  const rightPath = makePath(
    segment.preview_polygons[rightLevel],
    assessment?.segment_right?.parking_present ? "#3b82f6" : "rgba(59,130,246,0.14)",
    "#1d4ed8",
    assessment?.segment_right?.parking_present ? 0.5 : 0.18
  );
  if (leftPath) svg.appendChild(leftPath);
  if (rightPath) svg.appendChild(rightPath);

  const centerLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
  centerLine.setAttribute("d", pointsToSvgPath(segment.geometry.coordinates, width, height, bounds));
  centerLine.setAttribute("fill", "none");
  centerLine.setAttribute("stroke", "#122033");
  centerLine.setAttribute("stroke-width", "4");
  centerLine.setAttribute("stroke-linecap", "round");
  centerLine.setAttribute("stroke-linejoin", "round");
  svg.appendChild(centerLine);

  segment.captures.forEach((capture) => {
    const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const d = pointsToSvgPath([[capture.viewpoint.lon, capture.viewpoint.lat]], width, height, bounds)
      .replace("M", "")
      .trim()
      .split(" ");
    point.setAttribute("cx", d[0]);
    point.setAttribute("cy", d[1]);
    point.setAttribute("r", "5");
    point.setAttribute("fill", capture.direction === "forward" ? "#9a3412" : "#1d4ed8");
    svg.appendChild(point);
  });
}

function populateForm(segment) {
  const resolved = effectiveAssessment(segment);
  const assessment = resolved?.assessment || {
    decision: "unclear",
    confidence: 0.5,
    overall_notes: "",
    segment_left: {
      parking_present: false,
      parking_manner: "unknown",
      parking_level: "unknown",
      formality: "unknown",
      confidence: 0.5,
      evidence: []
    },
    segment_right: {
      parking_present: false,
      parking_manner: "unknown",
      parking_level: "unknown",
      formality: "unknown",
      confidence: 0.5,
      evidence: []
    }
  };

  els.decisionField.value = assessment.decision;
  els.confidenceField.value = assessment.confidence;
  els.leftPresentField.checked = assessment.segment_left.parking_present;
  els.leftMannerField.value = assessment.segment_left.parking_manner;
  els.leftLevelField.value = assessment.segment_left.parking_level;
  els.leftFormalityField.value = assessment.segment_left.formality;
  els.leftConfidenceField.value = assessment.segment_left.confidence;
  els.leftEvidenceField.value = (assessment.segment_left.evidence || []).join("\n");
  els.rightPresentField.checked = assessment.segment_right.parking_present;
  els.rightMannerField.value = assessment.segment_right.parking_manner;
  els.rightLevelField.value = assessment.segment_right.parking_level;
  els.rightFormalityField.value = assessment.segment_right.formality;
  els.rightConfidenceField.value = assessment.segment_right.confidence;
  els.rightEvidenceField.value = (assessment.segment_right.evidence || []).join("\n");
  els.reviewerNotesField.value = state.overrides[segment.segment_id]?.reviewer_notes || "";
  els.reviewStatus.textContent = state.overrides[segment.segment_id]
    ? `Local override: ${state.overrides[segment.segment_id].review_status}`
    : "No local override.";
}

function formAssessment() {
  return {
    decision: els.decisionField.value,
    confidence: Number(els.confidenceField.value || 0),
    overall_notes: els.reviewerNotesField.value || "",
    segment_left: {
      parking_present: els.leftPresentField.checked,
      parking_manner: els.leftMannerField.value,
      parking_level: els.leftLevelField.value,
      formality: els.leftFormalityField.value,
      confidence: Number(els.leftConfidenceField.value || 0),
      evidence: els.leftEvidenceField.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    },
    segment_right: {
      parking_present: els.rightPresentField.checked,
      parking_manner: els.rightMannerField.value,
      parking_level: els.rightLevelField.value,
      formality: els.rightFormalityField.value,
      confidence: Number(els.rightConfidenceField.value || 0),
      evidence: els.rightEvidenceField.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    }
  };
}

function saveOverride(reviewStatus) {
  const segment = currentSegment();
  if (!segment) return;
  state.overrides[segment.segment_id] = {
    review_status: reviewStatus,
    reviewer_notes: els.reviewerNotesField.value || "",
    effective_assessment: formAssessment()
  };
  persistOverrides();
  render();
}

function exportOverrides() {
  const payload = {
    exported_at: new Date().toISOString(),
    overrides: state.overrides
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `street-view-review-overrides-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importOverrides(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  state.overrides = payload.overrides || {};
  persistOverrides();
  render();
}

function render() {
  const segment = currentSegment();
  if (!segment) return;
  renderSegmentList();
  renderMeta(segment);
  renderCaptures(segment);
  renderAiSummary(segment);
  populateForm(segment);
  renderDiagram(segment);
  els.prevButton.disabled = state.index === 0;
  els.nextButton.disabled = state.index === state.bundle.segments.length - 1;
}

async function init() {
  state.overrides = loadStoredOverrides();
  const response = await fetch(BUNDLE_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${BUNDLE_URL}: HTTP ${response.status}`);
  }
  state.bundle = await response.json();

  els.prevButton.addEventListener("click", () => {
    if (state.index > 0) {
      state.index -= 1;
      render();
    }
  });
  els.nextButton.addEventListener("click", () => {
    if (state.index < state.bundle.segments.length - 1) {
      state.index += 1;
      render();
    }
  });
  els.exportButton.addEventListener("click", exportOverrides);
  els.importInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      await importOverrides(file);
    }
    event.target.value = "";
  });
  els.acceptAiButton.addEventListener("click", () => {
    const segment = currentSegment();
    const aiAssessment = segment?.ai_assessment?.assessment;
    if (!segment || !aiAssessment) return;
    state.overrides[segment.segment_id] = {
      review_status: "agree",
      reviewer_notes: "Accepted AI assessment in local reviewer.",
      effective_assessment: aiAssessment
    };
    persistOverrides();
    render();
  });
  els.clearOverrideButton.addEventListener("click", () => {
    const segment = currentSegment();
    if (!segment) return;
    delete state.overrides[segment.segment_id];
    persistOverrides();
    render();
  });
  els.overrideForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveOverride("override");
  });

  render();
}

init().catch((error) => {
  document.body.innerHTML = `<main style="padding:2rem;font-family:Georgia,serif;"><h1>Review bundle unavailable</h1><p>${error.message}</p><p>Run <code>npm run mock:run</code> or build a live bundle first.</p></main>`;
});
