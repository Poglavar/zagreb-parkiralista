// Job manager for the localhost status server: submit, track, tail and stop pipeline runs
// (process-area.mjs) without going to a terminal.
//
// SECURITY. This module turns an HTTP request into a spawned process, so it is the one
// place in this repo where getting it wrong is dangerous rather than merely wrong. Two
// rules hold the whole thing up:
//
//   1. NEVER build a shell string. Everything goes through spawn() with an argv ARRAY and
//      no shell, so an area name containing ; or $() is one harmless argv element.
//   2. Every field is checked against an allowlist before it becomes an argument, and any
//      value starting with "-" is refused — otherwise an "area" of "--write" would smuggle
//      a flag into the command line even though the shell is out of the picture.
//
// validateJobSpec is pure and exported on its own so those rules can be tested directly,
// without spawning anything.
import { spawn } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";

// Steps the UI may run. `full` means the whole chain, which is process-area's own default.
export const STEPS = ["full", "selection", "candidates", "metadata", "images", "analyze", "ingest"];

// Engines, and which models the UI offers for each. Free-form model strings are allowed
// only for openrouter, whose model names are vendor-scoped and change constantly; the
// leading-dash check below still applies to them.
export const ENGINE_MODELS = {
  "claude-cli": ["opus", "sonnet", "haiku", "claude-fable-5"],
  "codex-cli": ["gpt-5.3-codex-spark", "gpt-5.6-sol", "gpt-5.4"],
  "openrouter": ["moonshotai/kimi-k3", "google/gemini-3-pro", "qwen/qwen3-vl-235b"],
  "openai-batch": ["gpt-5.4"]
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const MAX_WORKERS = 8;
const MAX_LIMIT = 5000;
const MAX_AREA_LEN = 120;

// A value that reaches argv must not look like a flag, must be a single line, and must be
// plain text. spawn() without a shell already defuses metacharacters; this defuses the one
// thing spawn cannot, which is a positional value being read as an option.
function safeArg(value, label) {
  const s = String(value);
  if (s.length === 0) return `${label} is empty`;
  if (s.length > MAX_AREA_LEN) return `${label} is too long`;
  if (s.startsWith("-")) return `${label} may not start with "-"`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) return `${label} contains control characters`;
  return null;
}

// Pure: spec in, argv out (or a reason why not). No filesystem, no process, no database —
// so the security rules above are testable in isolation.
export function validateJobSpec(spec = {}) {
  const errors = [];
  const {
    area, benchmark = false, step = "full", engine = "claude-cli",
    model, effort, workers, limit, maxCostUsd, write = false
  } = spec;

  if (!benchmark) {
    if (typeof area !== "string" || area.trim() === "") {
      errors.push("area is required unless benchmark is set");
    } else {
      const bad = safeArg(area.trim(), "area");
      if (bad) errors.push(bad);
    }
  }

  if (!STEPS.includes(step)) errors.push(`step must be one of: ${STEPS.join(", ")}`);
  if (!ENGINE_MODELS[engine]) errors.push(`engine must be one of: ${Object.keys(ENGINE_MODELS).join(", ")}`);

  if (model != null) {
    const bad = safeArg(model, "model");
    if (bad) errors.push(bad);
    // Known engines get a closed list; openrouter is open because its catalogue changes
    // weekly and pinning it here would just go stale.
    else if (engine !== "openrouter" && ENGINE_MODELS[engine] && !ENGINE_MODELS[engine].includes(model)) {
      errors.push(`model "${model}" is not offered for engine ${engine}`);
    }
  }

  if (effort != null && !EFFORTS.includes(effort)) errors.push(`effort must be one of: ${EFFORTS.join(", ")}`);

  // codex-cli's config default is "max", which gpt-5.3-codex-spark rejects outright with a
  // 400. Catching it here turns a run that dies on every segment into a refusal to start.
  if (engine === "codex-cli" && effort === "max" && String(model).includes("spark")) {
    errors.push('gpt-5.3-codex-spark does not support effort "max" — use up to xhigh');
  }

  if (workers != null) {
    const n = Number(workers);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS) errors.push(`workers must be an integer 1-${MAX_WORKERS}`);
  }
  if (limit != null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) errors.push(`limit must be an integer 1-${MAX_LIMIT}`);
  }
  if (maxCostUsd != null) {
    const n = Number(maxCostUsd);
    if (!Number.isFinite(n) || n <= 0 || n > 100) errors.push("maxCostUsd must be a number 0-100");
  }
  if (typeof write !== "boolean") errors.push("write must be a boolean");

  if (errors.length) return { ok: false, errors };

  const argv = ["scripts/process-area.mjs"];
  if (benchmark) argv.push("--benchmark");
  else argv.push("--area", area.trim());
  if (step !== "full") argv.push("--step", step);
  argv.push("--engine", engine);
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (workers != null) argv.push("--workers", String(Number(workers)));
  if (limit != null) argv.push("--limit", String(Number(limit)));
  if (maxCostUsd != null) argv.push("--max-cost-usd", String(Number(maxCostUsd)));
  if (write) argv.push("--write");

  return { ok: true, argv };
}

// Short human label for the jobs list.
export function describeJob(spec) {
  const target = spec.benchmark ? "benchmark" : spec.area;
  const what = spec.step === "full" || !spec.step ? "cijeli pipeline" : spec.step;
  const who = spec.model ? `${spec.engine}/${spec.model}` : spec.engine;
  return `${target} · ${what} · ${who}${spec.write ? " · piše u bazu" : " · dry run"}`;
}

// --- runner -------------------------------------------------------------------------

export class JobRunner {
  // cwd is street-view/, where process-area.mjs and its relative paths live.
  constructor({ cwd, logDir, stateFile, env = process.env }) {
    this.cwd = cwd;
    this.logDir = logDir;
    this.stateFile = stateFile;
    this.env = env;
    this.jobs = new Map();   // id -> job record
    this.children = new Map(); // id -> ChildProcess (only for jobs this instance started)
    this.seq = 0;
  }

  async init() {
    await mkdir(this.logDir, { recursive: true });
    // Jobs outlive the server (they are real processes), so reload what was running and
    // check whether those pids are still alive. Without this a server restart would
    // silently orphan a two-hour Opus run and show nothing.
    try {
      const prior = JSON.parse(await readFile(this.stateFile, "utf8"));
      let corrected = false;
      for (const job of prior.jobs || []) {
        if ((job.status === "running" || job.status === "stopping") && !isAlive(job.pid)) {
          job.status = "unknown";
          job.ended_at = job.ended_at || new Date().toISOString();
          job.note = "server je bio ugašen dok je posao trajao — ishod nije zabilježen, pogledaj log";
          corrected = true;
        }
        this.jobs.set(job.id, job);
        this.seq = Math.max(this.seq, Number(String(job.id).split("-").pop()) || 0);
      }
      // Write the correction back. Fixing it only in memory leaves a state file that still
      // claims a dead job is running — self-healing on every boot, but a lie to anything
      // that reads the file in between, and the whole point of this page is not lying
      // about what is running.
      if (corrected) await this.persist();
    } catch {
      // no state yet
    }
  }

  async persist() {
    const jobs = [...this.jobs.values()].slice(-100);
    await writeFile(this.stateFile, JSON.stringify({ jobs }, null, 2));
  }

  // A job reattached after a server restart has no child handle here, so its 'exit' event
  // will never fire and it would sit at "running" forever once the process ends. Reconcile
  // against the real pid instead of only decorating the stale record — otherwise the list
  // keeps claiming a finished run is still going, which is exactly the thing this page
  // exists to stop happening.
  reconcile() {
    let changed = false;
    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.status !== "stopping") continue;
      if (isAlive(job.pid)) continue;
      if (this.children.has(job.id)) continue;   // ours; the exit handler will set it
      job.status = job.status === "stopping" ? "stopped" : "unknown";
      job.ended_at = job.ended_at || new Date().toISOString();
      if (job.status === "unknown") {
        job.note = "proces je završio dok server nije gledao — ishod nije zabilježen, pogledaj log";
      }
      changed = true;
    }
    if (changed) this.persist().catch(() => {});
    return changed;
  }

  list() {
    this.reconcile();
    return [...this.jobs.values()]
      .map((j) => ({ ...j, alive: j.status === "running" ? isAlive(j.pid) : false }))
      .sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  // Refuse a second run of the same target+engine+model rather than letting two processes
  // fight over the same analyses file — they both resume-skip from it, so the loser
  // silently does nothing and the log looks fine.
  findConflict(spec) {
    const key = jobKey(spec);
    for (const j of this.jobs.values()) {
      if (j.status === "running" && isAlive(j.pid) && jobKey(j.spec) === key) return j;
    }
    return null;
  }

  async submit(spec, timestamp) {
    const validation = validateJobSpec(spec);
    if (!validation.ok) return { ok: false, errors: validation.errors };

    const conflict = this.findConflict(spec);
    if (conflict) {
      return { ok: false, errors: [`isti posao već radi (${conflict.id})`] };
    }

    this.seq += 1;
    const id = `job-${this.seq}`;
    const logPath = path.join(this.logDir, `${id}.log`);
    const out = createWriteStream(logPath, { flags: "a" });

    const child = spawn("node", validation.argv, {
      cwd: this.cwd,
      env: this.env,
      // No shell, ever. detached so the run survives this server being restarted; the
      // reconcile in init() is what picks it back up.
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);

    const job = {
      id,
      pid: child.pid,
      spec,
      label: describeJob(spec),
      argv: validation.argv,
      log: path.basename(logPath),
      status: "running",
      exit_code: null,
      started_at: timestamp,
      ended_at: null
    };
    this.jobs.set(id, job);
    this.children.set(id, child);

    child.on("exit", async (code, signal) => {
      job.status = code === 0 ? "done" : (signal ? "stopped" : "failed");
      job.exit_code = code;
      job.signal = signal || null;
      job.ended_at = new Date().toISOString();
      this.children.delete(id);
      out.end();
      await this.persist().catch(() => {});
    });
    child.on("error", async (err) => {
      job.status = "failed";
      job.note = err.message;
      job.ended_at = new Date().toISOString();
      this.children.delete(id);
      out.end();
      await this.persist().catch(() => {});
    });

    child.unref();
    await this.persist();
    return { ok: true, job };
  }

  async stop(id) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, errors: ["nepoznat posao"] };
    if (job.status !== "running") return { ok: false, errors: [`posao je već "${job.status}"`] };
    try {
      // Negative pid kills the whole process group: process-area spawns claude/codex
      // children, and killing only the parent leaves those running and still billing.
      process.kill(-job.pid, "SIGTERM");
    } catch {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch (err) {
        return { ok: false, errors: [`ne mogu zaustaviti: ${err.message}`] };
      }
    }
    job.status = "stopping";
    await this.persist();
    return { ok: true, job };
  }

  async tail(id, maxBytes = 16_000) {
    const job = this.jobs.get(id);
    if (!job) return null;
    try {
      const buf = await readFile(path.join(this.logDir, job.log));
      return buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString("utf8") : buf.toString("utf8");
    } catch {
      return "";
    }
  }
}

function jobKey(spec) {
  return [spec.benchmark ? "__benchmark__" : spec.area, spec.step || "full", spec.engine, spec.model || ""].join("|");
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
