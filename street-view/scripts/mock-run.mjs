// This script creates a fully local mock run so the review loop can be opened without live Google/OpenAI keys.
import path from "path";
import { pathToFileURL } from "url";
import { buildParkingAreas } from "./build-parking-areas.mjs";
import { buildReviewBundle } from "./build-review-bundle.mjs";
import { importRoadWidthDemo } from "./import-road-width-demo.mjs";
import { prepareCandidates } from "./prepare-candidates.mjs";
import { ensureDir, resolveFrom, writeJson, writeText } from "./lib/io.mjs";

function buildMockAssessment(segmentId) {
  if (segmentId === "1") {
    return {
      decision: "right",
      confidence: 0.78,
      overall_notes: "Mock result: cars appear to use the right edge as recurring informal parking.",
      segment_left: {
        parking_present: false,
        parking_manner: "none",
        parking_level: "unknown",
        formality: "unknown",
        confidence: 0.76,
        evidence: ["No recurring left-side parking cues in mock dataset."]
      },
      segment_right: {
        parking_present: true,
        parking_manner: "parallel",
        parking_level: "sidewalk",
        formality: "informal",
        confidence: 0.78,
        evidence: ["Cars aligned along the edge.", "Parking footprint appears elevated."]
      }
    };
  }

  if (segmentId === "5") {
    return {
      decision: "both",
      confidence: 0.61,
      overall_notes: "Mock result: both sides show recurring curb use, but one side looks more formal than the other.",
      segment_left: {
        parking_present: true,
        parking_manner: "parallel",
        parking_level: "road_level",
        formality: "formal",
        confidence: 0.67,
        evidence: ["Linear curb use.", "Looks like designated curb parking."]
      },
      segment_right: {
        parking_present: true,
        parking_manner: "parallel",
        parking_level: "road_level",
        formality: "mixed",
        confidence: 0.56,
        evidence: ["Regular curb use.", "Designation not fully clear in mock data."]
      }
    };
  }

  return {
    decision: "none",
    confidence: 0.72,
    overall_notes: "Mock result: no recurring curb parking behavior.",
    segment_left: {
      parking_present: false,
      parking_manner: "none",
      parking_level: "unknown",
      formality: "unknown",
      confidence: 0.72,
      evidence: ["No recurring parked-car pattern in mock view."]
    },
    segment_right: {
      parking_present: false,
      parking_manner: "none",
      parking_level: "unknown",
      formality: "unknown",
      confidence: 0.72,
      evidence: ["No recurring parked-car pattern in mock view."]
    }
  };
}

function placeholderSvg({ title, subtitle, heading }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect width="640" height="640" fill="#f3f0e8" />
  <rect x="32" y="32" width="576" height="576" rx="24" fill="#e7dcc8" stroke="#1e293b" stroke-width="4" />
  <path d="M80 430 C180 360, 280 340, 560 380" fill="none" stroke="#334155" stroke-width="20" stroke-linecap="round" />
  <path d="M110 430 C180 380, 270 360, 520 395" fill="none" stroke="#64748b" stroke-width="8" stroke-dasharray="18 14" stroke-linecap="round" />
  <rect x="118" y="310" width="72" height="34" rx="8" fill="#d97706" />
  <rect x="406" y="420" width="74" height="34" rx="8" fill="#2563eb" />
  <rect x="474" y="412" width="88" height="42" rx="10" fill="#0f766e" opacity="0.85" />
  <text x="64" y="96" font-family="Georgia, serif" font-size="34" fill="#0f172a">${title}</text>
  <text x="64" y="136" font-family="Georgia, serif" font-size="20" fill="#334155">${subtitle}</text>
  <text x="64" y="190" font-family="Menlo, monospace" font-size="18" fill="#334155">Mock capture only. Replace with live Street View output.</text>
  <text x="64" y="220" font-family="Menlo, monospace" font-size="18" fill="#334155">Heading ${heading.toFixed(1)}°</text>
</svg>`;
}

async function writeMockImages(candidateData, imageDir) {
  await ensureDir(imageDir);
  const images = [];

  for (const segment of candidateData.segments) {
    for (const capture of segment.captures) {
      const relativePath = `out/mock-images/${capture.capture_id}.svg`;
      const absolutePath = path.resolve(imageDir, `${capture.capture_id}.svg`);
      await writeText(
        absolutePath,
        placeholderSvg({
          title: segment.label,
          subtitle: `${capture.direction} view, station ${capture.station_index + 1}`,
          heading: capture.heading
        })
      );
      images.push({
        capture_id: capture.capture_id,
        segment_id: segment.segment_id,
        ok: true,
        image_path: relativePath,
        pano_id: "MOCK"
      });
    }
  }

  return images;
}

export async function runMock() {
  const demoSegmentsPath = resolveFrom(import.meta.url, "../data/demo-segments.geojson");
  const candidatesPath = resolveFrom(import.meta.url, "../out/candidates.json");
  const metadataPath = resolveFrom(import.meta.url, "../out/street-view-metadata.json");
  const imagesPath = resolveFrom(import.meta.url, "../out/street-view-images.json");
  const analysesPath = resolveFrom(import.meta.url, "../out/openai-analyses.json");
  const imageDir = resolveFrom(import.meta.url, "../out/mock-images");

  await importRoadWidthDemo({
    source: resolveFrom(import.meta.url, "../../../zagreb-road-widths/data/road-width-zagreb.json"),
    out: demoSegmentsPath
  });

  await prepareCandidates({
    input: demoSegmentsPath,
    out: candidatesPath,
    size: "640x640",
    fov: 90,
    pitch: 0,
    radius: 30
  });

  const candidateData = await (await import("./lib/io.mjs")).readJson(candidatesPath);
  const images = await writeMockImages(candidateData, imageDir);

  await writeJson(metadataPath, {
    generated_at: new Date().toISOString(),
    input: candidatesPath,
    capture_count: images.length,
    results: images.map((item) => ({
      capture_id: item.capture_id,
      segment_id: item.segment_id,
      ok: true,
      response: {
        status: "OK",
        pano_id: "MOCK",
        date: "mock",
        copyright: "mock"
      }
    }))
  });

  await writeJson(imagesPath, {
    generated_at: new Date().toISOString(),
    images
  });

  await writeJson(analysesPath, {
    generated_at: new Date().toISOString(),
    model: "mock",
    results: candidateData.segments.map((segment) => ({
      segment_id: segment.segment_id,
      ok: true,
      response_id: `mock-${segment.segment_id}`,
      model: "mock",
      raw_text: JSON.stringify(buildMockAssessment(String(segment.segment_id))),
      assessment: buildMockAssessment(String(segment.segment_id))
    }))
  });

  await buildParkingAreas({
    candidates: candidatesPath,
    analyses: analysesPath,
    overrides: resolveFrom(import.meta.url, "../out/review-overrides.json"),
    out: resolveFrom(import.meta.url, "../out/parking-areas.geojson")
  });

  await buildReviewBundle({
    candidates: candidatesPath,
    metadata: metadataPath,
    images: imagesPath,
    analyses: analysesPath,
    overrides: resolveFrom(import.meta.url, "../out/review-overrides.json"),
    out: resolveFrom(import.meta.url, "../out/review-bundle.json")
  });

  console.log("Mock review bundle ready at street-view/out/review-bundle.json");
}

async function main() {
  await runMock();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
