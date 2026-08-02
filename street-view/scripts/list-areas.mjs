// The processing queue: every mjesni odbor in Zagreb, ordered in concentric rings out from
// Trg bana Jelacica, with how much of each is already done.
//
// This is the "what do I do next" tool. It answers, per area: how many segments, how many
// have imagery, how many have been analysed at least once, how many by more than one model,
// and how many a human has ruled on. Areas already finished sort to the bottom by default
// so the top of the list is always the next thing worth running.
import pg from "pg";
import { readFile } from "fs/promises";
import { pathToFileURL } from "url";
import { resolveFrom } from "./lib/io.mjs";

const CADASTRE_ENV = resolveFrom(import.meta.url, "../../../cadastre-data/api/.env");

function parseArgs(argv) {
  const args = { level: "mo", limit: 40, all: false, json: false, databaseUrl: null, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--level") args.level = argv[++i];
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--all") args.all = true;
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!["mo", "gc"].includes(args.level)) throw new Error(`--level must be mo or gc, got "${args.level}"`);
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/list-areas.mjs [--level mo|gc] [--limit 40] [--all] [--json]

The processing queue, in concentric rings out from Trg bana Jelacica.
Every name printed here is valid as --area for process-area.mjs.

Options:
  --level mo|gc   mjesni odbor (default, 185 areas) or gradska cetvrt (17)
  --limit N       Show N rows (default 40)
  --all           Include areas that are already fully analysed
  --json          Machine-readable, for scripting a whole ring
  --help          Show this message

Example — process the nearest three unfinished areas:
  node scripts/list-areas.mjs --json --limit 3 | \\
    node -e "JSON.parse(require('fs').readFileSync(0)).forEach(a=>console.log(a.area))"
`);
}

async function loadDatabaseUrl(explicit) {
  if (explicit) return explicit;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = await readFile(CADASTRE_ENV, "utf8");
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    // fall through
  }
  return null;
}

const SQL = (level) => `
SELECT
    ${level === "mo" ? "s.mo_naziv" : "s.gc_naziv"}        AS area,
    ${level === "mo" ? "s.gc_naziv" : "NULL::text"}        AS parent,
    ${level === "mo" ? "MIN(s.ring_index)" : "MIN(s.ring_index)"} AS ring,
    COUNT(*)                                               AS segments,
    ROUND(SUM(s.length_m)::numeric / 1000, 1)              AS km,
    COUNT(*) FILTER (WHERE s.image_count > 0)              AS with_images,
    COUNT(*) FILTER (WHERE s.run_count > 0)                AS analysed,
    COUNT(*) FILTER (WHERE s.run_count > 1)                AS multi_model,
    COUNT(*) FILTER (WHERE s.image_count > 0 AND s.run_count = 0) AS ready_unprocessed,
    COUNT(*) FILTER (WHERE s.verdict_count > 0)            AS reviewed
FROM parking.segment_status s
WHERE ${level === "mo" ? "s.mo_naziv" : "s.gc_naziv"} IS NOT NULL
GROUP BY 1, 2
ORDER BY ring
`;

function bar(done, total, width = 12) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return "█".repeat(filled) + "·".repeat(width - filled);
}

export async function listAreas({ databaseUrl, level, limit, all, json }) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(SQL(level));
    const pending = all ? rows : rows.filter((r) => Number(r.analysed) < Number(r.segments));

    if (json) {
      console.log(JSON.stringify(pending.slice(0, limit), null, 2));
      return pending;
    }

    const totalSeg = rows.reduce((a, r) => a + Number(r.segments), 0);
    const totalDone = rows.reduce((a, r) => a + Number(r.analysed), 0);
    const totalImg = rows.reduce((a, r) => a + Number(r.with_images), 0);
    const totalReady = rows.reduce((a, r) => a + Number(r.ready_unprocessed), 0);

    console.log("");
    console.log(`Zagreb parking — processing queue by ${level === "mo" ? "mjesni odbor" : "gradska četvrt"}`);
    console.log(`Rings measured from Trg bana Jelačića. ${rows.length} areas, ${totalSeg.toLocaleString("hr-HR")} segments.`);
    console.log(`Analysed ${totalDone.toLocaleString("hr-HR")} (${(100 * totalDone / totalSeg).toFixed(1)}%) · imagery for ${totalImg.toLocaleString("hr-HR")} · ${totalReady.toLocaleString("hr-HR")} have images but no analysis yet.`);
    console.log("");
    console.log("  ring  area                                 četvrt                   seg    km   img  done  multi  human  progress");
    console.log("  ────  ───────────────────────────────────  ──────────────────────  ────  ────  ────  ────  ─────  ─────  ────────────");

    for (const r of pending.slice(0, limit)) {
      console.log(
        `  ${String(r.ring).padStart(4)}  ${String(r.area).slice(0, 35).padEnd(35)}  ` +
        `${String(r.parent || "").slice(0, 22).padEnd(22)}  ` +
        `${String(r.segments).padStart(4)}  ${String(r.km).padStart(4)}  ` +
        `${String(r.with_images).padStart(4)}  ${String(r.analysed).padStart(4)}  ` +
        `${String(r.multi_model).padStart(5)}  ${String(r.reviewed).padStart(5)}  ` +
        bar(Number(r.analysed), Number(r.segments))
      );
    }

    const hidden = pending.length - Math.min(limit, pending.length);
    if (hidden > 0) console.log(`\n  … and ${hidden} more unfinished areas (--limit to see them, --all to include finished ones).`);
    if (!all) {
      const finished = rows.length - pending.length;
      if (finished > 0) console.log(`  ${finished} area(s) fully analysed and hidden — pass --all to show them.`);
    }
    console.log("");
    console.log(`Every name above is valid as --area, e.g.  node scripts/process-area.mjs --area "${pending[0]?.area ?? "Zrinjevac"}" --write`);
    console.log("");
    return pending;
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  const databaseUrl = await loadDatabaseUrl(args.databaseUrl);
  if (!databaseUrl) throw new Error("DATABASE_URL not set and cadastre-data/api/.env is unreadable.");
  // databaseUrl last: args carries a null one, and spreading it after would undo the resolve.
  await listAreas({ ...args, databaseUrl });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
