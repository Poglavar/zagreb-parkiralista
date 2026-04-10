// These tests cover the draft OSM payload builder used by the review UI handoff actions.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOsmSubmission } from "../scripts/lib/osm-submit.mjs";

const SEGMENT = {
  segment_id: "123",
  label: "Demo segment",
  geometry: {
    coordinates: [
      [15.98, 45.81],
      [15.981, 45.811]
    ]
  },
  preview_polygons: {
    left_road_level_parallel: [
      [15.98, 45.81],
      [15.981, 45.811],
      [15.9811, 45.8109],
      [15.9801, 45.8099],
      [15.98, 45.81]
    ],
    right_road_level_diagonal: [
      [15.982, 45.812],
      [15.983, 45.813],
      [15.9831, 45.8129],
      [15.9821, 45.8119],
      [15.982, 45.812]
    ]
  }
};

const ASSESSMENT = {
  decision: "both",
  segment_left: {
    parking_present: true,
    parking_level: "road_level",
    parking_manner: "parallel",
    formality: "formal"
  },
  segment_right: {
    parking_present: true,
    parking_level: "road_level",
    parking_manner: "diagonal",
    formality: "informal"
  }
};

function effectivePolygonCoords(segment, assessment, side) {
  return side === "left" ? segment.preview_polygons.left_road_level_parallel : segment.preview_polygons.right_road_level_diagonal;
}

test("buildOsmSubmission returns iD and JOSM handoff URLs plus XML", () => {
  const submission = buildOsmSubmission(SEGMENT, ASSESSMENT, effectivePolygonCoords);
  assert.equal(submission.polygon_count, 2);
  assert.match(submission.id_editor_url, /openstreetmap\.org\/edit\?editor=id/);
  assert.match(submission.josm_remote_control_url, /127\.0\.0\.1:8111\/load_data/);
  assert.match(submission.xml, /<way id="-1000"/);
  assert.match(submission.xml, /amenity/);
});
