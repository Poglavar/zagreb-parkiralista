#!/usr/bin/env python3
"""Fetch OSM landuse / leisure / natural / amenity polygons for Zagreb so the
informal-parking classifier (20_detect_informal.py) can label each detected
vehicle by what's underneath: park, grass, courtyard, school, industrial yard,
square, etc.

Output is a single GeoJSON FeatureCollection at data/osm/landuse_zagreb.geojson
with properties.kind set to one of the broad categories the classifier knows
about. Original OSM tags are preserved in properties.osm_tags.

This is intentionally a one-shot fetch — re-run it manually when you want
fresh OSM data. The file is small (a few MB) so checking it into git is fine.

Usage:
  python 21_fetch_landuse.py
  python 21_fetch_landuse.py --bbox 45.70,15.80,46.00,16.20 --out ../data/osm/landuse_zagreb.geojson
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from shapely.geometry import Polygon, MultiPolygon, mapping

ZAGREB_BBOX = (45.70, 15.80, 46.00, 16.20)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "zagreb-parkiralista/0.1 (contact: github.com/simun)"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def build_query(bbox: tuple[float, float, float, float]) -> str:
    """Overpass QL pulling everything that could plausibly be 'underneath' an
    informally-parked car. Both ways and relations are fetched with full inline
    geometry so we can build polygons without follow-up requests."""
    s, w, n, e = bbox
    return f"""
[out:json][timeout:180];
(
  way[landuse]({s},{w},{n},{e});
  way[leisure]({s},{w},{n},{e});
  way[natural~"grassland|wood|water|wetland|scrub|heath"]({s},{w},{n},{e});
  way[amenity~"school|hospital|university|kindergarten|college|courthouse|fire_station|police"]({s},{w},{n},{e});
  way[place~"square"]({s},{w},{n},{e});

  relation[landuse]({s},{w},{n},{e});
  relation[leisure]({s},{w},{n},{e});
  relation[natural~"grassland|wood|water|wetland|scrub|heath"]({s},{w},{n},{e});
  relation[amenity~"school|hospital|university|kindergarten|college|courthouse|fire_station|police"]({s},{w},{n},{e});
);
out body geom;
""".strip()


def classify_kind(tags: dict) -> str | None:
    """Map an OSM-tag bag to one of the broad categories the classifier knows
    about. Returns None for things we explicitly don't care about (e.g. very
    abstract `landuse=residential` parents that overlap everything)."""
    leisure = (tags.get("leisure") or "").lower()
    landuse = (tags.get("landuse") or "").lower()
    natural = (tags.get("natural") or "").lower()
    amenity = (tags.get("amenity") or "").lower()
    place = (tags.get("place") or "").lower()

    if leisure in ("park", "garden", "playground", "pitch", "golf_course",
                   "common", "nature_reserve", "dog_park"):
        return "park_or_playground"
    if natural in ("grassland", "scrub", "heath"):
        return "green_space"
    if natural in ("wood",) or landuse in ("forest",):
        return "wood"
    if natural in ("water", "wetland"):
        return "water"
    if landuse in ("grass", "village_green", "meadow", "recreation_ground",
                   "allotments", "cemetery", "orchard"):
        return "green_space"
    if amenity in ("school", "kindergarten", "college", "university"):
        return "school_grounds"
    if amenity in ("hospital",):
        return "hospital_grounds"
    if amenity in ("courthouse", "fire_station", "police"):
        return "civic_grounds"
    if landuse in ("industrial",):
        return "industrial_yard"
    if landuse in ("commercial", "retail"):
        return "commercial_area"
    if landuse in ("construction",):
        return "construction_site"
    if place in ("square", "town_square"):
        return "square"
    if landuse in ("residential",):
        # Big ambiguous polygons that cover whole neighbourhoods. Useful as a
        # fallback when nothing more specific matches, but lower priority.
        return "residential_block"
    if landuse in ("farmland",):
        return "farmland"
    return None


# Priority order — first match wins when a point falls inside multiple polygons.
# Specific things rank higher than generic neighbourhood blocks.
KIND_PRIORITY = [
    "park_or_playground",
    "playground",
    "school_grounds",
    "hospital_grounds",
    "civic_grounds",
    "square",
    "green_space",
    "wood",
    "water",
    "industrial_yard",
    "commercial_area",
    "construction_site",
    "farmland",
    "residential_block",  # the catch-all "you're in a residential block" → courtyard
]
KIND_PRIORITY_INDEX = {k: i for i, k in enumerate(KIND_PRIORITY)}


def way_to_polygon(elem: dict) -> Polygon | None:
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
    """Build a (Multi)Polygon from a multipolygon relation. Same logic as the
    parking fetcher — Overpass with `out geom` inlines member coords so we don't
    need a follow-up roundtrip."""
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


def fetch_overpass(query: str, retries: int = 3) -> dict:
    headers = {"User-Agent": USER_AGENT}
    for attempt in range(1, retries + 1):
        log(f"Overpass request attempt {attempt}/{retries}…")
        r = requests.post(OVERPASS_URL, data={"data": query}, headers=headers, timeout=240)
        if r.status_code == 200:
            return r.json()
        log(f"  HTTP {r.status_code}; sleeping before retry")
        time.sleep(5 * attempt)
    r.raise_for_status()
    return {}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--bbox",
        default=",".join(str(x) for x in ZAGREB_BBOX),
        help="Bounding box as 'south,west,north,east' (default: full Zagreb)",
    )
    parser.add_argument(
        "--out",
        default="../data/osm/landuse_zagreb.geojson",
        help="Output GeoJSON path",
    )
    args = parser.parse_args()

    bbox = tuple(float(x) for x in args.bbox.split(","))
    if len(bbox) != 4:
        print("ERROR: --bbox must be 'south,west,north,east'", file=sys.stderr)
        return 2

    out_path = (Path(__file__).parent / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    log(f"Fetching OSM landuse for bbox {bbox}")
    query = build_query(bbox)
    data = fetch_overpass(query)
    elements = data.get("elements", [])
    log(f"Overpass returned {len(elements)} elements")

    features: list[dict] = []
    skipped = 0
    by_kind: dict[str, int] = {}
    for i, elem in enumerate(elements, 1):
        if i % 1000 == 0:
            log(f"  processed {i}/{len(elements)}")
        tags = elem.get("tags") or {}
        kind = classify_kind(tags)
        if kind is None:
            skipped += 1
            continue
        if elem["type"] == "way":
            geom = way_to_polygon(elem)
        elif elem["type"] == "relation":
            geom = relation_to_geometry(elem)
        else:
            continue
        if geom is None:
            skipped += 1
            continue

        by_kind[kind] = by_kind.get(kind, 0) + 1
        features.append({
            "type": "Feature",
            "id": f"{elem['type']}/{elem['id']}",
            "geometry": mapping(geom),
            "properties": {
                "kind": kind,
                "kind_priority": KIND_PRIORITY_INDEX.get(kind, 999),
                "name": tags.get("name"),
                "osm_type": elem["type"],
                "osm_id": elem["id"],
                "osm_tags": tags,
            },
        })

    log(f"Built {len(features)} landuse features ({skipped} skipped/no-kind)")
    log(f"By kind: {by_kind}")

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "OpenStreetMap (Overpass API) — © OSM contributors, ODbL",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "bbox": list(bbox),
            "feature_count": len(features),
            "by_kind": by_kind,
        },
        "features": features,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
