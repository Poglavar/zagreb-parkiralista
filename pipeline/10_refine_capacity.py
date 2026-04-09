#!/usr/bin/env python3
"""Phase 2: Build the project's "final" parking GeoJSON by merging the OSM
baseline (Phase 0) and ML-detected missing polygons (Phase 1, optional), and
attaching a unified `capacity_final` field with provenance.

For each feature the priority order for capacity is:
  1. OSM `capacity` tag (if present)
  2. Area-based heuristic (area_m2 / m2_per_stall) for polygons
  3. None (for nodes with no OSM capacity tag — typically nameless street-side
     pin drops; small enough to ignore)

The script also adds a `source` field — 'osm' for everything from Phase 0,
'ml' for everything from Phase 1 — and copies/normalises a small set of
publishing-friendly fields. The output is what the public viewer will load
once we point it at /data/final/ instead of /data/osm/.

A future v2 of this script will add the *refined* capacity from car/stall
detection on the highest-resolution tiles (Phase 3 vehicle counts vs. lot
area). The hook is the `capacity_method = 'stall_detection'` slot.

Usage:
  python 10_refine_capacity.py
  python 10_refine_capacity.py --m2-per-stall 27 --osm ../data/osm/parking_zagreb.geojson
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_features(path: Path) -> tuple[dict, list[dict]]:
    if not path.exists():
        return {}, []
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if data.get("type") != "FeatureCollection":
        raise ValueError(f"{path} is not a GeoJSON FeatureCollection")
    return data.get("metadata", {}), data.get("features", [])


def normalise_osm_feature(f: dict, m2_per_stall: float) -> dict:
    """Take an OSM feature from Phase 0 and copy through the fields the viewer
    actually needs, computing capacity_final + capacity_method consistently."""
    p = f.get("properties", {}) or {}
    osm_cap = p.get("capacity_osm")
    area = p.get("area_m2")

    if osm_cap is not None:
        capacity_final = osm_cap
        capacity_method = "osm_tag"
    elif area is not None:
        capacity_final = max(0, int(area / m2_per_stall))
        capacity_method = "area_estimate"
    else:
        capacity_final = None
        capacity_method = "none"

    new_props = {
        "source": "osm",
        "osm_type": p.get("osm_type"),
        "osm_id": p.get("osm_id"),
        "name": p.get("name"),
        "parking": p.get("parking"),
        "parking_kind": p.get("parking_kind"),
        "access": p.get("access"),
        "fee": p.get("fee"),
        "operator": p.get("operator"),
        "surface": p.get("surface"),
        "area_m2": area,
        "capacity_osm": osm_cap,
        "capacity_final": capacity_final,
        "capacity_method": capacity_method,
    }
    return {
        "type": "Feature",
        "id": f.get("id"),
        "geometry": f.get("geometry"),
        "properties": new_props,
    }


def normalise_ml_feature(f: dict, m2_per_stall: float, idx: int) -> dict:
    """Phase 1 ML output → final shape. ML features have no OSM tag, so capacity
    always comes from the area heuristic."""
    p = f.get("properties", {}) or {}
    area = p.get("area_m2")
    capacity_final = max(0, int(area / m2_per_stall)) if area is not None else None

    new_props = {
        "source": "ml",
        "ml_id": idx,
        "ml_source_tile": p.get("source_tile"),
        "ml_compactness": p.get("compactness"),
        "ml_iou_with_osm": p.get("best_iou_with_osm"),
        "name": None,
        "parking": "surface",     # ML can only see open-air; assume surface
        "parking_kind": "open_air",
        "area_m2": area,
        "capacity_osm": None,
        "capacity_final": capacity_final,
        "capacity_method": "area_estimate",
    }
    return {
        "type": "Feature",
        "id": f"ml/{idx}",
        "geometry": f.get("geometry"),
        "properties": new_props,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--osm",
        default="../data/osm/parking_zagreb.geojson",
        help="OSM baseline GeoJSON from 00_fetch_osm.py",
    )
    parser.add_argument(
        "--ml-candidates",
        default="../data/candidates/missing_parking.geojson",
        help="ML candidates from 04_diff_osm.py (optional, used if file exists)",
    )
    parser.add_argument(
        "--out",
        default="../data/final/parking_with_capacity.geojson",
        help="Output GeoJSON path",
    )
    parser.add_argument(
        "--m2-per-stall",
        type=float,
        default=25.0,
        help="Per-stall footprint in m² for area-based capacity (default: 25)",
    )
    args = parser.parse_args()

    here = Path(__file__).parent
    osm_path = (here / args.osm).resolve()
    ml_path = (here / args.ml_candidates).resolve()
    out_path = (here / args.out).resolve()

    if not osm_path.exists():
        print(f"ERROR: OSM baseline not found at {osm_path}. Run 00_fetch_osm.py first.",
              file=sys.stderr)
        return 2

    log(f"Loading OSM baseline: {osm_path}")
    osm_meta, osm_features = load_features(osm_path)
    log(f"  {len(osm_features)} OSM features")

    if ml_path.exists():
        log(f"Loading ML candidates: {ml_path}")
        _, ml_features = load_features(ml_path)
        log(f"  {len(ml_features)} ML candidate polygons")
    else:
        ml_features = []
        log(f"  no ML candidates yet (run 04_diff_osm.py to add them)")

    log(f"Normalising features…")
    final_features: list[dict] = []
    for f in osm_features:
        final_features.append(normalise_osm_feature(f, args.m2_per_stall))
    for i, f in enumerate(ml_features):
        final_features.append(normalise_ml_feature(f, args.m2_per_stall, i))

    # Aggregate stats by source × parking_kind for the metadata block.
    by_source = {"osm": 0, "ml": 0}
    by_kind = {"open_air": 0, "enclosed": 0}
    cap_by_kind = {"open_air": 0, "enclosed": 0}
    cap_by_method = {"osm_tag": 0, "area_estimate": 0, "stall_detection": 0, "none": 0}
    for f in final_features:
        p = f["properties"]
        by_source[p["source"]] += 1
        by_kind[p["parking_kind"]] += 1
        cap = p.get("capacity_final") or 0
        cap_by_kind[p["parking_kind"]] += cap
        cap_by_method[p["capacity_method"]] = cap_by_method.get(p["capacity_method"], 0) + cap

    log(f"  by source: {by_source}")
    log(f"  by parking_kind: {by_kind}")
    log(f"  capacity by kind: {cap_by_kind}")
    log(f"  capacity by method: {cap_by_method}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "Phase 2 capacity refinement (OSM baseline + ML candidates merged)",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "input_osm": str(osm_path),
            "input_ml_candidates": str(ml_path) if ml_path.exists() else None,
            "m2_per_stall_assumption": args.m2_per_stall,
            "feature_count": len(final_features),
            "feature_count_osm": by_source["osm"],
            "feature_count_ml": by_source["ml"],
            "feature_count_open_air": by_kind["open_air"],
            "feature_count_enclosed": by_kind["enclosed"],
            "capacity_open_air": cap_by_kind["open_air"],
            "capacity_enclosed": cap_by_kind["enclosed"],
            "capacity_by_method": cap_by_method,
            "total_capacity": sum(cap_by_kind.values()),
        },
        "features": final_features,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
