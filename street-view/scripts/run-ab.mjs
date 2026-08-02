// Runs the prompt-variant A/B over the benchmark set and scores the result.
//
// The experiment: hold the model, the segments and the schema fixed, vary only what the
// model is shown, and score every variant against the same human verdicts. That is the only
// way "would an orthophoto help?" becomes a number rather than an opinion.
//
// Everything about it is resumable. Each variant writes its own analyses file (the variant
// is part of the filename and the run id), each engine skips segments already present in
// its file, and the orthophoto crops are cached on disk. Killing this mid-run and starting
// it again costs progress, never correctness.
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import { resolveFrom } from "./lib/io.mjs";
import { VARIANTS } from "./lib/prompt-variants.mjs";

const HERE = resolveFrom(import.meta.url, "..");

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    model: "sonnet",
    variants: Object.keys(VARIANTS),
    workers: 3,
    limit: null,
    write: false,
    help: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--variants") args.variants = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--workers") args.workers = Number(argv[++i]);
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  for (const v of args.variants) {
    if (!VARIANTS[v]) throw new Error(`Unknown variant "${v}" (have: ${Object.keys(VARIANTS).join(", ")})`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/run-ab.mjs [--model sonnet] [--variants sv,sv-osm,sv-ortho,sv-osm-ortho] [--write]

Runs each prompt variant over the benchmark set (the segments carrying human
verdicts) with ONE model held constant, then prints the league table.

Only --write actually ingests; without it the runs happen but nothing reaches the
database, so nothing can be scored. For a real comparison you want --write.

Options:
  --model NAME      Model to hold constant across variants (default sonnet)
  --variants LIST   Comma-separated (default: all four)
  --workers N       Parallel CLI calls per variant (default 3; 4+ has been observed
                    to drive this laptop's load average past 100 and make each call
                    3x slower, which is a net loss)
  --limit N         Only N segments per variant — for a quick smoke test
  --write           Ingest each run so score-run.mjs can see it
  --help            Show this message
`);
}

function run(cmd, cmdArgs, label) {
  return new Promise((resolve) => {
    log(`--- ${label} ---`);
    const proc = spawn(cmd, cmdArgs, { cwd: HERE, stdio: "inherit" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  if (!args.write) {
    log("NOTE: running without --write. The analyses files will be produced but nothing is");
    log("      ingested, so score-run.mjs will have nothing new to score.");
  }

  const done = [];
  const failed = [];
  for (const variant of args.variants) {
    const cmdArgs = [
      "scripts/process-area.mjs",
      "--benchmark",
      "--variant", variant,
      "--engine", "claude-cli",
      "--model", args.model,
      "--workers", String(args.workers)
    ];
    if (args.limit) cmdArgs.push("--limit", String(args.limit));
    if (args.write) cmdArgs.push("--write");
    const ok = await run("node", cmdArgs, `variant ${variant} (${VARIANTS[variant].label})`);
    (ok ? done : failed).push(variant);
    if (!ok) log(`variant ${variant} FAILED — continuing with the rest so one bad variant does not lose the others`);
  }

  log("");
  log(`Variants completed: ${done.join(", ") || "none"}`);
  if (failed.length) log(`Variants FAILED: ${failed.join(", ")}`);

  if (args.write && done.length) {
    log("");
    await run("node", ["scripts/score-run.mjs"], "scoring all runs against the human verdicts");
  }

  // A partial A/B must not read as a complete one.
  if (failed.length) {
    console.error(`[${ts()}] ${failed.length} of ${args.variants.length} variants failed — the comparison is incomplete.`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[${ts()}] FATAL: ${err.message}`);
    process.exit(1);
  });
}
