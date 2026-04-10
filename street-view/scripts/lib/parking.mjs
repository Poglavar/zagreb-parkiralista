// These helpers convert line segments plus side decisions into approximate curbside parking polygons.
// Band widths are derived from standard car dimensions (2.75m wide x 5.50m long).
// Curved segments are split at bend points so parking polygons only cover straight stretches.
import { headingBetween, lonLatToXY, meanCoordinate, trimPolyline, xyToLonLat } from "./geo.mjs";

const CAR_WIDTH_M = 2.50;
const CAR_LENGTH_M = 5.50;
const DIAGONAL_ANGLE_DEG = 45;

export function bandWidthForManner(manner) {
  if (manner === "perpendicular") return CAR_LENGTH_M;
  if (manner === "diagonal") return Math.sin(DIAGONAL_ANGLE_DEG * Math.PI / 180) * CAR_LENGTH_M;
  // parallel, mixed, unknown, none — use car width
  return CAR_WIDTH_M;
}

function normalizeVector([x, y]) {
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

function vertexNormal(points, index) {
  const prev = points[index - 1] ?? points[index];
  const next = points[index + 1] ?? points[index];
  const tangent = normalizeVector([next[0] - prev[0], next[1] - prev[1]]);
  return [-tangent[1], tangent[0]];
}

function offsetPolyline(coords, offsetM) {
  const origin = meanCoordinate(coords);
  const points = coords.map((coord) => lonLatToXY(coord, origin));
  return points.map((point, index) => {
    const normal = vertexNormal(points, index);
    return xyToLonLat(
      [point[0] + normal[0] * offsetM, point[1] + normal[1] * offsetM],
      origin
    );
  });
}

const BEND_THRESHOLD_DEG = 25;

// Split a polyline into straight runs, cutting at vertices where heading changes sharply.
function splitAtBends(coords, thresholdDeg = BEND_THRESHOLD_DEG) {
  if (coords.length < 3) return [coords];

  const runs = [];
  let current = [coords[0]];

  for (let i = 1; i < coords.length - 1; i += 1) {
    const prev = headingBetween(coords[i - 1], coords[i]);
    const next = headingBetween(coords[i], coords[i + 1]);
    let delta = Math.abs(next - prev);
    if (delta > 180) delta = 360 - delta;

    current.push(coords[i]);
    if (delta > thresholdDeg) {
      if (current.length >= 2) runs.push(current);
      current = [coords[i]];
    }
  }
  current.push(coords[coords.length - 1]);
  if (current.length >= 2) runs.push(current);
  return runs;
}

function buildRingFromPolyline(polyline, side, roadWidthM, parkingLevel, bandWidthM) {
  const sign = side === "left" ? 1 : -1;
  const edgeDistance = Math.max(1.5, roadWidthM / 2);
  const outsideRoad = parkingLevel === "sidewalk" || parkingLevel === "gravel_shoulder";

  const innerAbs = outsideRoad ? edgeDistance : Math.max(0.6, edgeDistance - bandWidthM);
  const outerAbs = outsideRoad ? edgeDistance + bandWidthM : edgeDistance;

  const outer = offsetPolyline(polyline, sign * outerAbs);
  const inner = offsetPolyline(polyline, sign * innerAbs);
  const ring = [...outer, ...inner.slice().reverse()];
  if (ring.length > 0) ring.push(ring[0]);
  return ring;
}

// Build one or more parking polygon rings for one side of a segment.
// Returns a single ring for straight segments, multiple rings for curved ones.
export function buildParkingSidePolygons(
  coords,
  {
    side,
    roadWidthM,
    parkingLevel = "road_level",
    parkingManner = "parallel",
    endSetbackM = 6
  }
) {
  const bandWidthM = bandWidthForManner(parkingManner);
  const trimmed = trimPolyline(coords, endSetbackM, endSetbackM);
  if (trimmed.length < 2) return [];

  const runs = splitAtBends(trimmed);
  return runs
    .map((run) => buildRingFromPolyline(run, side, roadWidthM, parkingLevel, bandWidthM))
    .filter((ring) => ring.length >= 5);
}

// Convenience: returns the first ring (backwards compat for single-polygon callers).
export function buildParkingSidePolygon(coords, opts) {
  const rings = buildParkingSidePolygons(coords, opts);
  return rings.length > 0 ? rings[0] : null;
}
