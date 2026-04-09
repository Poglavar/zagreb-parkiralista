// These tests cover the geometry helpers that drive station placement and curb polygon generation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  distanceMeters,
  headingBetween,
  interpolateAlongPolyline,
  polylineLengthMeters,
  polylineTurnDegrees,
  trimPolyline
} from "../scripts/lib/geo.mjs";

test("distanceMeters returns a plausible east-west distance", () => {
  const distance = distanceMeters([15.98, 45.81], [15.981, 45.81]);
  assert.ok(distance > 70 && distance < 90);
});

test("headingBetween returns east as roughly 90 degrees", () => {
  const heading = headingBetween([15.98, 45.81], [15.981, 45.81]);
  assert.ok(heading > 80 && heading < 100);
});

test("interpolateAlongPolyline finds midpoint on a simple line", () => {
  const coords = [
    [15.98, 45.81],
    [15.981, 45.81]
  ];
  const halfway = interpolateAlongPolyline(coords, polylineLengthMeters(coords) / 2).coord;
  assert.ok(Math.abs(halfway[0] - 15.9805) < 0.0001);
});

test("trimPolyline shortens both ends", () => {
  const coords = [
    [15.98, 45.81],
    [15.981, 45.81],
    [15.982, 45.81]
  ];
  const trimmed = trimPolyline(coords, 30, 30);
  assert.ok(trimmed.length >= 2);
  assert.ok(trimmed[0][0] > coords[0][0]);
  assert.ok(trimmed[trimmed.length - 1][0] < coords[coords.length - 1][0]);
});

test("polylineTurnDegrees reports curvature", () => {
  const turn = polylineTurnDegrees([
    [15.98, 45.81],
    [15.981, 45.81],
    [15.981, 45.811]
  ]);
  assert.ok(turn > 70 && turn < 110);
});
