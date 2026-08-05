// Records what imagery an area actually has into parking.segment_imagery, without running
// any model. This is what makes a finished image fetch visible on the status map.
//
// Run it standalone to repair an area that was fetched before the images step started
// doing this itself:
//   node scripts/record-imagery.mjs --area vrbani
import pg from "pg";
import path from "path";
import { pathToFileURL } from "url";
import { fileExists, readJson, resolveFrom } from "./lib/io.mjs";
import { tallyImagery, writeImagery, summariseImagery } from "./lib/imagery-inventory.mjs";

const OUT_ROOT = resolveFrom(import.meta.url, "..", "out");

function printHelp() {
  console.log(`Usage: node scripts/record-imagery.mjs --area SLUG [options]

Reads an area's candidates / metadata / images manifests and writes one row per road
segment to parking.segment_imagery. No model is called and nothing is downloaded, so this
is free and safe to re-run — the upsert keeps the max of what any pass has seen.

Options:
  --area SLUG          Area directory under out/ (e.g. vrbani, benchmark)
  --dir PATH           Use this directory instead of out/<slug>
  --source NAME        google_street_view (default) | panoramax
  --database-url URL   Defaults to $DATABASE_URL
  --dry-run            Tally and print, write nothing
  --help               Show this message
`);
}

function parseArgs(argv) {
  const args = {
    area: null, dir: null, source: "google_street_view",
    databaseUrl: process.env.DATABASE_URL, dryRun: false, help: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--area") args.area = argv[++i];
    else if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--source") args.source = argv[++i];
    else if (argv[i] === "--database-url") args.databaseUrl = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

// Exported so process-area.mjs can call this straight after its images step instead of
// spawning a second node process. Returns null when there is nothing to record, which is
// not an error — an area whose fetch has not run yet simply has no manifests.
export async function recordImagery({ candidates, metadata, images, source, databaseUrl, dryRun, log = console.log }) {
  if (!await fileExists(candidates)) {
    log(`  imagery: no candidates manifest at ${path.basename(candidates)} — nothing to record`);
    return null;
  }

  const candidateData = await readJson(candidates);
  const imageData = await fileExists(images) ? await readJson(images) : null;
  const metaData = await fileExists(metadata) ? await readJson(metadata) : null;

  // Without the metadata preflight, covered_count would be 0 for every segment — and a
  // recorded 0 does not mean "not checked yet", it means "Google has no panorama here".
  // Writing it would paint a never-fetched area as permanently unavailable, which is a
  // worse state than being absent: absent is honest about not knowing. Several areas have
  // a candidates.json and nothing else, so this is a real case, not a defensive branch.
  if (!metaData) {
    log(`  imagery: no metadata manifest at ${path.basename(metadata)} — refusing to record, ` +
      `covered_count would falsely claim ${(candidateData.segments || []).length} segments have no Street View`);
    return null;
  }

  const inventory = tallyImagery({
    candidateSegments: candidateData.segments || [],
    imageRecords: imageData?.images || [],
    metadataResults: metaData?.results || []
  });
  const sum = summariseImagery(inventory);
  const shape = `${sum.segments} segmenata · ${sum.with_images} sa snimkama · ` +
    `${sum.no_streetview} bez Street Viewa · ${sum.fetchable} za preuzimanje`;

  if (dryRun) {
    log(`  imagery (dry run): ${shape}`);
    return { ...sum, written: 0 };
  }
  if (!databaseUrl) {
    // Loud, not silent: the fetch succeeded but the map will not show it.
    log(`  imagery: DATABASE_URL not set — ${sum.segments} segments NOT recorded, the map will not show this area`);
    return { ...sum, written: 0 };
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    try {
      const written = await writeImagery(client, source, inventory);
      log(`  imagery: recorded ${written} segments (${shape})`);
      return { ...sum, written };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.area && !args.dir)) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const dir = args.dir || path.join(OUT_ROOT, args.area);
  const result = await recordImagery({
    candidates: path.join(dir, "candidates.json"),
    metadata: path.join(dir, "street-view-metadata.json"),
    images: path.join(dir, "street-view-images.json"),
    source: args.source,
    databaseUrl: args.databaseUrl,
    dryRun: args.dryRun
  });

  if (result === null) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
