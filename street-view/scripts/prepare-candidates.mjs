// This script turns input road segments into Street View capture candidates, headings, and preview curb polygons.
import { pathToFileURL } from "url";
import { buildParkingSidePolygon } from "./lib/parking.mjs";
import {
  headingAtDistance,
  interpolateAlongPolyline,
  polylineLengthMeters,
  polylineTurnDegrees
} from "./lib/geo.mjs";
import { readJson, resolveFrom, writeJson } from "./lib/io.mjs";

function parseArgs(argv) {
  const args = {
    input: resolveFrom(import.meta.url, "../data/demo-segments.geojson"),
    out: resolveFrom(import.meta.url, "../out/candidates.json"),
    size: "640x640",
    fov: 90,
    pitch: 0,
    radius: 30
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--size") args.size = argv[++i];
    else if (argv[i] === "--fov") args.fov = Number(argv[++i]);
    else if (argv[i] === "--pitch") args.pitch = Number(argv[++i]);
    else if (argv[i] === "--radius") args.radius = Number(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/prepare-candidates.mjs [--input path] [--out path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  return args;
}

function chooseStationFractions(lengthM, turnDegrees) {
  if (lengthM > 220 || turnDegrees > 45) {
    return [0.25, 0.5, 0.75];
  }
  if (lengthM > 120 || turnDegrees > 20) {
    return [0.33, 0.66];
  }
  return [0.5];
}

function buildMapsUrl({ lat, lon, heading, pitch, fov }) {
  const params = new URLSearchParams({
    api: "1",
    map_action: "pano",
    viewpoint: `${lat.toFixed(6)},${lon.toFixed(6)}`,
    heading: heading.toFixed(1),
    pitch: String(pitch),
    fov: String(fov)
  });
  return `https://www.google.com/maps/@?${params.toString()}`;
}

function buildStaticTemplate({ lat, lon, heading, pitch, fov, size, radius }) {
  const params = new URLSearchParams({
    size,
    location: `${lat.toFixed(6)},${lon.toFixed(6)}`,
    heading: heading.toFixed(1),
    pitch: String(pitch),
    fov: String(fov),
    radius: String(radius),
    source: "outdoor",
    return_error_code: "true",
    key: "YOUR_GOOGLE_MAPS_API_KEY"
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

function buildMetadataTemplate({ lat, lon, heading, pitch, fov, radius }) {
  const params = new URLSearchParams({
    location: `${lat.toFixed(6)},${lon.toFixed(6)}`,
    heading: heading.toFixed(1),
    pitch: String(pitch),
    fov: String(fov),
    radius: String(radius),
    source: "outdoor",
    key: "YOUR_GOOGLE_MAPS_API_KEY"
  });
  return `https://maps.googleapis.com/maps/api/streetview/metadata?${params.toString()}`;
}

export async function prepareCandidates({ input, out, size, fov, pitch, radius }) {
  const fc = await readJson(input);

  const segments = (fc.features || []).map((feature) => {
    const coords = feature.geometry.coordinates;
    const lengthM = polylineLengthMeters(coords);
    const turnDegrees = polylineTurnDegrees(coords);
    const stationFractions = chooseStationFractions(lengthM, turnDegrees);
    const captures = [];

    stationFractions.forEach((fraction, stationIndex) => {
      const stationDistance = lengthM * fraction;
      const viewpoint = interpolateAlongPolyline(coords, stationDistance).coord;
      const heading = headingAtDistance(coords, stationDistance, 8);

      for (const direction of ["forward", "reverse"]) {
        const effectiveHeading = direction === "forward" ? heading : (heading + 180) % 360;
        const [lon, lat] = viewpoint;
        const captureId = `${feature.properties.segment_id}-s${stationIndex + 1}-${direction}`;
        captures.push({
          capture_id: captureId,
          station_index: stationIndex,
          station_fraction: fraction,
          direction,
          heading: effectiveHeading,
          pitch,
          fov,
          viewpoint: { lon, lat },
          maps_url: buildMapsUrl({ lat, lon, heading: effectiveHeading, pitch, fov }),
          street_view_image_url_template: buildStaticTemplate({
            lat,
            lon,
            heading: effectiveHeading,
            pitch,
            fov,
            size,
            radius
          }),
          street_view_metadata_url_template: buildMetadataTemplate({
            lat,
            lon,
            heading: effectiveHeading,
            pitch,
            fov,
            radius
          })
        });
      }
    });

    return {
      segment_id: feature.properties.segment_id,
      label: feature.properties.label,
      notes: feature.properties.notes,
      width_m: Number(feature.properties.width_m),
      length_m: lengthM,
      width_bucket: feature.properties.width_bucket,
      area_labels: [
        ...(feature.properties.l1 || []),
        ...(feature.properties.l3 || [])
      ],
      turn_degrees: turnDegrees,
      station_count: stationFractions.length,
      geometry: feature.geometry,
      preview_polygons: {
        left_road_level: buildParkingSidePolygon(coords, {
          side: "left",
          roadWidthM: Number(feature.properties.width_m),
          parkingLevel: "road_level"
        }),
        right_road_level: buildParkingSidePolygon(coords, {
          side: "right",
          roadWidthM: Number(feature.properties.width_m),
          parkingLevel: "road_level"
        }),
        left_sidewalk: buildParkingSidePolygon(coords, {
          side: "left",
          roadWidthM: Number(feature.properties.width_m),
          parkingLevel: "sidewalk"
        }),
        right_sidewalk: buildParkingSidePolygon(coords, {
          side: "right",
          roadWidthM: Number(feature.properties.width_m),
          parkingLevel: "sidewalk"
        })
      },
      captures
    };
  });

  const outData = {
    generated_at: new Date().toISOString(),
    input,
    capture_settings: { size, fov, pitch, radius, source: "outdoor" },
    segment_count: segments.length,
    capture_count: segments.reduce((sum, segment) => sum + segment.captures.length, 0),
    segments
  };

  await writeJson(out, outData);
  console.log(`Wrote ${outData.capture_count} capture candidates for ${outData.segment_count} segments to ${out}`);
}

async function main() {
  const args = parseArgs(process.argv);
  await prepareCandidates(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
