// Heartbeat writer for the localhost processing-status dashboard.
// Long-running street-view scripts call reportProgress() inside their loops;
// it writes data/status/<process>.json (repo root, atomic, throttled to 1/s)
// which status/server.mjs picks up. Gitignored, never deployed.
import { mkdirSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const STATUS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/status");

const lastWrite = new Map();

export function reportProgress(process_, { current, total = null, message = "", area = null, done = false }) {
  const now = Date.now();
  if (!done && now - (lastWrite.get(process_) || 0) < 1000) return;
  lastWrite.set(process_, now);

  try {
    mkdirSync(STATUS_DIR, { recursive: true });
    const payload = {
      process: process_,
      area,
      current,
      total,
      message,
      done,
      pid: process.pid,
      updated_at: new Date().toISOString()
    };
    const tmp = path.join(STATUS_DIR, `.${process_}.json.tmp`);
    const final = path.join(STATUS_DIR, `${process_}.json`);
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, final);
  } catch {
    // a status heartbeat must never take the pipeline down
  }
}
