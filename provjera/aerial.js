// Logika mobilne provjere aerial kandidata: učitava kandidate iz parking
// API-ja, prikazuje jednog po jednog na DOF podlozi s uređivanjem vrhova
// poligona, i šalje odluke (potvrdi/odbij, s eventualno uređenom geometrijom).

const AERIAL_TMS_URL = "https://tms.osm-hr.org/zagreb-2018/{z}/{x}/{y}.png";
const COMPOSITE_BASE = "../data/composites/cdof2022";
const COMPOSITE_NATIVE = 1024;

const API_BASE = (() => {
  const explicit = new URLSearchParams(window.location.search).get("apiBase")
    || window.localStorage.getItem("zagrebApiBase");
  if (explicit) return explicit.replace(/\/$/, "");
  if (window.location.pathname.startsWith("/parkirali")) {
    // prod: /parkiralista/provjera/aerial.html → API proxy at /parkiralista/api
    return window.location.origin + "/parkiralista";
  }
  return `${window.location.protocol}//${window.location.hostname}:3001`;
})();

const KIND_LABELS = { street_parking: "ulično", lot: "parkiralište", courtyard: "dvorište" };
const CONF_LABELS = { high: "visoka", medium: "srednja", low: "niska" };
const STATUS_LABELS = { pending: "čeka provjeru", confirmed: "potvrđeno", rejected: "odbijeno" };

const state = {
  candidates: [],
  index: 0,
  map: null,
  polygon: null,        // L.polygon currently shown
  vertexHandles: [],
  midpointHandles: [],
  latlngs: [],          // working copy of the ring (editable)
  originalLatlngs: [],  // for "vrati original"
  edited: false,
  saving: false,
};

function $(id) { return document.getElementById(id); }

// ── Data ──────────────────────────────────────────────────────────────────

async function loadCandidates() {
  const status = $("status-filter").value;
  const url = `${API_BASE}/api/parking/aerial-candidates${status ? `?review_status=${status}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  const fc = await res.json();
  state.candidates = fc.features || [];
  state.index = 0;
  showCurrent();
}

// ── Polygon display + vertex editing (Leaflet core only, no plugins) ─────

function clearHandles() {
  for (const h of [...state.vertexHandles, ...state.midpointHandles]) state.map.removeLayer(h);
  state.vertexHandles = [];
  state.midpointHandles = [];
}

function redrawPolygon() {
  state.polygon.setLatLngs([state.latlngs]);
  rebuildHandles();
  markEdited();
}

function markEdited() {
  state.edited = JSON.stringify(state.latlngs) !== JSON.stringify(state.originalLatlngs);
  $("edited-badge").hidden = !state.edited;
}

function rebuildHandles() {
  clearHandles();
  const ring = state.latlngs;

  ring.forEach((ll, i) => {
    const handle = L.marker(ll, {
      draggable: true,
      icon: L.divIcon({ className: "vertex-handle", iconSize: [16, 16] }),
    }).addTo(state.map);
    handle.on("drag", (e) => {
      state.latlngs[i] = e.target.getLatLng();
      state.polygon.setLatLngs([state.latlngs]);
    });
    handle.on("dragend", () => redrawPolygon());
    // Dvostruki tap/klik na vrh briše ga (min 3 vrha).
    handle.on("dblclick", () => {
      if (state.latlngs.length <= 3) return;
      state.latlngs.splice(i, 1);
      redrawPolygon();
    });
    state.vertexHandles.push(handle);
  });

  // Midpoint handles: povuci da dodaš novi vrh između dva postojeća.
  ring.forEach((ll, i) => {
    const next = ring[(i + 1) % ring.length];
    const mid = L.latLng((ll.lat + next.lat) / 2, (ll.lng + next.lng) / 2);
    const handle = L.marker(mid, {
      draggable: true,
      icon: L.divIcon({ className: "midpoint-handle", iconSize: [10, 10] }),
    }).addTo(state.map);
    handle.on("dragstart", () => {
      state.latlngs.splice(i + 1, 0, handle.getLatLng());
    });
    handle.on("drag", (e) => {
      state.latlngs[i + 1] = e.target.getLatLng();
      state.polygon.setLatLngs([state.latlngs]);
    });
    handle.on("dragend", () => redrawPolygon());
    state.midpointHandles.push(handle);
  });
}

// ── Info card ─────────────────────────────────────────────────────────────

function cropHtml(props) {
  if (!props.bbox_pct || !props.source_composite) return "";
  const [x0, y0, x1, y1] = props.bbox_pct;
  const cx = ((x0 + x1) / 2) * COMPOSITE_NATIVE;
  const cy = ((y0 + y1) / 2) * COMPOSITE_NATIVE;
  const crop = 320;
  const cropX = Math.max(0, Math.min(cx - crop / 2, COMPOSITE_NATIVE - crop));
  const cropY = Math.max(0, Math.min(cy - crop / 2, COMPOSITE_NATIVE - crop));
  const bw = Math.max((x1 - x0) * COMPOSITE_NATIVE, 20);
  const bh = Math.max((y1 - y0) * COMPOSITE_NATIVE, 20);
  const url = `${COMPOSITE_BASE}/${encodeURIComponent(props.source_composite)}.png`;
  // Postotne pozicije da se crop skalira s širinom kartice.
  const pct = (v) => `${(v / crop) * 100}%`;
  return `
    <div class="tile-crop" style="background-image:url('${url}');background-size:${(COMPOSITE_NATIVE / crop) * 100}% auto;background-position:${(cropX / (COMPOSITE_NATIVE - crop)) * 100}% ${(cropY / (COMPOSITE_NATIVE - crop)) * 100}%;">
      <div class="tile-crop-bbox" style="left:${pct(cx - cropX - bw / 2)};top:${pct(cy - cropY - bh / 2)};width:${pct(bw)};height:${pct(bh)};"></div>
    </div>`;
}

function renderInfo(props) {
  $("info-kind").textContent = KIND_LABELS[props.kind] || props.kind;
  const conf = $("info-conf");
  conf.textContent = `pouzdanost: ${CONF_LABELS[props.confidence] || props.confidence}`;
  conf.className = `chip conf-${props.confidence}`;
  const st = $("info-status");
  st.textContent = STATUS_LABELS[props.review_status] || props.review_status;
  st.className = `chip st-${props.review_status}`;
  $("info-reason").textContent = props.reason || "";
  $("info-crop").innerHTML = cropHtml(props);
  $("info-model").textContent = props.model || "";
  $("info-composite").textContent = props.source_composite || "";
}

// ── Queue navigation ──────────────────────────────────────────────────────

function showCurrent() {
  clearHandles();
  if (state.polygon) { state.map.removeLayer(state.polygon); state.polygon = null; }

  const total = state.candidates.length;
  $("counter").textContent = total ? `${state.index + 1} / ${total}` : "0 / 0";
  $("empty-state").hidden = total > 0;
  if (!total) return;

  const feat = state.candidates[state.index];
  const ring = feat.geometry.coordinates[0]
    .slice(0, -1)  // GeoJSON ring is closed; work with open ring
    .map(([lng, lat]) => L.latLng(lat, lng));

  state.latlngs = ring.map((ll) => L.latLng(ll.lat, ll.lng));
  state.originalLatlngs = ring.map((ll) => L.latLng(ll.lat, ll.lng));
  state.edited = false;
  $("edited-badge").hidden = true;

  state.polygon = L.polygon([state.latlngs], {
    color: "#0d9488", weight: 3, fillColor: "#14b8a6", fillOpacity: 0.25, dashArray: "6,4",
  }).addTo(state.map);

  state.map.invalidateSize();
  state.map.fitBounds(state.polygon.getBounds(), { padding: [70, 70], maxZoom: 19 });
  rebuildHandles();
  renderInfo(feat.properties);
  $("info-body").hidden = true;
}

function advance(dir) {
  if (!state.candidates.length) return;
  state.index = (state.index + dir + state.candidates.length) % state.candidates.length;
  showCurrent();
}

// ── Actions ───────────────────────────────────────────────────────────────

async function review(status) {
  if (state.saving || !state.candidates.length) return;
  state.saving = true;
  $("btn-confirm").disabled = $("btn-reject").disabled = true;

  const feat = state.candidates[state.index];
  const body = { id: feat.properties.id, review_status: status };
  if (state.edited) {
    const ring = state.latlngs.map((ll) => [ll.lng, ll.lat]);
    ring.push(ring[0]);
    body.geom = { type: "Polygon", coordinates: [ring] };
  }

  try {
    const res = await fetch(`${API_BASE}/api/parking/aerial-candidates/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Greška pri spremanju: ${err.error || res.status}`);
      return;
    }
    // Ukloni obrađenog kandidata iz reda i prikaži sljedećeg.
    state.candidates.splice(state.index, 1);
    if (state.index >= state.candidates.length) state.index = 0;
    showCurrent();
  } catch (err) {
    alert(`Greška pri spremanju: ${err.message}`);
  } finally {
    state.saving = false;
    $("btn-confirm").disabled = $("btn-reject").disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────

function init() {
  state.map = L.map("map", {
    zoomControl: false,
    doubleClickZoom: false,  // dvoklik briše vrh, ne zumira
  }).setView([45.813, 15.977], 15);

  L.tileLayer(AERIAL_TMS_URL, {
    tms: true, maxZoom: 21, maxNativeZoom: 20,
    attribution: "DOF © Grad Zagreb 2018",
  }).addTo(state.map);

  // The container can still be mid-layout at init (mobile browsers, fixed
  // positioning) — re-measure once layout settles and on every resize.
  setTimeout(() => state.map.invalidateSize(), 200);
  window.addEventListener("resize", () => state.map.invalidateSize());

  $("btn-confirm").addEventListener("click", () => review("confirmed"));
  $("btn-reject").addEventListener("click", () => review("rejected"));
  $("btn-next").addEventListener("click", () => advance(1));
  $("btn-prev").addEventListener("click", () => advance(-1));
  $("status-filter").addEventListener("change", loadCandidates);
  $("info-toggle").addEventListener("click", () => {
    $("info-body").hidden = !$("info-body").hidden;
  });
  $("edit-reset").addEventListener("click", () => {
    state.latlngs = state.originalLatlngs.map((ll) => L.latLng(ll.lat, ll.lng));
    redrawPolygon();
  });

  loadCandidates().catch((err) => {
    $("counter").textContent = "greška";
    alert(`Ne mogu učitati kandidate: ${err.message}`);
  });
}

document.addEventListener("DOMContentLoaded", init);
