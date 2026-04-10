// This file contains pure helpers for the OSM-backed reviewer map so they can be tested outside the browser.

function sidePolygonKey(side, sideAssessment) {
  const level = sideAssessment?.parking_level === "sidewalk" ? "sidewalk" : "road_level";
  const manner = ["parallel", "perpendicular", "diagonal"].includes(sideAssessment?.parking_manner)
    ? sideAssessment.parking_manner
    : "parallel";
  return `${side}_${level}_${manner}`;
}

export function chooseParkingPolygonKeys(assessment) {
  return {
    left: sidePolygonKey("left", assessment?.segment_left),
    right: sidePolygonKey("right", assessment?.segment_right)
  };
}

export function toLatLngPath(coords) {
  return (coords || []).map(([lon, lat]) => [lat, lon]);
}
