// Status obrade: čita /api/parking/coverage i crta koje je dijelove grada obrađeno.
//
// Ključna razlika koju stranica mora prikazati: segment koji je analiziran i na kojem
// model NIJE našao parkiranje je obrađen, a ne neobrađen. U bazi to razlikuje
// parking.segment_coverage; ovdje se to vidi kao "prazno" umjesto kao rupa.

const ZAGREB_CENTER = [45.815, 15.98];
const DEFAULT_ZOOM = 12;

// Isti obrazac kao js/map.js: ?apiBase=… override, pa localStorage, pa prod proxy,
// pa localhost:3001 za razvoj.
const API_BASE = (() => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("apiBase") || window.localStorage.getItem("zagrebApiBase");
  if (explicit) return explicit.replace(/\/$/, "");
  if (window.location.pathname.startsWith("/parkirali")) {
    return window.location.origin + window.location.pathname.replace(/\/obrada\/.*$/, "");
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostname = window.location.hostname || "localhost";
  return `${protocol}//${hostname}:3001`;
})();

const state = {
  level: "mo",
  areas: [],
  hideDone: false,
  filter: "",
  selected: null,
  selectedFeatures: null,   // segments of the open area, for recomputing the run hints
  layer: null,
  segmentLayer: null,
  imageryDotLayer: null     // green dot per area whose Street View imagery is complete
};

const els = {};
let map;

function fmt(n) {
  return n == null ? "—" : Number(n).toLocaleString("hr-HR");
}

function pct(done, total) {
  return total ? (100 * Number(done)) / Number(total) : 0;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// --- boje ---------------------------------------------------------------------

// Choropleth po udjelu analiziranih segmenata. Namjerno diskretno u 5 koraka:
// kontinuirana skala ovdje samo sugerira preciznost koje nema.
function areaColor(p) {
  if (p <= 0) return "#2a2f3a";
  if (p < 25) return "#1f3f6b";
  if (p < 60) return "#2b5fa8";
  if (p < 99.5) return "#3f82db";
  return "#6fb0ff";
}

// Stanje jednog segmenta, po prioritetu: ljudska odluka > više modela > analizirano
// > snimke spremne > ništa. Neuspjeh je zaseban jer traži ponovno pokretanje.
function segmentState(p) {
  if (Number(p.failed_runs) > 0) return { key: "failed", label: "greška", color: "#f85149" };
  if (Number(p.verdict_count) > 0) return { key: "human", label: "ljudski provjereno", color: "#3fb950" };
  if (Number(p.run_count) > 1) return { key: "multi", label: `${p.run_count} modela`, color: "#a371f7" };
  if (Number(p.run_count) === 1) {
    return Number(p.parking_runs) > 0
      ? { key: "done", label: "analizirano", color: "#4c8dff" }
      : { key: "empty", label: "analizirano — bez parkinga", color: "#8b98ad" };
  }
  if (Number(p.image_count) > 0) return { key: "ready", label: "snimke spremne", color: "#d29922" };
  // Checked and Google has no panorama here. This is a permanent property of the street,
  // not a queue item — showing it as "nije obrađeno" put work in the backlog that no
  // amount of fetching could ever clear.
  if (p.imagery_checked && Number(p.covered_count) === 0) {
    return { key: "nosv", label: "nema Street Viewa", color: "#4a3f5c" };
  }
  return { key: "none", label: "nije obrađeno", color: "#3a4150" };
}

// --- dohvat -------------------------------------------------------------------

async function fetchJson(url) {
  const resp = await fetch(url);
  const body = await resp.json().catch(() => null);
  if (!resp.ok || body?.error) {
    throw new Error(body?.error || `HTTP ${resp.status}`);
  }
  return body;
}

async function loadAreas(level) {
  const data = await fetchJson(`${API_BASE}/api/parking/coverage?level=${encodeURIComponent(level)}`);
  state.areas = data.features;
  renderSummary(data.metadata.totals);
  renderAreaTable();
  renderAreaLayer();
}

// --- prikaz -------------------------------------------------------------------

function renderSummary(t) {
  const wrap = els.summary;
  wrap.innerHTML = "";
  const analysedPct = pct(t.analysed, t.segments);
  const tiles = [
    { val: fmt(t.segments), lbl: "segmenata ukupno", sub: "cijeli Zagreb" },
    { val: `${analysedPct.toFixed(1)} %`, lbl: "analizirano", sub: `${fmt(t.analysed)} segmenata` },
    { val: fmt(t.with_images), lbl: "ima snimke", sub: `${pct(t.with_images, t.segments).toFixed(1)} % grada` },
    { val: fmt(t.multi_model), lbl: "s dva ili više modela", sub: "usporedivo" },
    { val: fmt(t.reviewed), lbl: "ljudski provjereno", sub: "konačne odluke" },
    // Ovo je jedini broj koji traži akciju: snimke su plaćene i stoje na disku.
    { val: fmt(t.ready_unprocessed), lbl: "snimke spremne, nije analizirano", sub: "besplatan posao", highlight: true }
  ];
  for (const tile of tiles) {
    wrap.appendChild(el(`
      <div class="tile${tile.highlight && Number(t.ready_unprocessed) > 0 ? " highlight" : ""}">
        <div class="val">${escapeHtml(tile.val)}</div>
        <div class="lbl">${escapeHtml(tile.lbl)}</div>
        <div class="sub">${escapeHtml(tile.sub)}</div>
      </div>`));
  }
}

function visibleAreas() {
  const f = state.filter.trim().toLowerCase();
  return state.areas.filter((feat) => {
    const p = feat.properties;
    if (state.hideDone && Number(p.analysed) >= Number(p.segments)) return false;
    if (f && !String(p.area).toLowerCase().includes(f) && !String(p.parent || "").toLowerCase().includes(f)) return false;
    return true;
  });
}

function renderAreaTable() {
  const tbody = els.areaTbody;
  tbody.innerHTML = "";
  const rows = visibleAreas();
  if (rows.length === 0) {
    tbody.appendChild(el(`<tr><td colspan="11" class="muted">Nema područja koja odgovaraju filtru.</td></tr>`));
    return;
  }
  for (const feat of rows) {
    const p = feat.properties;
    const done = pct(p.analysed, p.segments);
    const tr = el(`
      <tr class="clickable${state.selected === p.area ? " selected" : ""}">
        <td class="num">${fmt(p.ring_index)}</td>
        <td>${escapeHtml(p.area)}</td>
        <td class="parent-col muted">${escapeHtml(p.parent || "")}</td>
        <td class="num">${fmt(p.segments)}</td>
        <td class="num">${fmt(p.km)}</td>
        <td class="num">${fmt(p.with_images)}</td>
        <td class="num">${fmt(p.analysed)}</td>
        <td class="num">${fmt(p.multi_model)}</td>
        <td class="num">${Number(p.ready_unprocessed) > 0 ? `<span class="pill ready">${fmt(p.ready_unprocessed)}</span>` : "—"}</td>
        <td class="num">${fmt(p.reviewed)}</td>
        <td><span class="bar${done >= 99.5 ? " full" : ""}"><span style="width:${done.toFixed(1)}%"></span></span></td>
      </tr>`);
    tr.addEventListener("click", () => selectArea(p.area));
    tbody.appendChild(tr);
  }
}

// One dot per area whose imagery is finished: every segment checked against Street View
// and every panorama that exists already on disk. It answers "where do I no longer need to
// spend Google quota?", which the analysis choropleth underneath cannot say — an area can
// be fully downloaded and entirely unanalysed, and those look identical in the fill colour.
//
// Non-interactive on purpose: the dot must not swallow the click that opens the area popup.
function renderImageryDots() {
  if (state.imageryDotLayer) { map.removeLayer(state.imageryDotLayer); state.imageryDotLayer = null; }

  const dots = visibleAreas()
    .filter((f) => f.properties.images_complete && f.properties.label_point)
    .map((f) => L.circleMarker(
      [f.properties.label_point.coordinates[1], f.properties.label_point.coordinates[0]],
      {
        radius: 5, color: "#0b0d11", weight: 1.5,
        fillColor: "#22c55e", fillOpacity: 1, interactive: false
      }
    ));

  if (dots.length) state.imageryDotLayer = L.layerGroup(dots).addTo(map);
}

function renderAreaLayer() {
  if (state.layer) map.removeLayer(state.layer);
  if (state.segmentLayer) { map.removeLayer(state.segmentLayer); state.segmentLayer = null; }

  const feats = visibleAreas().filter((f) => f.geometry);
  state.layer = L.geoJSON({ type: "FeatureCollection", features: feats }, {
    style: (feat) => {
      const p = feat.properties;
      return {
        color: "#0b0d11",
        weight: 1,
        fillColor: areaColor(pct(p.analysed, p.segments)),
        fillOpacity: state.selected === p.area ? 0.85 : 0.6
      };
    },
    onEachFeature: (feat, layer) => {
      const p = feat.properties;
      layer.bindPopup(`
        <div class="popup-title">${escapeHtml(p.area)}</div>
        <div class="popup-row">${escapeHtml(p.parent || "")}${p.parent ? " · " : ""}krug ${fmt(p.ring_index)}</div>
        <div class="popup-row">${fmt(p.analysed)} / ${fmt(p.segments)} segmenata analizirano (${pct(p.analysed, p.segments).toFixed(0)} %)</div>
        <div class="popup-row">${fmt(p.with_images)} sa snimkama · ${fmt(p.reviewed)} ljudski</div>
        <div class="popup-row">${p.images_complete
          ? `<span class="dot-complete"></span> snimke potpune — nema više preuzimanja`
          : `${fmt(p.imagery_unchecked)} neprovjereno${Number(p.fetchable) > 0 ? ` · ${fmt(p.fetchable)} za preuzimanje` : ""}`}</div>
        ${Number(p.ready_unprocessed) > 0
          ? `<div class="popup-row"><strong>${fmt(p.ready_unprocessed)}</strong> spremno za obradu</div>` : ""}
        <button type="button" class="popup-btn" data-area="${escapeHtml(p.area)}">Prikaži ulice</button>
      `);
      layer.on("click", () => { state.selected = p.area; });
    }
  }).addTo(map);

  renderImageryDots();
  fitTo(state.layer);
}

// Leaflet cached the container size before the stylesheet had laid the page out, so the
// first fitBounds solved for the wrong viewport and left Zagreb as a speck in a wide map.
// invalidateSize() re-measures first; maxZoom stops a single small mjesni odbor from
// zooming past the point where the basemap still gives context.
function fitTo(layer) {
  if (!layer) return;
  map.invalidateSize({ animate: false });
  try {
    map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 16, animate: false });
  } catch {
    /* prazan sloj — nema što uklopiti */
  }
}

async function selectArea(area) {
  state.selected = area;
  renderAreaTable();
  els.detail.hidden = false;
  els.detailTitle.textContent = area;
  els.detailStats.innerHTML = `<span class="chip">učitavanje…</span>`;
  els.segmentTbody.innerHTML = "";

  let data;
  try {
    data = await fetchJson(`${API_BASE}/api/parking/coverage?level=segment&area=${encodeURIComponent(area)}`);
  } catch (err) {
    els.detailStats.innerHTML = `<span class="chip">Greška: ${escapeHtml(err.message)}</span>`;
    return;
  }

  const feats = data.features;
  const tally = feats.reduce((acc, f) => {
    const s = segmentState(f.properties).key;
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const chips = [
    ["ukupno", feats.length],
    ["nije obrađeno", tally.none || 0],
    ["nema Street Viewa", tally.nosv || 0],
    ["snimke spremne", tally.ready || 0],
    ["analizirano", tally.done || 0],
    ["bez parkinga", tally.empty || 0],
    ["≥2 modela", tally.multi || 0],
    ["ljudski", tally.human || 0],
    ["greške", tally.failed || 0]
  ];
  els.detailStats.innerHTML = chips
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<span class="chip">${escapeHtml(k)} <strong>${fmt(v)}</strong></span>`)
    .join("");

  // Keep the features so the hints can be recomputed when the model choice changes — what
  // an analysis run would actually do depends on which model you picked.
  state.selectedFeatures = feats;
  updateRunHints();

  els.segmentTbody.innerHTML = "";
  for (const f of feats) {
    const p = f.properties;
    const st = segmentState(p);
    els.segmentTbody.appendChild(el(`
      <tr>
        <td>${escapeHtml(p.street_name || `segment ${p.road_segment_id}`)}</td>
        <td class="num">${p.length_m == null ? "—" : Math.round(p.length_m)}</td>
        <td class="num">${fmt(p.image_count)} / ${fmt(p.capture_count)}</td>
        <td class="num">${fmt(p.run_count)}</td>
        <td><span class="pill ${st.key}">${escapeHtml(st.label)}</span></td>
      </tr>`));
  }

  // Ulice preko poligona područja, obojene po stanju.
  if (state.segmentLayer) map.removeLayer(state.segmentLayer);
  state.segmentLayer = L.geoJSON(data, {
    style: (feat) => ({ color: segmentState(feat.properties).color, weight: 3, opacity: 0.95 }),
    onEachFeature: (feat, layer) => {
      const p = feat.properties;
      const st = segmentState(p);
      layer.bindPopup(`
        <div class="popup-title">${escapeHtml(p.street_name || `segment ${p.road_segment_id}`)}</div>
        <div class="popup-row">${escapeHtml(st.label)}</div>
        <div class="popup-row">${fmt(p.image_count)} / ${fmt(p.capture_count)} snimaka · ${fmt(p.run_count)} obrada</div>
        ${p.runs ? `<div class="popup-row">${escapeHtml((p.runs || []).join(", "))}</div>` : ""}
      `);
    }
  }).addTo(map);

  fitTo(state.segmentLayer);
  setLegendMode("segments");
  els.legendNote.textContent = `Ulice u području ${area} obojene po stanju obrade.`;
  els.detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// The legend must describe the colours actually on the map. The area choropleth is a
// percentage scale; the street layer is a set of discrete states. Showing the scale over
// street colours does not just look wrong, it asserts something untrue about them.
function setLegendMode(mode) {
  const areas = document.getElementById("legend-areas");
  const segments = document.getElementById("legend-segments");
  if (!areas || !segments) return;
  areas.hidden = mode === "segments";
  segments.hidden = mode !== "segments";
}

function closeDetail() {
  els.detail.hidden = true;
  state.selected = null;
  if (state.segmentLayer) { map.removeLayer(state.segmentLayer); state.segmentLayer = null; }
  setLegendMode("areas");
  els.legendNote.textContent = "Klikni područje za detalje po ulicama.";
  renderAreaTable();
  renderAreaLayer();
}

// --- pokretanje poslova -------------------------------------------------------------

// Job submission lives on the localhost dashboard, not on the shared API: spawning a
// process is something only the machine holding the images and the CLI logins can do, and
// deliberately not something a deployed page can ask for. So the whole panel appears only
// when that dashboard answers, exactly like the "U tijeku sada" strip.
let jobOptions = null;
let openJobLog = null;

function engineNeedsCost(engine) {
  return engine === "openrouter";   // the only metered engine here
}

// Must match slugify()/deriveRunId() in street-view/scripts/process-area.mjs, because the
// point is to predict the run_id that a submitted job will actually create. If they drift,
// the page will claim work is new when it would be resumed, or the reverse.
function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveRunId(area, engine, model) {
  return `${slugify(area)}-${slugify(model || engine)}`;
}

// Croatian numeral agreement: 1 model obradio, 2-4 modela obradila, 5+ modela obradilo,
// with 11-14 taking the 5+ form. Getting this wrong reads as machine-translated, and this
// string appears right next to a button that spends money.
function earlierModelsPhrase(n) {
  const last2 = n % 100;
  const last = n % 10;
  if (last === 1 && last2 !== 11) return `${n} raniji model već obradio područje`;
  if (last >= 2 && last <= 4 && !(last2 >= 12 && last2 <= 14)) return `${n} ranija modela već obradila područje`;
  return `${n} ranijih modela već obradilo područje`;
}

// What the two buttons would actually do, given the area on screen AND the model currently
// selected. Recomputed on every relevant change rather than only when an area is opened:
// switching from Opus to Kimi changes the answer completely, and a stale hint here is
// worse than none — it is the number someone decides to spend model quota on.
function updateRunHints() {
  const feats = state.selectedFeatures;
  const imgHint = document.getElementById("run-images-hint");
  const anaHint = document.getElementById("run-analyze-hint");
  const anaSub = document.getElementById("run-analyze-sub");
  const runAnalyze = document.getElementById("run-analyze");
  const runImages = document.getElementById("run-images");
  if (!feats || !imgHint || !anaHint) return;

  // --- imagery: only count work the fetch can actually do ---
  const fetchable = feats.filter((f) =>
    Number(f.properties.covered_count) > Number(f.properties.image_count)).length;
  const noStreetView = feats.filter((f) =>
    f.properties.imagery_checked && Number(f.properties.covered_count) === 0).length;
  const unchecked = feats.filter((f) => !f.properties.imagery_checked).length;
  const withImages = feats.filter((f) => Number(f.properties.image_count) > 0);

  const imgParts = [];
  if (fetchable) imgParts.push(`${fetchable} za preuzimanje`);
  if (unchecked) imgParts.push(`${unchecked} neprovjereno`);
  if (!imgParts.length) {
    imgParts.push(noStreetView
      ? `sve što postoji je skinuto · ${noStreetView} bez Street Viewa`
      : "sve snimke već postoje");
  }
  imgHint.textContent = imgParts.join(" · ");
  if (runImages) runImages.disabled = fetchable === 0 && unchecked === 0;

  // --- analysis: is this a first pass for the chosen model, or another one? ---
  if (withImages.length === 0) {
    anaHint.textContent = "nema snimaka za analizu";
    if (anaSub) anaSub.textContent = "troši kvotu modela";
    if (runAnalyze) runAnalyze.disabled = true;
    return;
  }
  if (runAnalyze) runAnalyze.disabled = false;

  const engineSel = document.getElementById("opt-engine");
  const modelSel = document.getElementById("opt-model");
  const customEl = document.getElementById("opt-model-custom");
  if (!engineSel || !modelSel) return;
  const engine = engineSel.value;
  const chosen = modelSel.value === "__custom__" ? (customEl?.value.trim() || null) : modelSel.value;
  const runId = deriveRunId(state.selected, engine, chosen);

  // A segment is "done for this model" only if THIS model's run already covers it. Another
  // model having analysed it is not the same thing, and conflating them is what made
  // "0 od 60" read as "nothing has ever been analysed".
  const doneForModel = withImages.filter((f) => (f.properties.runs || []).includes(runId)).length;
  const todoForModel = withImages.length - doneForModel;

  // Which models have been over this area at all — the context that was missing.
  const allRuns = new Set();
  for (const f of withImages) for (const r of f.properties.runs || []) allRuns.add(r);

  if (todoForModel === 0) {
    anaHint.textContent = `svih ${withImages.length} već analizirano ovim modelom — ponovno pokretanje ništa ne mijenja`;
    if (anaSub) anaSub.textContent = "nema novog posla";
    if (runAnalyze) runAnalyze.disabled = true;
  } else if (doneForModel === 0 && allRuns.size > 0) {
    anaHint.textContent = `${todoForModel} segm. za ovaj model · ${earlierModelsPhrase(allRuns.size)}`;
    if (anaSub) anaSub.textContent = "DODATNA OBRADA — troši kvotu";
  } else if (doneForModel > 0) {
    anaHint.textContent = `${todoForModel} od ${withImages.length} preostalo za ovaj model (nastavak)`;
    if (anaSub) anaSub.textContent = "nastavlja prekinutu obradu";
  } else {
    anaHint.textContent = `${todoForModel} segm. — prva obrada ovog područja`;
    if (anaSub) anaSub.textContent = "troši kvotu modela";
  }
}

function populateJobOptions() {
  if (!jobOptions) return;
  const engineSel = document.getElementById("opt-engine");
  const effortSel = document.getElementById("opt-effort");
  if (engineSel.options.length === 0) {
    for (const name of Object.keys(jobOptions.engines)) {
      engineSel.appendChild(el(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`));
    }
    effortSel.appendChild(el(`<option value="">(zadano)</option>`));
    for (const e of jobOptions.efforts) {
      effortSel.appendChild(el(`<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`));
    }
    engineSel.value = "claude-cli";
    engineSel.addEventListener("change", syncModelOptions);
    // The hints answer "what would this model do here", so they have to follow the model
    // choice, not just the area choice.
    document.getElementById("opt-model").addEventListener("change", updateRunHints);
    document.getElementById("opt-model-custom").addEventListener("input", updateRunHints);
    syncModelOptions();
  }
}

function syncModelOptions() {
  const engine = document.getElementById("opt-engine").value;
  const modelSel = document.getElementById("opt-model");
  modelSel.innerHTML = "";
  for (const m of jobOptions.engines[engine] || []) {
    modelSel.appendChild(el(`<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`));
  }
  // OpenRouter's catalogue moves too fast to pin, so it also accepts a typed model name.
  const isOpenRouter = engine === "openrouter";
  modelSel.appendChild(el(`<option value="__custom__">${isOpenRouter ? "drugi…" : "(zadano za motor)"}</option>`));
  document.getElementById("opt-cost-wrap").hidden = !engineNeedsCost(engine);
  modelSel.onchange = () => {
    document.getElementById("opt-model-custom-wrap").hidden =
      !(modelSel.value === "__custom__" && isOpenRouter);
    updateRunHints();
  };
  modelSel.onchange();
}

function currentJobSpec(step) {
  const engine = document.getElementById("opt-engine").value;
  const modelSel = document.getElementById("opt-model").value;
  const custom = document.getElementById("opt-model-custom").value.trim();
  const model = modelSel === "__custom__" ? (custom || null) : modelSel;
  const effort = document.getElementById("opt-effort").value || null;
  const workers = Number(document.getElementById("opt-workers").value) || null;
  const limitRaw = document.getElementById("opt-limit").value;
  const limit = limitRaw === "" ? null : Number(limitRaw);
  const maxCost = engineNeedsCost(engine) ? Number(document.getElementById("opt-max-cost").value) : null;

  const spec = { area: state.selected };

  if (step === "images") {
    // No --write: it only affects the ingest step, which this never reaches.
    // Everything up to and including the image fetch, and nothing after it — so this
    // never calls a model. --through rather than --step because the earlier steps
    // (selection, candidates, metadata) must exist first; asking for the images step
    // alone on a fresh area just fails on a missing candidates.json.
    spec.through = "images";
    // No engine or model: naming one on a job that never calls a model is what made an
    // image download read as an LLM run.
    return spec;
  }

  // Analysis: the full chain. Steps already done skip themselves, so this picks up from
  // wherever the area got to and carries on through the LLM call and the database write.
  spec.step = "full";
  spec.engine = engine;
  spec.write = document.getElementById("opt-write").checked;
  // Only send what was actually chosen — an empty string would become a real (invalid)
  // argv entry.
  if (model) spec.model = model;
  if (effort) spec.effort = effort;
  if (workers) spec.workers = workers;
  if (limit) spec.limit = limit;
  if (maxCost) spec.maxCostUsd = maxCost;
  return spec;
}

async function submitJob(step) {
  const msg = document.getElementById("submit-msg");
  if (!state.selected) {
    msg.textContent = "Prvo odaberi područje.";
    msg.className = "submit-msg err";
    return;
  }
  msg.textContent = "Šaljem…";
  msg.className = "submit-msg";
  try {
    const resp = await fetch(`${LIVE_BASE}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentJobSpec(step))
    });
    const body = await resp.json();
    if (!resp.ok || !body.ok) {
      msg.textContent = (body.errors || [body.error || `HTTP ${resp.status}`]).join(" · ");
      msg.className = "submit-msg err";
      return;
    }
    msg.textContent = `Pokrenuto: ${body.job.label} (${body.job.id})`;
    msg.className = "submit-msg ok";
    pollJobs();
    pollLive();
  } catch (err) {
    msg.textContent = `Ne mogu poslati: ${err.message}`;
    msg.className = "submit-msg err";
  }
}

const JOB_STATUS_LABELS = {
  running: "radi", done: "gotovo", failed: "greška",
  stopped: "prekinut", stopping: "zaustavljam…", unknown: "nepoznato"
};

// Google's free Street View Static allowance for the month, read from Cloud Monitoring (see
// status/budget.mjs) rather than counted from our own downloads. That matters: the same API
// key is used by zagreb-zgrade-datiranje, so a figure derived from this repo's files sees
// only part of the month's spend. It sits near the top rather than beside the download
// button: the quota is a fact about the whole month, and the button panel only appears
// once an area is selected, so anchoring it there would hide the number until you clicked.
let lastBudget = null;

function renderBudget(b) {
  const box = document.getElementById("budget");
  if (!b) { box.hidden = true; return; }
  box.hidden = false;
  lastBudget = b;

  document.getElementById("budget-month").textContent = b.month;
  document.getElementById("budget-num").textContent =
    `${fmt(b.used)} / ${fmt(b.free_quota)}`;

  const fill = document.getElementById("budget-fill");
  fill.style.width = `${Math.min(100, b.pct_used).toFixed(1)}%`;
  // Colour by how close the free allowance is to running out, not by an arbitrary scale:
  // under half is unremarkable, past 80 % the next area might tip into paid.
  box.classList.toggle("warn", b.pct_used >= 80 && b.overage === 0);
  box.classList.toggle("over", b.overage > 0);

  const note = b.overage > 0
    ? `${fmt(b.overage)} preko besplatne kvote · ${b.cost_usd.toFixed(2)} USD (${b.usd_per_1000} USD / 1000)`
    : `još ${fmt(b.remaining)} besplatnih zahtjeva ovaj mjesec`;
  // Said plainly: this is Google's own count for the whole key, so it includes downloads
  // made by other projects — not just what this repo fetched.
  document.getElementById("budget-note").textContent =
    `${note} · Googleov podatak za cijeli ključ, uključuje i druge projekte`;
}

async function pollBudget() {
  try {
    const resp = await fetch(`${LIVE_BASE}/budget`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    renderBudget(await resp.json());
  } catch {
    renderBudget(null);
  }
}

async function pollJobs() {
  const section = document.getElementById("jobs-section");
  let data;
  try {
    const resp = await fetch(`${LIVE_BASE}/jobs`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch {
    section.hidden = true;
    document.getElementById("submit-panel").hidden = true;
    return;
  }

  jobOptions = data.options;
  populateJobOptions();
  document.getElementById("submit-panel").hidden = false;

  const tbody = document.getElementById("jobs-tbody");
  if (!data.jobs.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  tbody.innerHTML = "";
  for (const j of data.jobs.slice(0, 25)) {
    // A job recorded as running whose pid is gone is not running — say so rather than
    // showing a spinner forever.
    const dead = j.status === "running" && !j.alive;
    const label = dead ? "nestao" : (JOB_STATUS_LABELS[j.status] || j.status);
    const tr = el(`
      <tr>
        <td>${escapeHtml(j.label)}<div class="job-id muted">${escapeHtml(j.id)}</div></td>
        <td><span class="pill ${dead ? "failed" : j.status === "done" ? "human" : j.status === "running" ? "done" : j.status === "failed" ? "failed" : "none"}">${escapeHtml(label)}</span>${
          j.exit_code != null && j.exit_code !== 0 ? ` <span class="muted">rc=${j.exit_code}</span>` : ""}</td>
        <td class="muted">${escapeHtml((j.started_at || "").slice(11, 19))}</td>
        <td class="job-actions">
          <button type="button" class="ghost-btn" data-log="${escapeHtml(j.id)}">Log</button>
          ${j.status === "running" && j.alive ? `<button type="button" class="ghost-btn danger" data-stop="${escapeHtml(j.id)}">Stop</button>` : ""}
        </td>
      </tr>`);
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-log]").forEach((b) => {
    b.addEventListener("click", () => showJobLog(b.dataset.log));
  });
  tbody.querySelectorAll("[data-stop]").forEach((b) => {
    b.addEventListener("click", async () => {
      b.disabled = true;
      await fetch(`${LIVE_BASE}/jobs/${encodeURIComponent(b.dataset.stop)}/stop`, { method: "POST" })
        .catch(() => {});
      pollJobs();
    });
  });

  if (openJobLog) showJobLog(openJobLog, true);
}

async function showJobLog(id, quiet = false) {
  const pre = document.getElementById("job-log");
  openJobLog = id;
  try {
    const resp = await fetch(`${LIVE_BASE}/jobs/${encodeURIComponent(id)}/log`, { cache: "no-store" });
    const body = await resp.json();
    pre.textContent = body.log || "(prazan log)";
    pre.hidden = false;
    if (!quiet) pre.scrollIntoView({ behavior: "smooth", block: "nearest" });
    pre.scrollTop = pre.scrollHeight;
  } catch {
    if (!quiet) pre.textContent = "Ne mogu dohvatiti log.";
  }
}

// --- pokretanje ---------------------------------------------------------------

function initMap() {
  map = L.map("map", { center: ZAGREB_CENTER, zoom: DEFAULT_ZOOM, scrollWheelZoom: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
    maxZoom: 20
  }).addTo(map);

  // Gumb u popupu je jedini način da se s karte otvori popis ulica.
  map.on("popupopen", (e) => {
    const btn = e.popup.getElement()?.querySelector(".popup-btn");
    if (btn) btn.addEventListener("click", () => { map.closePopup(); selectArea(btn.dataset.area); });
  });
}

// --- što se obrađuje sada ---------------------------------------------------------

// The localhost-only dashboard (status/server.mjs). Reachable only when it is running on
// this machine, which is exactly when "what is processing right now" is a real question.
// ?liveBase=http://localhost:8018 points this at a second instance — useful when the usual
// dashboard is running older code and you do not want to kill it to try a change.
const LIVE_BASE = new URLSearchParams(window.location.search).get("liveBase")?.replace(/\/$/, "")
  || "http://localhost:8017";
const LIVE_POLL_MS = 5000;
// On prod the dashboard does not exist, so every poll is a guaranteed connection refusal —
// and the browser logs those regardless of the try/catch around the fetch. Backing off to
// once a minute after a few failures keeps that from becoming a permanent console spam,
// while still picking the dashboard up if it is started later.
const LIVE_IDLE_POLL_MS = 60000;
const LIVE_FAILURES_BEFORE_BACKOFF = 3;

const PROCESS_LABELS = {
  "sv-pipeline": "Street View pipeline",
  "sv-images": "Street View snimke",
  "sv-metadata": "Street View metadata",
  "sv-analyze-claude": "Analiza (Claude CLI)",
  "sv-analyze-codex": "Analiza (Codex CLI)",
  "sv-analyze-openrouter": "Analiza (OpenRouter)",
  "fetch-tiles": "Preuzimanje aerial pločica",
  "aerial-llm": "Aerial LLM kartograf",
  "render-composites": "Render composita",
  "detect-vehicles": "YOLO vozila",
  "sam3-segment": "SAM3 segmentacija"
};

let liveFailures = 0;
let liveTimer = null;

// Self-rescheduling rather than setInterval, so the delay can widen once it is clear
// nothing is listening.
function scheduleLivePoll() {
  clearTimeout(liveTimer);
  const delay = liveFailures >= LIVE_FAILURES_BEFORE_BACKOFF ? LIVE_IDLE_POLL_MS : LIVE_POLL_MS;
  liveTimer = setTimeout(pollLive, delay);
}

async function pollLive() {
  const section = document.getElementById("live");
  const body = document.getElementById("live-body");
  const navLive = document.getElementById("nav-live");
  if (!section || !body) return;

  let data;
  try {
    const resp = await fetch(`${LIVE_BASE}/status.json`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
    // Reset here, not after the try block: the finally that reschedules runs before any
    // code following it, so resetting later would leave the next delay computed from the
    // stale failure count and keep a recovered dashboard on the slow poll for one cycle.
    liveFailures = 0;
  } catch {
    // Not running, or we are on prod where it does not exist. Hide rather than explain:
    // an error box about a localhost port is noise on a page about citywide coverage.
    liveFailures += 1;
    if (liveFailures >= 2) {
      section.hidden = true;
      if (navLive) navLive.hidden = true;
    }
    return;
  } finally {
    scheduleLivePoll();
  }

  if (navLive) navLive.hidden = false;

  const running = data.running || [];
  if (running.length === 0) {
    section.hidden = false;
    body.innerHTML = `<div class="live-idle">Ništa se trenutno ne obrađuje.</div>`;
    return;
  }

  section.hidden = false;
  body.innerHTML = "";
  for (const r of running) {
    const label = PROCESS_LABELS[r.process] || r.process;
    const counts = r.total != null
      ? `${fmt(r.current)} / ${fmt(r.total)}`
      : (r.no_heartbeat ? "radi (bez heartbeata)" : fmt(r.current));
    const p = r.total ? Math.min(100, (100 * r.current) / r.total) : 0;
    // A heartbeat that has gone quiet is worth flagging: it is the difference between a
    // slow job and a dead one, and they look identical from a progress count alone.
    const stalled = r.age_seconds > 90 && !r.no_heartbeat;
    body.appendChild(el(`
      <div class="live-card${stalled ? " stalled" : ""}">
        <div class="live-card-head">
          <span class="live-card-name">${escapeHtml(label)}</span>
          ${r.area ? `<span class="live-card-area">${escapeHtml(r.area)}</span>` : ""}
          <span class="live-card-counts">${escapeHtml(counts)}</span>
        </div>
        ${r.total != null ? `<div class="live-bar"><span style="width:${p.toFixed(1)}%"></span></div>` : ""}
        <div class="live-card-msg">${escapeHtml(r.message || "")}${stalled ? ` · ⚠ nema heartbeata ${r.age_seconds} s` : ""}</div>
      </div>`));
  }
}

async function reload() {
  els.summary.innerHTML = `<div class="loading">Učitavanje…</div>`;
  try {
    await loadAreas(state.level);
  } catch (err) {
    els.summary.innerHTML = `<div class="error">Ne mogu dohvatiti status obrade: ${escapeHtml(err.message)}<br>
      <span class="muted">API: ${escapeHtml(API_BASE)}/api/parking/coverage</span></div>`;
  }
}

function init() {
  els.summary = document.getElementById("summary");
  els.areaTbody = document.getElementById("area-tbody");
  els.detail = document.getElementById("detail");
  els.detailTitle = document.getElementById("detail-title");
  els.detailStats = document.getElementById("detail-stats");
  els.segmentTbody = document.getElementById("segment-tbody");
  els.legendNote = document.getElementById("legend-note");

  initMap();

  for (const btn of document.querySelectorAll(".seg-btn")) {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      state.level = btn.dataset.level;
      closeDetail();
      reload();
    });
  }
  document.getElementById("hide-done").addEventListener("change", (e) => {
    state.hideDone = e.target.checked;
    renderAreaTable();
    renderAreaLayer();
  });
  document.getElementById("filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderAreaTable();
    renderAreaLayer();
  });
  document.getElementById("detail-close").addEventListener("click", closeDetail);
  document.getElementById("run-images").addEventListener("click", () => submitJob("images"));
  document.getElementById("run-analyze").addEventListener("click", () => submitJob("analyze"));

  reload();

  // Poll the live dashboard alongside. Deliberately independent of reload(): the coverage
  // numbers change when a run finishes, the live strip changes every few seconds.
  // pollLive reschedules itself, so no interval here.
  pollLive();
  pollJobs();
  setInterval(pollJobs, 5000);
  // Slower than the job poll: the quota only moves while a fetch is running, and the
  // server caches the scan for 30 s anyway, so polling it every 5 s would buy nothing.
  pollBudget();
  setInterval(pollBudget, 30000);
}

document.addEventListener("DOMContentLoaded", init);
