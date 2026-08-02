// Scores one or more model runs against the human verdicts — the "which model is actually
// best" tool.
//
// The comparison is only honest because of parking.segment_coverage. Observations exist
// only where a model said parking is present, so "no observation here" used to be
// ambiguous between "the model looked and said no" and "the model never saw this street".
// Scoring on that ambiguity silently rewards models that skipped work. Coverage removes
// it: a space is scored only if the run actually covered its segment.
//
// Two things are measured, and they are not equally important:
//
//   PRESENCE  is there parking on this kerb at all. Confusion matrix vs the human.
//   MANNER    parallel / perpendicular / diagonal. This one sets how deep a strip of
//             ground gets recorded (2.5 / 5.5 / 3.9 m), so calling perpendicular parking
//             "parallel" throws away more than half the real area. Reported separately,
//             with the area error it implies, because a model can be perfect on presence
//             and still produce badly wrong numbers.
import pg from "pg";
import { readFile } from "fs/promises";
import { pathToFileURL } from "url";
import { bandWidthForManner } from "./lib/parking.mjs";
import { resolveFrom } from "./lib/io.mjs";

const CADASTRE_ENV = resolveFrom(import.meta.url, "../../../cadastre-data/api/.env");

function parseArgs(argv) {
  const args = { runs: [], area: null, includeSuspect: false, json: false, databaseUrl: null, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--run") args.runs.push(argv[++i]);
    else if (argv[i] === "--area") args.area = argv[++i];
    else if (argv[i] === "--include-suspect") args.includeSuspect = true;
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/score-run.mjs [--run ID ...] [--area NAME] [--json]

Scores model runs against parking.verdict — the human decisions — and prints a
league table. With no --run, scores every run that overlaps the ground truth.

Only spaces the run actually COVERED are scored (parking.segment_coverage), so a
run that skipped a street is not credited with a correct "no parking" there.

Options:
  --run ID            Score this run (repeatable). Default: all runs with overlap.
  --area NAME         Restrict to one mjesni odbor or gradska cetvrt
  --include-suspect   Include verdicts marked 'suspect' (excluded by default —
                      they are the cases the human was unsure about)
  --json              Machine-readable output
  --help              Show this message

Where the ground truth is:
  node scripts/score-run.mjs --area "Trešnjevka - sjever"
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

// One row per (verdict space, run) where the run covered that space. The LEFT JOIN onto
// observation is what makes a covered-but-silent space a real negative rather than a hole.
const SQL = `
WITH truth AS (
    SELECT v.segment_id, v.side, v.has_parking, v.parking_manner AS human_manner,
           regexp_replace(v.segment_id, '-s[0-9]+$', '') AS base_id
    FROM parking.verdict v
    WHERE ($3::boolean OR v.review_status <> 'suspect')
),
scoped AS (
    SELECT t.* FROM truth t
    LEFT JOIN parking.road_segment_mo m ON m.road_segment_id::text = t.base_id
    WHERE $2::text IS NULL
       OR lower(m.mo_naziv) = lower($2) OR lower(m.gc_naziv) = lower($2)
)
SELECT r.run_id, r.model, r.engine, r.prompt_version,
       s.segment_id, s.side, s.has_parking, s.human_manner,
       o.parking_manner AS model_manner,
       o.confidence,
       (o.segment_id IS NOT NULL) AS model_says_parking
FROM scoped s
JOIN parking.segment_coverage c
  ON c.segment_id = s.base_id
JOIN parking.run r ON r.run_id = c.run_id
LEFT JOIN parking.observation o
  ON o.run_id = c.run_id AND o.segment_id = s.segment_id AND o.side = s.side
WHERE ($1::text[] IS NULL OR r.run_id = ANY($1))
`;

// Exported for tests: this is where a silent bug would produce a wrong model ranking
// without anything looking broken.
export function scoreRows(rows) {
  const byRun = new Map();
  for (const r of rows) {
    if (!byRun.has(r.run_id)) {
      byRun.set(r.run_id, {
        run_id: r.run_id, model: r.model, engine: r.engine, prompt_version: r.prompt_version,
        n: 0, tp: 0, fp: 0, fn: 0, tn: 0,
        mannerScored: 0, mannerRight: 0,
        depthErrM: 0, depthAbsErrM: 0
      });
    }
    const s = byRun.get(r.run_id);
    s.n += 1;

    if (r.has_parking && r.model_says_parking) s.tp += 1;
    else if (r.has_parking && !r.model_says_parking) s.fn += 1;
    else if (!r.has_parking && r.model_says_parking) s.fp += 1;
    else s.tn += 1;

    // Manner is only meaningful where both sides agree parking exists — comparing the
    // manner of a space the human says is empty measures nothing.
    if (r.has_parking && r.model_says_parking && r.human_manner && r.model_manner) {
      s.mannerScored += 1;
      if (r.human_manner === r.model_manner) s.mannerRight += 1;
      // Signed error shows the direction of the bias: negative means the model
      // systematically records a shallower strip than reality, i.e. under-counts area.
      const d = bandWidthForManner(r.model_manner) - bandWidthForManner(r.human_manner);
      s.depthErrM += d;
      s.depthAbsErrM += Math.abs(d);
    }
  }

  for (const s of byRun.values()) {
    s.precision = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : null;
    s.recall = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : null;
    s.f1 = s.precision != null && s.recall != null && s.precision + s.recall > 0
      ? (2 * s.precision * s.recall) / (s.precision + s.recall) : null;
    s.accuracy = s.n > 0 ? (s.tp + s.tn) / s.n : null;
    s.mannerAccuracy = s.mannerScored > 0 ? s.mannerRight / s.mannerScored : null;
    s.meanDepthBiasM = s.mannerScored > 0 ? s.depthErrM / s.mannerScored : null;
    s.meanDepthErrM = s.mannerScored > 0 ? s.depthAbsErrM / s.mannerScored : null;
  }
  return [...byRun.values()];
}

function fmtPct(x) {
  return x == null ? "  — " : `${(100 * x).toFixed(0)}%`.padStart(4);
}

export async function scoreRuns({ databaseUrl, runs, area, includeSuspect, json }) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(SQL, [runs.length ? runs : null, area, includeSuspect]);
    if (rows.length === 0) {
      console.log("No scoreable overlap: no run has coverage over any human verdict" +
        (area ? ` in "${area}"` : "") + ".");
      console.log("Human verdicts live where you reviewed; run scripts/score-run.mjs --help for where to look.");
      return [];
    }

    const scores = scoreRows(rows).sort((a, b) => (b.f1 ?? -1) - (a.f1 ?? -1));

    if (json) {
      console.log(JSON.stringify(scores, null, 2));
      return scores;
    }

    const truthN = new Set(rows.map((r) => `${r.segment_id}|${r.side}`)).size;
    console.log("");
    console.log(`Model league table${area ? ` — ${area}` : ""}`);
    console.log(`Scored against ${truthN} human verdicts${includeSuspect ? " (including 'suspect')" : ""}. Only spaces a run actually covered count towards it.`);
    console.log("");
    console.log("  model / run                              n    TP  FP  FN  TN   prec  rec   F1   manner  depth bias");
    console.log("  ─────────────────────────────────────  ───  ───  ──  ──  ──   ────  ────  ────  ──────  ──────────");
    for (const s of scores) {
      const label = `${s.model || "?"} · ${s.run_id}`.slice(0, 37);
      console.log(
        `  ${label.padEnd(37)}  ${String(s.n).padStart(3)}  ` +
        `${String(s.tp).padStart(3)} ${String(s.fp).padStart(3)} ${String(s.fn).padStart(3)} ${String(s.tn).padStart(3)}   ` +
        `${fmtPct(s.precision)}  ${fmtPct(s.recall)}  ${fmtPct(s.f1)}   ` +
        `${fmtPct(s.mannerAccuracy)} ${s.mannerScored ? `(${s.mannerRight}/${s.mannerScored})`.padStart(7) : "       "}  ` +
        `${s.meanDepthBiasM == null ? "    —" : `${s.meanDepthBiasM >= 0 ? "+" : ""}${s.meanDepthBiasM.toFixed(2)} m`}`
      );
    }
    console.log("");
    console.log("  TP/FP/FN/TN  presence of parking vs the human decision.");
    console.log("  manner       of the spaces both agree have parking, how often the manner matches.");
    console.log("  depth bias   mean signed error in recorded strip depth from the manner call.");
    console.log("               Negative = the model records a shallower strip than reality, i.e.");
    console.log("               under-counts parking area even when it correctly spots the parking.");
    console.log("");

    const thin = scores.filter((s) => s.n < 10);
    if (thin.length) {
      // A model that looks best on 6 spaces has not been shown to be best.
      console.log(`  NOTE: ${thin.length} run(s) scored on fewer than 10 spaces — too thin to rank on:`);
      for (const s of thin) console.log(`        ${s.run_id} (n=${s.n})`);
      console.log("");
    }
    return scores;
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
  await scoreRuns({ ...args, databaseUrl });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
