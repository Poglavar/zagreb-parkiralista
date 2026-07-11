// Logic for the localhost processing-status dashboard: polls /status.json
// every 3 s and renders running processes, pipeline stats, and review counts.

const PROCESS_LABELS = {
  "sv-pipeline": "Street View pipeline (orchestrator)",
  "fetch-tiles": "Aerial tile download",
  "sv-images": "Street View slike",
  "sv-metadata": "Street View metadata",
  "sv-analyze-claude": "SV analiza (Claude CLI)",
  "sv-analyze-codex": "SV analiza (Codex CLI)",
  "aerial-llm": "Aerial LLM kartograf",
  "render-composites": "Render composita",
  "detect-vehicles": "YOLO vozila",
  "sam3-segment": "SAM3 segmentacija",
};

function fmt(n) {
  return n == null ? "—" : Number(n).toLocaleString("hr-HR");
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function meterHtml(current, total, small = false) {
  const pct = total ? Math.min(100, (current / total) * 100) : 0;
  return `<div class="meter${small ? " small" : ""}"><span style="width:${pct.toFixed(1)}%"></span></div>`;
}

function renderRunning(running) {
  const wrap = document.getElementById("running");
  wrap.innerHTML = "";
  if (!running.length) {
    wrap.appendChild(el(`<div class="idle-note">Ništa se trenutno ne izvršava.</div>`));
    return;
  }
  for (const r of running) {
    const label = PROCESS_LABELS[r.process] || r.process;
    const stalled = r.age_seconds > 90 && !r.no_heartbeat;
    const counts = r.total != null ? `${fmt(r.current)} / ${fmt(r.total)}` : (r.no_heartbeat ? "radi (bez heartbeata)" : fmt(r.current));
    wrap.appendChild(el(`
      <div class="run-card">
        <div class="head">
          <span class="pulse${stalled ? " stalled" : ""}"></span>
          <span class="name">${label}</span>
          ${r.area ? `<span class="area">${r.area}</span>` : ""}
          <span class="counts">${counts}</span>
        </div>
        ${r.total != null ? meterHtml(r.current, r.total) : ""}
        <div class="msg">${r.message || ""}${stalled ? ` · ⚠ nema heartbeata ${r.age_seconds}s` : ""}</div>
      </div>
    `));
  }
}

function statTile(label, value, sub = "", statusClass = "") {
  return el(`
    <div class="stat-tile ${statusClass}">
      <div class="label">${label}</div>
      <div class="value">${fmt(value)}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ""}
    </div>
  `);
}

function renderAerial(aerial, db) {
  const tiles = document.getElementById("aerial-tiles");
  tiles.innerHTML = "";
  tiles.appendChild(statTile("CDOF tile-ovi", aerial.tiles, `${fmt(aerial.tile_jpgs)} JPEG previewa`));
  tiles.appendChild(statTile("Compositi", aerial.composites));
  tiles.appendChild(statTile("YOLO vozila", aerial.vehicles));
  tiles.appendChild(statTile("LLM prijedlozi", aerial.llm.proposals));
  if (db?.available) {
    const rev = db.aerial_review || {};
    tiles.appendChild(statTile("Čeka provjeru", rev.pending || 0, "", (rev.pending || 0) > 0 ? "status-warning" : ""));
    tiles.appendChild(statTile("Potvrđeno", rev.confirmed || 0, `${fmt(rev.rejected || 0)} odbijeno`, "status-good"));
  }

  const meters = document.getElementById("aerial-meters");
  meters.innerHTML = "";
  const { composites_processed, composites_total } = aerial.llm;
  meters.appendChild(el(`
    <div class="meter-row">
      <div class="label-line">
        <span class="label">LLM obrada composita</span>
        <span class="value">${fmt(composites_processed)} / ${fmt(composites_total)}</span>
      </div>
      ${meterHtml(composites_processed, composites_total)}
    </div>
  `));
  if (db?.available) {
    const rev = db.aerial_review || {};
    const totalCand = (rev.pending || 0) + (rev.confirmed || 0) + (rev.rejected || 0);
    const reviewed = (rev.confirmed || 0) + (rev.rejected || 0);
    meters.appendChild(el(`
      <div class="meter-row">
        <div class="label-line">
          <span class="label">Ljudska provjera aerial kandidata</span>
          <span class="value">${fmt(reviewed)} / ${fmt(totalCand)}</span>
        </div>
        ${meterHtml(reviewed, totalCand)}
      </div>
    `));
  }
}

function renderStreetView(sv, db) {
  const revWrap = document.getElementById("sv-review");
  revWrap.innerHTML = "";
  if (db?.available) {
    const rev = db.street_review || {};
    const total = (rev.pending || 0) + (rev.confirmed || 0) + (rev.suspect || 0);
    revWrap.appendChild(statTile("Poligona u bazi", total));
    revWrap.appendChild(statTile("Čeka provjeru", rev.pending || 0, "", (rev.pending || 0) > 0 ? "status-warning" : ""));
    revWrap.appendChild(statTile("Potvrđeno", rev.confirmed || 0, "", "status-good"));
    revWrap.appendChild(statTile("Sumnjivo", rev.suspect || 0, "", (rev.suspect || 0) > 0 ? "status-danger" : ""));
  }

  const tbody = document.getElementById("sv-tbody");
  tbody.innerHTML = "";
  for (const a of sv.areas) {
    const coveredForMeter = a.captures_covered ?? a.captures;
    tbody.appendChild(el(`
      <tr>
        <td>${a.area}</td>
        <td class="num">${fmt(a.segments)}</td>
        <td class="num">${fmt(a.captures)}</td>
        <td class="num">${fmt(a.captures_covered)}</td>
        <td style="min-width:140px">
          <span class="mini-count">${fmt(a.images_downloaded)} / ${fmt(coveredForMeter)}</span>
          ${meterHtml(a.images_downloaded, coveredForMeter, true)}
        </td>
        <td class="num">${fmt(a.analyzed.openai)}</td>
        <td class="num">${fmt(a.analyzed.claude)}</td>
        <td class="num">${fmt(a.analyzed.codex)}</td>
      </tr>
    `));
  }
}

function renderRecent(recent) {
  const wrap = document.getElementById("recent");
  wrap.innerHTML = "";
  if (!recent.length) {
    wrap.appendChild(el(`<div class="idle-note">Nema nedavnih zapisa.</div>`));
    return;
  }
  for (const r of recent.slice(0, 10)) {
    const label = PROCESS_LABELS[r.process] || r.process;
    const age = r.age_seconds > 3600 ? `prije ${Math.round(r.age_seconds / 3600)} h` : `prije ${Math.round(r.age_seconds / 60)} min`;
    wrap.appendChild(el(`
      <div class="recent-item">
        <span class="name">${label}</span>
        ${r.area ? `<span>${r.area}</span>` : ""}
        <span>${fmt(r.current)}${r.total != null ? ` / ${fmt(r.total)}` : ""}</span>
        <span>${r.done ? "✓ završeno" : "prekinuto"}</span>
        <span class="age">${age}</span>
      </div>
    `));
  }
}

async function refresh() {
  try {
    const res = await fetch("/status.json", { cache: "no-store" });
    const s = await res.json();
    renderRunning(s.running || []);
    renderAerial(s.aerial, s.db);
    renderStreetView(s.street_view, s.db);
    renderRecent(s.recent || []);
    document.getElementById("refreshed").textContent =
      `osvježeno ${new Date(s.generated_at).toLocaleTimeString("hr-HR")}`;
  } catch (err) {
    document.getElementById("refreshed").textContent = `greška: ${err.message}`;
  }
}

refresh();
setInterval(refresh, 3000);
