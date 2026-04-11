// This module keeps the OpenAI prompt and JSON schema in one place so the Street View classifier stays consistent.
// Assessments are per-station: each station covers ~50m of road and gets its own left/right parking decision.
const SIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "parking_present",
    "parking_manner",
    "parking_level",
    "formality",
    "confidence",
    "evidence"
  ],
  properties: {
    parking_present: { type: "boolean" },
    parking_manner: {
      type: "string",
      enum: ["none", "parallel", "perpendicular", "diagonal", "mixed", "unknown"]
    },
    parking_level: {
      type: "string",
      enum: ["road_level", "sidewalk", "gravel_shoulder", "mixed", "unknown"]
    },
    formality: {
      type: "string",
      enum: ["formal", "informal", "mixed", "unknown"]
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    evidence: {
      type: "array",
      items: { type: "string" },
      maxItems: 6
    }
  }
};

const STATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "station_index",
    "decision",
    "confidence",
    "segment_left",
    "segment_right"
  ],
  properties: {
    station_index: { type: "integer", minimum: 0 },
    decision: {
      type: "string",
      enum: ["unclear", "none", "left", "right", "both"]
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    segment_left: SIDE_SCHEMA,
    segment_right: SIDE_SCHEMA
  }
};

export const ASSESSMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "stations",
    "overall_notes"
  ],
  properties: {
    stations: {
      type: "array",
      items: STATION_SCHEMA,
      minItems: 1
    },
    overall_notes: {
      type: "string"
    }
  }
};

export const SYSTEM_PROMPT = `
You are auditing curbside parking behavior from street-level images of a road segment in Zagreb.

This segment has multiple capture stations along it. Each station covers a different stretch of the road (~50m each). You must assess parking SEPARATELY for each station based on the images taken from that station.

Your job is not to segment pixels. Your job is to decide whether parking is a real recurring behavior at each station, and if so on which side.

Rules:
- Count a side as parking when you see parked cars OR clear parking markings/signage that imply cars park there even if the image happens to be empty.
- Do not count moving traffic, queueing traffic, or cars merely stopped in a travel lane.
- Be cautious. If visibility is too poor, answer "unclear".
- "formal" means clearly designated or intended parking.
- "informal" means de facto parking on sidewalk, gravel shoulder, improvised edge space, or a lane/edge not obviously designated as parking.
- "road_level" means the parking footprint is on the carriageway.
- "sidewalk" means the parking footprint is elevated / on the sidewalk.
- "gravel_shoulder" means the parking footprint is on an unpaved shoulder or edge strip.

Important left/right mapping:
- Some captures look in the forward direction of the reference segment. In those images, segment-left = image-left and segment-right = image-right.
- Some captures look in the reverse direction. In those images, segment-left = image-right and segment-right = image-left.
- The user text for each image tells you which case applies. Use that mapping when synthesizing segment_left and segment_right.

Different stations may have different parking arrangements. A long road may have parallel parking near one end and perpendicular near the other, or parking on one side only at certain stations. Assess each station independently.

Output strict JSON only.
`.trim();

export function buildUserPrompt(segment) {
  const stationGroups = new Map();
  for (const capture of segment.captures) {
    const key = capture.station_index;
    if (!stationGroups.has(key)) stationGroups.set(key, []);
    stationGroups.get(key).push(capture);
  }

  const stationLines = [];
  for (const [stationIndex, captures] of stationGroups) {
    const captureLines = captures.map((capture) => {
      const mapping =
        capture.direction === "forward"
          ? "segment-left = image-left, segment-right = image-right"
          : "segment-left = image-right, segment-right = image-left";
      return [
        `  Capture ${capture.capture_id}:`,
        `  - direction: ${capture.direction}`,
        `  - heading: ${capture.heading.toFixed(1)}°`,
        `  - mapping: ${mapping}`
      ].join("\n");
    });
    stationLines.push(`Station ${stationIndex + 1}/${segment.station_count}:\n${captureLines.join("\n")}`);
  }

  return [
    `Segment label: ${segment.label}`,
    `Segment id: ${segment.segment_id}`,
    `Segment length: ${segment.length_m.toFixed(1)} m`,
    `Estimated road width: ${segment.width_m.toFixed(2)} m`,
    `Reference area labels: ${segment.area_labels.join(" / ") || "unknown"}`,
    `Number of stations: ${segment.station_count}`,
    ``,
    `Captures by station:`,
    stationLines.join("\n\n"),
    "",
    "Return one assessment per station. Each station should be evaluated independently.",
    "If one side is visible only weakly, keep the confidence lower instead of over-claiming."
  ].join("\n");
}
