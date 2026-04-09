// These tests cover the approximate curbside polygon builder used by the Street View proof of concept.
import test from "node:test";
import assert from "node:assert/strict";
import { buildParkingSidePolygon } from "../scripts/lib/parking.mjs";

const SEGMENT = [
  [15.98, 45.81],
  [15.981, 45.81]
];

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
