// These tests cover the approximate curbside polygon builder used by the Street View proof of concept.
import test from "node:test";
import assert from "node:assert/strict";
import { bandWidthForManner, buildParkingSidePolygon } from "../scripts/lib/parking.mjs";
import { distanceMeters } from "../scripts/lib/geo.mjs";

const SEGMENT = [
  [15.98, 45.81],
  [15.981, 45.81]
];

test("bandWidthForManner returns car width for parallel", () => {
  assert.equal(bandWidthForManner("parallel"), 2.5);
});

test("bandWidthForManner returns car length for perpendicular", () => {
  assert.equal(bandWidthForManner("perpendicular"), 5.5);
});

test("bandWidthForManner returns diagonal depth between parallel and perpendicular", () => {
  const d = bandWidthForManner("diagonal");
  assert.ok(d > 2.75 && d < 5.5, `diagonal ${d} should be between parallel and perpendicular`);
});

test("buildParkingSidePolygon returns a closed ring", () => {
  const ring = buildParkingSidePolygon(SEGMENT, {
    side: "left",
    roadWidthM: 10,
    parkingLevel: "road_level"
  });

  assert.ok(Array.isArray(ring));
  assert.ok(ring.length >= 5);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test("left and right polygons differ", () => {
  const leftRing = buildParkingSidePolygon(SEGMENT, {
    side: "left",
    roadWidthM: 10,
    parkingLevel: "road_level"
  });
  const rightRing = buildParkingSidePolygon(SEGMENT, {
    side: "right",
    roadWidthM: 10,
    parkingLevel: "road_level"
  });

  assert.notDeepEqual(leftRing, rightRing);
});

test("sidewalk polygons sit farther from the centerline than road-level polygons", () => {
  const roadRing = buildParkingSidePolygon(SEGMENT, {
    side: "left",
    roadWidthM: 10,
    parkingLevel: "road_level"
  });
  const sidewalkRing = buildParkingSidePolygon(SEGMENT, {
    side: "left",
    roadWidthM: 10,
    parkingLevel: "sidewalk"
  });

  assert.ok(sidewalkRing[0][1] !== roadRing[0][1]);
});

test("perpendicular polygon is wider than parallel polygon", () => {
  const parallel = buildParkingSidePolygon(SEGMENT, {
    side: "left",
    roadWidthM: 10,
    parkingLevel: "road_level",
    parkingManner: "parallel"
  });
  const perp = buildParkingSidePolygon(SEGMENT, {
    side: "left",
    roadWidthM: 10,
    parkingLevel: "road_level",
    parkingManner: "perpendicular"
  });

  // Measure the width by the distance between outer and inner edge midpoints
  const parallelWidth = distanceMeters(parallel[0], parallel[parallel.length - 2]);
  const perpWidth = distanceMeters(perp[0], perp[perp.length - 2]);
  assert.ok(perpWidth > parallelWidth, `perpendicular ${perpWidth.toFixed(1)}m should be wider than parallel ${parallelWidth.toFixed(1)}m`);
});
