// These tests cover the pure helpers used by the OSM-backed segment map in the static reviewer.
import test from "node:test";
import assert from "node:assert/strict";
import { chooseParkingPolygonKeys, toLatLngPath } from "../scripts/lib/review-map.mjs";

test("chooseParkingPolygonKeys uses level and manner", () => {
  assert.deepEqual(
    chooseParkingPolygonKeys({
      segment_left: { parking_level: "sidewalk", parking_manner: "perpendicular" },
      segment_right: { parking_level: "road_level", parking_manner: "parallel" }
    }),
    {
      left: "left_sidewalk_perpendicular",
      right: "right_road_level_parallel"
    }
  );
});

test("chooseParkingPolygonKeys defaults unknown manner to parallel", () => {
  assert.deepEqual(
    chooseParkingPolygonKeys({
      segment_left: { parking_level: "road_level", parking_manner: "unknown" },
      segment_right: { parking_level: "road_level" }
    }),
    {
      left: "left_road_level_parallel",
      right: "right_road_level_parallel"
    }
  );
});

test("toLatLngPath flips GeoJSON lon-lat pairs into map lat-lon pairs", () => {
  assert.deepEqual(
    toLatLngPath([
      [15.98, 45.81],
      [15.99, 45.82]
    ]),
    [
      [45.81, 15.98],
      [45.82, 15.99]
    ]
  );
});
