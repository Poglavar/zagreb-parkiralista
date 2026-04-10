// This file builds OSM draft payloads from reviewer polygons and derives handoff URLs for iD and JOSM.
import { chooseParkingPolygonKeys } from "./review-map.mjs";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function closedRingWithoutDuplicate(ring) {
  if (!Array.isArray(ring) || ring.length < 4) {
    return [];
  }
  const points = ring.slice(0, -1);
  return points.length >= 4 ? points : ring;
}

function polygonBounds(polygons) {
  const coords = polygons.flatMap((polygon) => polygon.ring || []);
  return coords.reduce(
    (acc, [lon, lat]) => [
      Math.min(acc[0], lon),
      Math.min(acc[1], lat),
      Math.max(acc[2], lon),
      Math.max(acc[3], lat)
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
}

function centerFromBounds([minLon, minLat, maxLon, maxLat]) {
  return {
    lon: (minLon + maxLon) / 2,
    lat: (minLat + maxLat) / 2
  };
}

function sideTags(side, sideAssessment) {
  const tags = [
    ["amenity", "parking"],
    ["parking", sideAssessment?.parking_level === "road_level" ? "lane" : "street_side"],
    ["street_side", side],
    ["source", "street-level imagery review"],
    ["fixme", "Confirm geometry, tags, and parking rules before upload"]
  ];

  if (["parallel", "diagonal", "perpendicular"].includes(sideAssessment?.parking_manner)) {
    tags.push(["orientation", sideAssessment.parking_manner]);
  }

  return tags;
}

export function activeParkingPolygons(segment, assessment, effectivePolygonCoords) {
  if (!segment || !assessment) {
    return [];
  }

  return ["left", "right"]
    .map((side) => {
      const sideAssessment = side === "left" ? assessment.segment_left : assessment.segment_right;
      if (!sideAssessment?.parking_present) {
        return null;
      }
      const ring = effectivePolygonCoords(segment, assessment, side);
      if (!ring) {
        return null;
      }
      return {
        side,
        ring,
        tags: sideTags(side, sideAssessment),
        levelKey: chooseParkingPolygonKeys(assessment)[side]
      };
    })
    .filter(Boolean);
}

export function buildOsmXmlPayload(segment, assessment, effectivePolygonCoords) {
  const polygons = activeParkingPolygons(segment, assessment, effectivePolygonCoords);
  let nextNodeId = -1;
  let nextWayId = -1000;
  const nodeXml = [];
  const wayXml = [];

  polygons.forEach((polygon) => {
    const pointRefs = closedRingWithoutDuplicate(polygon.ring).map(([lon, lat]) => {
      const nodeId = nextNodeId;
      nextNodeId -= 1;
      nodeXml.push(`  <node id="${nodeId}" visible="true" lon="${lon}" lat="${lat}" />`);
      return nodeId;
    });

    const wayId = nextWayId;
    nextWayId -= 1;
    const ndXml = [...pointRefs, pointRefs[0]].map((ref) => `    <nd ref="${ref}" />`).join("\n");
    const tagXml = [
      ...polygon.tags,
      ["name", `${segment.label} ${polygon.side} parking draft`],
      ["note", `Segment ${segment.segment_id}`]
    ]
      .map(([key, value]) => `    <tag k="${escapeXml(key)}" v="${escapeXml(value)}" />`)
      .join("\n");

    wayXml.push(`  <way id="${wayId}" visible="true">\n${ndXml}\n${tagXml}\n  </way>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="street-view-poc">\n${nodeXml.join("\n")}\n${wayXml.join("\n")}\n</osm>\n`;
}

export function buildOsmChangePayload(changesetId, polygonGroups) {
  let nextNodeId = -1;
  let nextWayId = -1000;
  const nodeLines = [];
  const wayLines = [];

  for (const { segmentId, polygons } of polygonGroups) {
    for (const polygon of polygons) {
      const pointRefs = closedRingWithoutDuplicate(polygon.ring).map(([lon, lat]) => {
        const nodeId = nextNodeId;
        nextNodeId -= 1;
        nodeLines.push(`    <node id="${nodeId}" changeset="${changesetId}" lat="${lat}" lon="${lon}" />`);
        return nodeId;
      });

      const wayId = nextWayId;
      nextWayId -= 1;
      const ndXml = [...pointRefs, pointRefs[0]].map((ref) => `      <nd ref="${ref}" />`).join("\n");
      const tags = [...polygon.tags, ["note", `Segment ${segmentId}`]];
      const tagXml = tags
        .map(([key, value]) => `      <tag k="${escapeXml(key)}" v="${escapeXml(value)}" />`)
        .join("\n");
      wayLines.push(`    <way id="${wayId}" changeset="${changesetId}">\n${ndXml}\n${tagXml}\n    </way>`);
    }
  }

  return [
    `<osmChange version="0.6" generator="street-view-poc">`,
    `  <create>`,
    ...nodeLines,
    ...wayLines,
    `  </create>`,
    `</osmChange>`
  ].join("\n");
}

export function buildChangesetXml(comment) {
  return [
    `<osm>`,
    `  <changeset>`,
    `    <tag k="comment" v="${escapeXml(comment)}" />`,
    `    <tag k="source" v="Street View imagery; AI classification; manual review" />`,
    `    <tag k="created_by" v="street-view-poc" />`,
    `    <tag k="locale" v="hr" />`,
    `  </changeset>`,
    `</osm>`
  ].join("\n");
}

export function buildOsmSubmission(segment, assessment, effectivePolygonCoords) {
  const polygons = activeParkingPolygons(segment, assessment, effectivePolygonCoords);
  const bounds = polygons.length
    ? polygonBounds(polygons)
    : polygonBounds([
        {
          ring: segment.geometry.coordinates
        }
      ]);
  const center = centerFromBounds(bounds);
  const xml = buildOsmXmlPayload(segment, assessment, effectivePolygonCoords);
  const bbox = {
    min_lon: bounds[0],
    min_lat: bounds[1],
    max_lon: bounds[2],
    max_lat: bounds[3]
  };
  const idEditorUrl = `https://www.openstreetmap.org/edit?editor=id&lat=${center.lat.toFixed(6)}&lon=${center.lon.toFixed(6)}&zoom=19`;
  const josmLoadDataUrl = `http://127.0.0.1:8111/load_data?new_layer=true&mime_type=${encodeURIComponent("application/x-osm+xml")}&layer_name=${encodeURIComponent(`Street View ${segment.segment_id}`)}&upload_policy=never&download_policy=never&data=${encodeURIComponent(xml)}`;
  const josmZoomUrl = `http://127.0.0.1:8111/zoom?left=${bbox.min_lon}&right=${bbox.max_lon}&top=${bbox.max_lat}&bottom=${bbox.min_lat}`;
  const josmVersionUrl = "http://127.0.0.1:8111/version";

  return {
    segment_id: segment.segment_id,
    polygon_count: polygons.length,
    bbox,
    center,
    xml,
    id_editor_url: idEditorUrl,
    josm_remote_control_url: josmLoadDataUrl,
    josm_zoom_url: josmZoomUrl,
    josm_version_url: josmVersionUrl
  };
}
