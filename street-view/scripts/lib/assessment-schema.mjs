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

const ROAD_GEOMETRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "lane_count",
    "lane_widths_m",
    "total_carriageway_m",
    "confidence"
  ],
  properties: {
    lane_count: {
      type: "integer",
      minimum: 1,
      description: "Number of travel lanes (excluding parking lanes)"
    },
    lane_widths_m: {
      type: "array",
      items: { type: "number" },
      description: "Per-lane width estimates in metres, ordered left-to-right facing the forward direction"
    },
    total_carriageway_m: {
      type: "number",
      description: "Total carriageway width (travel lanes only, excluding sidewalks and parking strips)"
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    notes: {
      type: "string",
      description: "What references were used, any caveats"
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
    "segment_right",
    "road_geometry"
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
    segment_right: SIDE_SCHEMA,
    road_geometry: ROAD_GEOMETRY_SCHEMA
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
You are auditing curbside parking behavior from street-level images of a road segment in Zagreb, Croatia.

This segment has one or more capture stations along it. Each station covers ~50m of road. You must assess parking SEPARATELY for each station based only on images from that station.

Your job: decide whether parking is a real recurring behavior at each station, and if so on which side and in what manner.

WHAT COUNTS AS PARKING:
- Parked cars along the curb, in marked bays, or on the sidewalk/shoulder.
- Clear parking markings or signage, even if the image happens to show no cars.
- Informal parking: cars on sidewalks, gravel shoulders, or improvised edge spaces.

WHAT DOES NOT COUNT:
- Moving or queuing traffic.
- Cars stopped briefly in a travel lane (loading, drop-off).
- Bus stops, crosswalks, fire hydrant zones, or yellow curb no-parking markings.
- Tram tracks or tram stops — these indicate no-parking zones.

CLASSIFICATION:
- "parallel": cars parked along the road direction.
- "perpendicular": cars parked nose-in or tail-in, perpendicular to the road.
- "diagonal": cars parked at an angle (typically 45-60°).
- "formal": clearly designated/intended parking (markings, signs, meter zones).
- "informal": de facto parking without clear designation (sidewalk, shoulder, improvised).
- "road_level": parking footprint is on the carriageway surface.
- "sidewalk": parking footprint is on an elevated sidewalk or pavement.
- "gravel_shoulder": parking on an unpaved shoulder or dirt strip.

LEFT/RIGHT MAPPING:
- Forward captures: segment-left = image-left, segment-right = image-right.
- Reverse captures: segment-left = image-RIGHT, segment-right = image-LEFT.
- Each image label tells you the direction. Apply the mapping carefully.

STATION INDEPENDENCE:
Different stations along the same road may have different parking. A street might have parallel parking near one end, perpendicular near a shop, and no parking near an intersection. Assess each station on its own evidence.

EVIDENCE:
For each side, list specific visual observations that support your decision (e.g. "3 cars parked parallel along curb", "marked perpendicular bays with P sign", "no cars, yellow curb markings").

ROAD GEOMETRY:
Also estimate the road geometry at each station:
- How many travel lanes are there (excluding any parking lanes)?
- Estimate each lane's width in metres, ordered left to right facing the forward direction.
- Estimate the total carriageway width (travel lanes only, not sidewalks or parking strips).
- Use whatever visual references are available to calibrate your width estimates.
- Note what references you used and any caveats.
- The "estimated road width" in the segment metadata is a rough figure from map data — your visual estimate may differ.

CONFIDENCE:
- 0.9+: clear evidence, unambiguous.
- 0.7-0.9: likely correct but some ambiguity.
- Below 0.7: uncertain, consider "unclear" if very low.

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
