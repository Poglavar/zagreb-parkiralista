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
  layer: null,
  segmentLayer: null
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
        ${Number(p.ready_unprocessed) > 0
          ? `<div class="popup-row"><strong>${fmt(p.ready_unprocessed)}</strong> spremno za obradu</div>` : ""}
        <button type="button" class="popup-btn" data-area="${escapeHtml(p.area)}">Prikaži ulice</button>
      `);
      layer.on("click", () => { state.selected = p.area; });
    }
  }).addTo(map);

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

  // Say what each button would actually do here before it is pressed. "Skini snimke" on an
  // area that already has them is a no-op, and analysing an area with no imagery cannot
  // work at all — both are worth knowing without reading the log afterwards.
  const missingImages = feats.filter((f) => Number(f.properties.image_count) === 0).length;
  const unanalysed = feats.filter((f) => Number(f.properties.run_count) === 0).length;
  const imgHint = document.getElementById("run-images-hint");
  const anaHint = document.getElementById("run-analyze-hint");
  if (imgHint) {
    imgHint.textContent = missingImages === 0
      ? "sve snimke već postoje"
      : `${missingImages} segm. bez snimaka`;
  }
  if (anaHint) {
    anaHint.textContent = feats.length - missingImages === 0
      ? "nema snimaka za analizu"
      : `${unanalysed} segm. neanalizirano`;
  }
  const runAnalyze = document.getElementById("run-analyze");
  if (runAnalyze) runAnalyze.disabled = (feats.length - missingImages) === 0;

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

  const spec = {
    area: state.selected,
    step,
    engine,
    write: document.getElementById("opt-write").checked
  };
  // Only send what was actually chosen — the validator rejects nulls it does not expect,
  // and an empty string would become a real (invalid) argv entry.
  if (model) spec.model = model;
  if (effort) spec.effort = effort;
  if (workers) spec.workers = workers;
  if (limit) spec.limit = limit;
  if (maxCost) spec.maxCostUsd = maxCost;
  // The image fetch has no model or engine dimension; sending them would only produce a
  // second analyses filename for a step that writes none.
  if (step === "images") {
    delete spec.model;
    delete spec.effort;
    delete spec.maxCostUsd;
  }
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
const LIVE_BASE = "http://localhost:8017";
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
}

document.addEventListener("DOMContentLoaded", init);
