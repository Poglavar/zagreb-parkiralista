// These helpers do light-weight geometry in local metres so the Street View POC can stay dependency-free.
const EARTH_METERS_PER_DEGREE = 111320;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function metersPerDegreeLon(latDeg) {
  return Math.cos(latDeg * DEG_TO_RAD) * EARTH_METERS_PER_DEGREE;
}

export function meanCoordinate(coords) {
  const totals = coords.reduce(
    (acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat],
    [0, 0]
  );
  return [totals[0] / coords.length, totals[1] / coords.length];
}

export function lonLatToXY([lon, lat], origin) {
  const lonScale = metersPerDegreeLon(origin[1]);
  return [
    (lon - origin[0]) * lonScale,
    (lat - origin[1]) * EARTH_METERS_PER_DEGREE
  ];
}

export function xyToLonLat([x, y], origin) {
  const lonScale = metersPerDegreeLon(origin[1]) || 1;
  return [
    origin[0] + x / lonScale,
    origin[1] + y / EARTH_METERS_PER_DEGREE
  ];
}

export function distanceMeters(a, b) {
  const origin = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [ax, ay] = lonLatToXY(a, origin);
  const [bx, by] = lonLatToXY(b, origin);
  return Math.hypot(bx - ax, by - ay);
}

export function cumulativeDistances(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i += 1) {
    out.push(out[out.length - 1] + distanceMeters(coords[i - 1], coords[i]));
  }
  return out;
}

export function polylineLengthMeters(coords) {
  const distances = cumulativeDistances(coords);
  return distances[distances.length - 1];
}

export function interpolateAlongPolyline(coords, distanceM) {
  if (coords.length === 1) {
    return { coord: coords[0], segmentIndex: 0, fraction: 0 };
  }

  const distances = cumulativeDistances(coords);
  const total = distances[distances.length - 1];
  const target = clamp(distanceM, 0, total);

  for (let i = 0; i < coords.length - 1; i += 1) {
    const startD = distances[i];
    const endD = distances[i + 1];
    if (target <= endD || i === coords.length - 2) {
      const segLen = Math.max(0.0001, endD - startD);
      const t = clamp((target - startD) / segLen, 0, 1);
      const [lonA, latA] = coords[i];
      const [lonB, latB] = coords[i + 1];
      return {
        coord: [lerp(lonA, lonB, t), lerp(latA, latB, t)],
        segmentIndex: i,
        fraction: t
      };
    }
  }

  return { coord: coords[coords.length - 1], segmentIndex: coords.length - 2, fraction: 1 };
}

export function headingBetween(a, b) {
  const origin = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [ax, ay] = lonLatToXY(a, origin);
  const [bx, by] = lonLatToXY(b, origin);
  const dx = bx - ax;
  const dy = by - ay;
  return (Math.atan2(dx, dy) * RAD_TO_DEG + 360) % 360;
}

export function headingAtDistance(coords, distanceM, lookAroundM = 5) {
  const total = polylineLengthMeters(coords);
  const start = Math.max(0, distanceM - lookAroundM);
  const end = Math.min(total, distanceM + lookAroundM);
  const a = interpolateAlongPolyline(coords, start).coord;
  const b = interpolateAlongPolyline(coords, end > start ? end : Math.min(total, start + 1)).coord;
  return headingBetween(a, b);
}

export function trimPolyline(coords, startTrimM = 0, endTrimM = 0) {
  const total = polylineLengthMeters(coords);
  if (coords.length < 2 || total <= startTrimM + endTrimM + 1) {
    return coords.slice();
  }

  const start = clamp(startTrimM, 0, total);
  const end = clamp(total - endTrimM, start, total);
  const distances = cumulativeDistances(coords);
  const trimmed = [interpolateAlongPolyline(coords, start).coord];

  for (let i = 1; i < coords.length - 1; i += 1) {
    if (distances[i] > start && distances[i] < end) {
      trimmed.push(coords[i]);
    }
  }

  trimmed.push(interpolateAlongPolyline(coords, end).coord);
  return trimmed;
}

// Extract a sub-polyline between two distances along the original.
export function subPolyline(coords, startM, endM) {
  const total = polylineLengthMeters(coords);
  const s = clamp(startM, 0, total);
  const e = clamp(endM, s, total);
  const distances = cumulativeDistances(coords);
  const result = [interpolateAlongPolyline(coords, s).coord];
  for (let i = 1; i < coords.length - 1; i += 1) {
    if (distances[i] > s && distances[i] < e) result.push(coords[i]);
  }
  result.push(interpolateAlongPolyline(coords, e).coord);
  return result;
}

// Split a polyline into N equal-length sub-polylines.
export function splitPolylineEqual(coords, n) {
  if (n <= 1) return [coords];
  const total = polylineLengthMeters(coords);
  const step = total / n;
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(subPolyline(coords, i * step, (i + 1) * step));
  }
  return parts;
}

export function polylineTurnDegrees(coords) {
  if (coords.length < 3) {
    return 0;
  }

  let total = 0;
  for (let i = 1; i < coords.length - 1; i += 1) {
    const prev = headingBetween(coords[i - 1], coords[i]);
    const next = headingBetween(coords[i], coords[i + 1]);
    let delta = Math.abs(next - prev);
    if (delta > 180) {
      delta = 360 - delta;
    }
    total += delta;
  }
  return total;
}
