// These helpers convert line segments plus side decisions into approximate curbside parking polygons.
import { lonLatToXY, meanCoordinate, trimPolyline, xyToLonLat } from "./geo.mjs";

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

export function buildParkingSidePolygon(
  coords,
  {
    side,
    roadWidthM,
    parkingLevel = "road_level",
    bandWidthM = 2.4,
    endSetbackM = 6
  }
) {
  const trimmed = trimPolyline(coords, endSetbackM, endSetbackM);
  if (trimmed.length < 2) {
    return null;
  }

  const sign = side === "left" ? 1 : -1;
  const edgeDistance = Math.max(1.5, roadWidthM / 2);
  const outsideRoad = parkingLevel === "sidewalk" || parkingLevel === "gravel_shoulder";

  const innerAbs = outsideRoad ? edgeDistance : Math.max(0.6, edgeDistance - bandWidthM);
  const outerAbs = outsideRoad ? edgeDistance + bandWidthM : edgeDistance;

  const outer = offsetPolyline(trimmed, sign * outerAbs);
  const inner = offsetPolyline(trimmed, sign * innerAbs);
  const ring = [...outer, ...inner.slice().reverse()];
  if (ring.length > 0) {
    ring.push(ring[0]);
  }
  return ring;
}
