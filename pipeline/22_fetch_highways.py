#!/usr/bin/env python3
"""Fetch OSM highway network for Zagreb so the Phase 5 composite renderer can
overlay street geometries on top of aerial imagery — important when tree canopy
hides the roads in the photo.

Output is a single GeoJSON FeatureCollection at data/osm/highways_zagreb.geojson
with LineString features and the original `highway` tag preserved in properties.

Usage:
  python 22_fetch_highways.py
  python 22_fetch_highways.py --bbox 45.70,15.80,46.00,16.20
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ZAGREB_BBOX = (45.70, 15.80, 46.00, 16.20)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "zagreb-parkiralista/0.1 (contact: github.com/simun)"

# We deliberately fetch all highway types (including footways/paths) so the
# downstream renderer can decide which ones to actually draw — sidewalks may be
# useful for sidewalk-parking analysis later.
HIGHWAY_FILTER = "motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|living_street|pedestrian|footway|path|cycleway|track"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def build_query(bbox: tuple[float, float, float, float]) -> str:
    s, w, n, e = bbox
    return f"""
[out:json][timeout:180];
(
  way[highway~"{HIGHWAY_FILTER}"]({s},{w},{n},{e});
);
out body geom;
""".strip()


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


def way_to_linestring_feature(elem: dict) -> dict | None:
    """Convert an Overpass way with inline geometry to a GeoJSON LineString
    feature. Skips degenerate (<2 nodes) ways."""
    geom = elem.get("geometry") or []
    if len(geom) < 2:
        return None
    coords = [[p["lon"], p["lat"]] for p in geom]
    tags = elem.get("tags") or {}
    return {
        "type": "Feature",
        "id": f"way/{elem['id']}",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "osm_id": elem["id"],
            "highway": tags.get("highway"),
            "name": tags.get("name"),
            "ref": tags.get("ref"),
            "oneway": tags.get("oneway"),
            "lanes": tags.get("lanes"),
            "maxspeed": tags.get("maxspeed"),
            "surface": tags.get("surface"),
            "parking_lane": tags.get("parking:lane"),
            "parking_lane_left": tags.get("parking:lane:left"),
            "parking_lane_right": tags.get("parking:lane:right"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--bbox",
        default=",".join(str(x) for x in ZAGREB_BBOX),
        help="Bounding box as 'south,west,north,east' (default: full Zagreb)",
    )
    parser.add_argument(
        "--out",
        default="../data/osm/highways_zagreb.geojson",
        help="Output GeoJSON path",
    )
    args = parser.parse_args()

    bbox = tuple(float(x) for x in args.bbox.split(","))
    if len(bbox) != 4:
        print("ERROR: --bbox must be 'south,west,north,east'", file=sys.stderr)
        return 2

    out_path = (Path(__file__).parent / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    log(f"Fetching OSM highways for bbox {bbox}")
    data = fetch_overpass(build_query(bbox))
    elements = data.get("elements", [])
    log(f"Overpass returned {len(elements)} highway ways")

    features: list[dict] = []
    by_type: dict[str, int] = {}
    for elem in elements:
        feat = way_to_linestring_feature(elem)
        if feat is None:
            continue
        features.append(feat)
        h = feat["properties"].get("highway") or "?"
        by_type[h] = by_type.get(h, 0) + 1

    log(f"Built {len(features)} LineString features")
    log(f"By highway type: {by_type}")

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "OpenStreetMap (Overpass API) — © OSM contributors, ODbL",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "bbox": list(bbox),
            "feature_count": len(features),
            "by_highway_type": by_type,
        },
        "features": features,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
