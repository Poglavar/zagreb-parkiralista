#!/usr/bin/env python3
"""Phase 0: Fetch amenity=parking polygons from OSM Overpass for Zagreb,
compute area in EPSG:3765, estimate capacity for those without a tagged
capacity, and write a single GeoJSON FeatureCollection at data/osm/parking_zagreb.geojson.

This is the baseline layer the rest of the pipeline diffs against.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import Polygon, MultiPolygon, Point, mapping
from shapely.ops import transform as shapely_transform

# Zagreb administrative bounding box (covers the entire city + a small margin).
# Format: south, west, north, east (Overpass convention).
ZAGREB_BBOX = (45.70, 15.80, 46.00, 16.20)

# Average per-stall footprint in m² including aisles, used for area-based
# capacity estimation. ITE / ULI planning rule of thumb: 20 (parallel) – 27 (angled).
DEFAULT_M2_PER_STALL = 25.0

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "zagreb-parkiralista/0.1 (contact: github.com/simun)"

# Classification of `parking=*` tag values into "open_air" (visible from above
# in aerial imagery, candidate for ML detection) vs "enclosed" (under a roof or
# underground — only discoverable from OSM tags or manual entry).
ENCLOSED_PARKING_KINDS = {
    "underground",
    "multi-storey", "multi_storey",
    "garage", "garages", "garage_boxes",
    "carports",
    "building",
    "shed",
}
# Anything else (surface, street_side, lane, rooftop, parking_space, missing) → open_air.

# Reproject WGS84 -> HTRS96/TM (EPSG:3765, the native Croatian projected CRS).
# Used for area computation; output GeoJSON stays in WGS84.
_to_3765 = Transformer.from_crs("EPSG:4326", "EPSG:3765", always_xy=True).transform


def log(msg: str) -> None:
    """Timestamped stderr log."""
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def build_overpass_query(bbox: tuple[float, float, float, float]) -> str:
    """Return an Overpass QL query for amenity=parking nodes, ways and relations
    inside the given bbox, with all tags and full geometry. Nodes capture the
    parking lots (mostly underground / multi-storey garages) that are mapped as
    a single point because they have no surface footprint to draw."""
    s, w, n, e = bbox
    return f"""
[out:json][timeout:120];
(
  node["amenity"="parking"]({s},{w},{n},{e});
  way["amenity"="parking"]({s},{w},{n},{e});
  relation["amenity"="parking"]({s},{w},{n},{e});
);
out body geom;
""".strip()


def fetch_overpass(query: str, retries: int = 3) -> dict:
    """POST a query to Overpass and return the parsed JSON. Retries on 429/504."""
    headers = {"User-Agent": USER_AGENT}
    for attempt in range(1, retries + 1):
        log(f"Overpass request attempt {attempt}/{retries}…")
        r = requests.post(OVERPASS_URL, data={"data": query}, headers=headers, timeout=180)
        if r.status_code == 200:
            return r.json()
        log(f"  HTTP {r.status_code}; sleeping before retry")
        time.sleep(5 * attempt)
    r.raise_for_status()
    return {}


def way_to_polygon(elem: dict) -> Polygon | None:
    """Convert an Overpass `way` with inline geometry to a Shapely polygon.
    Returns None for non-closed or degenerate ways."""
    geom = elem.get("geometry") or []
    if len(geom) < 4:
        return None
    coords = [(p["lon"], p["lat"]) for p in geom]
    if coords[0] != coords[-1]:
        return None
    try:
        poly = Polygon(coords)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.area == 0:
            return None
        return poly
    except Exception:
        return None


def relation_to_geometry(elem: dict) -> Polygon | MultiPolygon | None:
    """Build a (Multi)Polygon from a multipolygon relation. Overpass with `out geom`
    inlines member coords, so we can stitch outer/inner rings without an extra fetch."""
    outers, inners = [], []
    for member in elem.get("members", []):
        if member.get("type") != "way":
            continue
        geom = member.get("geometry") or []
        if len(geom) < 2:
            continue
        ring = [(p["lon"], p["lat"]) for p in geom]
        role = member.get("role", "outer")
        (inners if role == "inner" else outers).append(ring)

    if not outers:
        return None

    polys: list[Polygon] = []
    for outer in outers:
        if len(outer) < 4 or outer[0] != outer[-1]:
            # Try to close the ring; relations sometimes ship as open ways.
            outer = outer + [outer[0]]
            if len(outer) < 4:
                continue
        try:
            poly = Polygon(outer, [r for r in inners if len(r) >= 4])
            if not poly.is_valid:
                poly = poly.buffer(0)  # this can return a MultiPolygon
            if poly.is_empty or poly.area == 0:
                continue
            # Flatten any MultiPolygon results so the parent constructor never
            # gets nested multipolys (which Shapely 2.x rejects).
            if hasattr(poly, "geoms"):
                for piece in poly.geoms:
                    if isinstance(piece, Polygon) and not piece.is_empty:
                        polys.append(piece)
            elif isinstance(poly, Polygon):
                polys.append(poly)
        except Exception:
            continue

    if not polys:
        return None
    return polys[0] if len(polys) == 1 else MultiPolygon(polys)


def area_m2(geom: Polygon | MultiPolygon) -> float:
    """Project to EPSG:3765 and return planar area in square metres."""
    projected = shapely_transform(_to_3765, geom)
    return float(projected.area)


def classify_parking_kind(tags: dict) -> str:
    """Return 'enclosed' for under-roof / underground parking, 'open_air' otherwise.
    The split mirrors what's discoverable from aerial imagery: open_air is what
    SAM 3 / Phase 1 ML can find, enclosed only ever comes from OSM."""
    raw = (tags.get("parking") or "").strip().lower()
    if raw in ENCLOSED_PARKING_KINDS:
        return "enclosed"
    # Some mappers use `location=underground` instead of `parking=underground`.
    if (tags.get("location") or "").strip().lower() == "underground":
        return "enclosed"
    return "open_air"


def parse_capacity(tags: dict) -> int | None:
    """Extract a capacity integer from OSM tags, ignoring non-numeric values."""
    raw = tags.get("capacity")
    if raw is None or raw == "":
        return None
    try:
        return int(str(raw).strip().split()[0])
    except (ValueError, IndexError):
        return None


def estimate_capacity(area: float, m2_per_stall: float) -> int:
    """Round-half-down estimated stall count based on area heuristic."""
    return max(0, int(area / m2_per_stall))


def element_to_feature(elem: dict, m2_per_stall: float) -> dict | None:
    """Convert an Overpass element (node, way, or relation) to a GeoJSON Feature
    with computed area, capacity, and parking_kind fields.

    Nodes have no geometry to compute area from, so area_m2 is None and the
    estimated capacity is None — only the OSM-tagged capacity is used. Most
    nodes are named garages (Garaža Cvjetni trg etc.) where capacity is in fact
    tagged, so the loss is small.
    """
    etype = elem["type"]
    if etype == "node":
        if "lat" not in elem or "lon" not in elem:
            return None
        geom = Point(elem["lon"], elem["lat"])
    elif etype == "way":
        geom = way_to_polygon(elem)
    elif etype == "relation":
        geom = relation_to_geometry(elem)
    else:
        return None
    if geom is None:
        return None

    tags = elem.get("tags") or {}
    parking_kind = classify_parking_kind(tags)
    tagged_capacity = parse_capacity(tags)

    if etype == "node":
        # No footprint → no area, no area-based estimate.
        area = None
        estimated_capacity = None
        capacity = tagged_capacity  # may be None if the OSM mapper didn't tag it
        capacity_source = "osm" if tagged_capacity is not None else None
    else:
        area = area_m2(geom)
        estimated_capacity = estimate_capacity(area, m2_per_stall)
        capacity = tagged_capacity if tagged_capacity is not None else estimated_capacity
        capacity_source = "osm" if tagged_capacity is not None else "area_estimate"

    return {
        "type": "Feature",
        "id": f"{etype}/{elem['id']}",
        "properties": {
            "osm_type": etype,
            "osm_id": elem["id"],
            "name": tags.get("name"),
            "parking": tags.get("parking"),  # surface, multi-storey, underground, etc.
            "parking_kind": parking_kind,    # derived: 'open_air' or 'enclosed'
            "access": tags.get("access"),
            "fee": tags.get("fee"),
            "operator": tags.get("operator"),
            "surface": tags.get("surface"),
            "area_m2": round(area, 1) if area is not None else None,
            "capacity_osm": tagged_capacity,
            "capacity_estimated": estimated_capacity,
            "capacity": capacity,
            "capacity_source": capacity_source,
            "all_tags": tags,
        },
        "geometry": mapping(geom),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bbox",
        default=",".join(str(x) for x in ZAGREB_BBOX),
        help="Bounding box as 'south,west,north,east' (default: full Zagreb)",
    )
    parser.add_argument(
        "--m2-per-stall",
        type=float,
        default=DEFAULT_M2_PER_STALL,
        help=f"Average m² per stall for area-based estimate (default: {DEFAULT_M2_PER_STALL})",
    )
    parser.add_argument(
        "--out",
        default="../data/osm/parking_zagreb.geojson",
        help="Output GeoJSON path (relative to script dir)",
    )
    args = parser.parse_args()

    bbox = tuple(float(x) for x in args.bbox.split(","))
    if len(bbox) != 4:
        print("ERROR: --bbox must be 'south,west,north,east'", file=sys.stderr)
        return 2

    out_path = (Path(__file__).parent / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    log(f"Fetching OSM amenity=parking for bbox {bbox}")
    query = build_overpass_query(bbox)
    data = fetch_overpass(query)
    elements = data.get("elements", [])
    log(f"Overpass returned {len(elements)} elements")

    features = []
    skipped = 0
    for i, elem in enumerate(elements, 1):
        if i % 500 == 0:
            log(f"  processed {i}/{len(elements)}")
        feat = element_to_feature(elem, args.m2_per_stall)
        if feat is None:
            skipped += 1
            continue
        features.append(feat)

    log(f"Built {len(features)} features ({skipped} skipped as invalid/degenerate)")

    # Summary stats for the log + the metadata block.
    by_geom = {"polygon": 0, "point": 0}
    by_kind = {"open_air": 0, "enclosed": 0}
    cap_by_kind = {"open_air": 0, "enclosed": 0}
    total_area = 0.0
    with_osm_capacity = 0
    total_capacity = 0

    for f in features:
        p = f["properties"]
        kind = p["parking_kind"]
        by_kind[kind] += 1
        is_point = f["geometry"]["type"] == "Point"
        by_geom["point" if is_point else "polygon"] += 1
        if p.get("area_m2") is not None:
            total_area += p["area_m2"]
        if p.get("capacity_osm") is not None:
            with_osm_capacity += 1
        cap = p.get("capacity") or 0
        total_capacity += cap
        cap_by_kind[kind] += cap

    log(f"  geometries: {by_geom['polygon']} polygons + {by_geom['point']} points")
    log(f"  parking kind: {by_kind['open_air']} open-air + {by_kind['enclosed']} enclosed")
    log(f"  total open polygon area: {total_area / 1e6:.2f} km²")
    log(f"  features with OSM capacity tag: {with_osm_capacity}/{len(features)} "
        f"({with_osm_capacity * 100.0 / max(len(features), 1):.1f}%)")
    log(f"  estimated total capacity: {total_capacity:,} stalls")
    log(f"    open-air: {cap_by_kind['open_air']:,}")
    log(f"    enclosed: {cap_by_kind['enclosed']:,}")

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "OpenStreetMap (Overpass API) — © OSM contributors, ODbL",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "bbox": list(bbox),
            "m2_per_stall_assumption": args.m2_per_stall,
            "feature_count": len(features),
            "feature_count_polygon": by_geom["polygon"],
            "feature_count_point": by_geom["point"],
            "feature_count_open_air": by_kind["open_air"],
            "feature_count_enclosed": by_kind["enclosed"],
            "feature_count_with_osm_capacity": with_osm_capacity,
            "total_polygon_area_m2": round(total_area, 1),
            "total_estimated_capacity": total_capacity,
            "capacity_open_air": cap_by_kind["open_air"],
            "capacity_enclosed": cap_by_kind["enclosed"],
        },
        "features": features,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
