#!/usr/bin/env python3
"""Phase 1 step 4: Compare ML-detected candidate parking polygons against the
OSM baseline from Phase 0, and emit two outputs:

  - missing_parking.geojson — candidates that don't overlap any OSM parking
    polygon (i.e. potential additions to OSM)
  - overlapping_parking.geojson — candidates that DO overlap an existing OSM
    polygon (useful for validating model recall and spotting OSM polygons
    whose shape is wrong)

Overlap is decided by IoU (Intersection over Union) above a threshold,
computed in EPSG:3765 so areas are in metres. An rtree spatial index makes
the comparison O(N log M) instead of O(N*M).

Usage:
  python 04_diff_osm.py
  python 04_diff_osm.py --candidates ../data/candidates/raw_candidates.geojson --iou 0.3
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shapely_transform
from shapely.strtree import STRtree


_to_3765 = Transformer.from_crs("EPSG:4326", "EPSG:3765", always_xy=True).transform
_to_4326 = Transformer.from_crs("EPSG:3765", "EPSG:4326", always_xy=True).transform


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_features(path: Path) -> tuple[dict, list[dict]]:
    """Load a GeoJSON FeatureCollection from disk, returning (metadata, features)."""
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if data.get("type") != "FeatureCollection":
        raise ValueError(f"{path} is not a GeoJSON FeatureCollection")
    return data.get("metadata", {}), data.get("features", [])


def project_geom(geom_dict: dict):
    """Convert a WGS84 GeoJSON geometry dict to a Shapely geom in EPSG:3765."""
    g = shape(geom_dict)
    return shapely_transform(_to_3765, g)


def iou(a, b) -> float:
    """Intersection over Union for two Shapely geometries (must be in same CRS)."""
    if not a.intersects(b):
        return 0.0
    inter = a.intersection(b).area
    if inter == 0:
        return 0.0
    union = a.union(b).area
    return inter / union if union > 0 else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--osm",
        default="../data/osm/parking_zagreb.geojson",
        help="OSM baseline GeoJSON from 00_fetch_osm.py",
    )
    parser.add_argument(
        "--candidates",
        default="../data/candidates/raw_candidates.geojson",
        help="ML candidates GeoJSON from 03_vectorize.py",
    )
    parser.add_argument(
        "--iou",
        type=float,
        default=0.3,
        help="IoU threshold above which a candidate is considered 'already in OSM' (default: 0.3)",
    )
    parser.add_argument(
        "--missing-out",
        default="../data/candidates/missing_parking.geojson",
        help="Output: candidates with no OSM overlap (potential additions)",
    )
    parser.add_argument(
        "--overlap-out",
        default="../data/candidates/overlapping_parking.geojson",
        help="Output: candidates that overlap OSM (validates recall)",
    )
    args = parser.parse_args()

    here = Path(__file__).parent
    osm_path = (here / args.osm).resolve()
    cand_path = (here / args.candidates).resolve()
    missing_path = (here / args.missing_out).resolve()
    overlap_path = (here / args.overlap_out).resolve()

    if not osm_path.exists():
        print(f"ERROR: OSM baseline not found at {osm_path}. Run 00_fetch_osm.py first.", file=sys.stderr)
        return 2
    if not cand_path.exists():
        print(f"ERROR: candidates not found at {cand_path}. Run 03_vectorize.py first.", file=sys.stderr)
        return 2

    log(f"Loading OSM baseline: {osm_path}")
    _, osm_features = load_features(osm_path)
    log(f"  {len(osm_features)} OSM polygons")

    log(f"Loading candidates: {cand_path}")
    _, cand_features = load_features(cand_path)
    log(f"  {len(cand_features)} candidate polygons")

    # Project all OSM geometries to EPSG:3765 once and build a spatial index.
    log("Projecting OSM geometries to EPSG:3765 and building spatial index…")
    osm_geoms_3765 = [project_geom(f["geometry"]) for f in osm_features]
    tree = STRtree(osm_geoms_3765)

    missing: list[dict] = []
    overlapping: list[dict] = []

    for i, cand in enumerate(cand_features, 1):
        if i % 100 == 0:
            log(f"  diff progress: {i}/{len(cand_features)}")
        cand_geom = project_geom(cand["geometry"])
        # Quick spatial-index lookup of intersecting OSM polygons.
        candidates_idxs = tree.query(cand_geom)
        best_iou = 0.0
        best_idx = None
        for idx in candidates_idxs:
            score = iou(cand_geom, osm_geoms_3765[idx])
            if score > best_iou:
                best_iou = score
                best_idx = int(idx)

        new_props = dict(cand["properties"])
        new_props["best_iou_with_osm"] = round(best_iou, 3)
        if best_idx is not None:
            matched = osm_features[best_idx]["properties"]
            new_props["matched_osm_id"] = f"{matched.get('osm_type')}/{matched.get('osm_id')}"

        new_feat = {"type": "Feature", "geometry": cand["geometry"], "properties": new_props}

        if best_iou >= args.iou:
            overlapping.append(new_feat)
        else:
            missing.append(new_feat)

    log(f"Result: {len(missing)} missing-from-OSM, {len(overlapping)} overlapping (IoU≥{args.iou})")

    metadata_base = {
        "diffed_at": datetime.now(timezone.utc).isoformat(),
        "osm_baseline_path": str(osm_path),
        "candidates_path": str(cand_path),
        "iou_threshold": args.iou,
        "candidate_count": len(cand_features),
    }

    missing_path.parent.mkdir(parents=True, exist_ok=True)
    overlap_path.parent.mkdir(parents=True, exist_ok=True)

    with missing_path.open("w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "metadata": {**metadata_base, "feature_count": len(missing), "category": "missing_from_osm"},
            "features": missing,
        }, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {missing_path} ({missing_path.stat().st_size / 1024:.1f} KiB)")

    with overlap_path.open("w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "metadata": {**metadata_base, "feature_count": len(overlapping), "category": "overlapping_osm"},
            "features": overlapping,
        }, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {overlap_path} ({overlap_path.stat().st_size / 1024:.1f} KiB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
