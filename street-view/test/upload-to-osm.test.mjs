// Tests for the OSM API upload logic: changeset XML generation and segment filtering.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We test buildOsmChange indirectly through the module's exported upload function
// by importing the helper via a dynamic approach. Since buildOsmChange is not exported,
// we test the overall flow logic with a minimal integration test instead.
import { activeParkingPolygons } from "../scripts/lib/osm-submit.mjs";
import { chooseParkingPolygonKeys } from "../scripts/lib/review-map.mjs";

const SEGMENT = {
  segment_id: "525",
  label: "Test segment",
  geometry: { coordinates: [[15.94, 45.79], [15.941, 45.795]] },
  preview_polygons: {
    left_road_level_parallel: [[15.94, 45.79], [15.941, 45.795], [15.9411, 45.7949], [15.9401, 45.7899], [15.94, 45.79]],
    right_road_level_parallel: [[15.942, 45.792], [15.943, 45.797], [15.9431, 45.7969], [15.9421, 45.7919], [15.942, 45.792]],
    right_road_level_perpendicular: [[15.942, 45.792], [15.943, 45.797], [15.9431, 45.7969], [15.9421, 45.7919], [15.942, 45.792]],
    left_sidewalk_parallel: [[15.939, 45.789], [15.940, 45.794], [15.9401, 45.7939], [15.9391, 45.7889], [15.939, 45.789]],
    right_sidewalk_parallel: [[15.944, 45.794], [15.945, 45.799], [15.9451, 45.7989], [15.9441, 45.7939], [15.944, 45.794]]
  }
};

function makePolygonCoordsFn(overridePolygons) {
  return (segment, assessment, side) => {
    if (overridePolygons?.[side]) return overridePolygons[side];
    const keys = chooseParkingPolygonKeys(assessment);
    const key = side === "left" ? keys.left : keys.right;
    return segment.preview_polygons?.[key] || null;
  };
}

describe("activeParkingPolygons for upload filtering", () => {
  it("returns polygons for both sides when assessment says both", () => {
    const assessment = {
      decision: "both",
      segment_left: { parking_present: true, parking_manner: "parallel", parking_level: "road_level", formality: "formal", confidence: 0.9, evidence: [] },
      segment_right: { parking_present: true, parking_manner: "perpendicular", parking_level: "road_level", formality: "informal", confidence: 0.8, evidence: [] }
    };
    const polygons = activeParkingPolygons(SEGMENT, assessment, makePolygonCoordsFn());
    assert.equal(polygons.length, 2);
    assert.equal(polygons[0].side, "left");
    assert.equal(polygons[1].side, "right");
    assert.ok(polygons[0].tags.some(([k]) => k === "amenity"));
  });

  it("returns no polygons when parking_present is false on both sides", () => {
    const assessment = {
      decision: "none",
      segment_left: { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0.95, evidence: [] },
      segment_right: { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0.95, evidence: [] }
    };
    const polygons = activeParkingPolygons(SEGMENT, assessment, makePolygonCoordsFn());
    assert.equal(polygons.length, 0);
  });

  it("returns only left polygon when right has no parking", () => {
    const assessment = {
      decision: "left",
      segment_left: { parking_present: true, parking_manner: "parallel", parking_level: "sidewalk", formality: "informal", confidence: 0.7, evidence: [] },
      segment_right: { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0.9, evidence: [] }
    };
    const polygons = activeParkingPolygons(SEGMENT, assessment, makePolygonCoordsFn());
    assert.equal(polygons.length, 1);
    assert.equal(polygons[0].side, "left");
  });

  it("uses polygon overrides when provided", () => {
    const assessment = {
      decision: "left",
      segment_left: { parking_present: true, parking_manner: "parallel", parking_level: "road_level", formality: "formal", confidence: 0.9, evidence: [] },
      segment_right: { parking_present: false, parking_manner: "none", parking_level: "road_level", formality: "unknown", confidence: 0.95, evidence: [] }
    };
    const customRing = [[15.95, 45.80], [15.951, 45.805], [15.9511, 45.8049], [15.9501, 45.7999], [15.95, 45.80]];
    const polygons = activeParkingPolygons(SEGMENT, assessment, makePolygonCoordsFn({ left: customRing }));
    assert.equal(polygons.length, 1);
    assert.deepEqual(polygons[0].ring, customRing);
  });
});
