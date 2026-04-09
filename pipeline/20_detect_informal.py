#!/usr/bin/env python3
"""Phase 3 step 2: Identify informal ("de facto") parking — vehicles parked
outside any officially-mapped parking area.

Inputs:
  - data/candidates/vehicles.geojson (from 11_detect_vehicles.py): YOLO-detected
    vehicle Points
  - data/osm/parking_zagreb.geojson (from 00_fetch_osm.py): OSM parking polygons
    + nodes (open-air + enclosed)
  - data/candidates/missing_parking.geojson (from 04_diff_osm.py, optional):
    ML-detected parking polygons not yet in OSM

Process:
  1. Build the union of all official parking polygons (OSM + ML), buffered by
     a small distance (default 5 m) so cars parked right at the edge of a lot
     aren't flagged as informal.
  2. Convert nodes (point-only OSM parking) into small circular areas with the
     same buffer so vehicles inside underground/multi-storey garage entrances
     are absorbed too.
  3. For every detected vehicle, test whether its centroid falls inside this
     "official parking" union. Vehicles outside it become informal candidates.
  4. (Optional) Classify each informal vehicle by what's underneath via OSM
     `landuse` / `highway` / `leisure` tags. Skipped in this v0 — left as a
     hook for a future enrichment script.

Output:
  data/final/informal_parking.geojson — Point features, one per informal vehicle,
  with the original detection properties plus the distance to the nearest
  official parking polygon (helps QA).

Usage:
  python 20_detect_informal.py
  python 20_detect_informal.py --buffer 3.0 --min-conf 0.1
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import shape, mapping, Point, Polygon
from shapely.ops import transform as shapely_transform, unary_union
from shapely.strtree import STRtree


_to_3765 = Transformer.from_crs("EPSG:4326", "EPSG:3765", always_xy=True).transform
_to_4326 = Transformer.from_crs("EPSG:3765", "EPSG:4326", always_xy=True).transform


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_features(path: Path) -> tuple[dict, list[dict]]:
    """Load a GeoJSON FeatureCollection from disk; tolerate missing files."""
    if not path.exists():
        return {}, []
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if data.get("type") != "FeatureCollection":
        raise ValueError(f"{path} is not a GeoJSON FeatureCollection")
    return data.get("metadata", {}), data.get("features", [])


def project_3765(geom_dict: dict):
    """WGS84 GeoJSON geometry dict → Shapely geom in EPSG:3765 (metres)."""
    g = shape(geom_dict)
    return shapely_transform(_to_3765, g)


def buffer_official_parking(features: list[dict], buffer_m: float):
    """Project every official parking feature to EPSG:3765 and buffer it.
    Polygons get a flat buffer; nodes (Point) get a small circle (buffer +
    typical garage footprint estimate ≈ 15 m) since the OSM mapper marked the
    entrance, not the actual extent."""
    geoms = []
    for f in features:
        gtype = f.get("geometry", {}).get("type")
        if gtype not in ("Point", "Polygon", "MultiPolygon"):
            continue
        try:
            g = project_3765(f["geometry"])
            if gtype == "Point":
                # A point usually marks a garage entrance — assume the actual
                # facility extends ~15 m radius around it. Tweak if you have
                # better priors. The user can also override via --node-radius.
                g = g.buffer(15.0 + buffer_m)
            else:
                g = g.buffer(buffer_m)
            if not g.is_empty:
                geoms.append(g)
        except Exception as exc:
            log(f"  WARN failed to project feature: {exc}")
    return geoms


def build_landuse_index(landuse_features: list[dict]):
    """Project landuse polygons to EPSG:3765 and return (parts, kinds, tree).
    parts is a flat list of Shapely Polygons (only Polygons — anything else from
    buffer(0) cleanup is filtered out), kinds and priorities are parallel lists,
    tree is an STRtree spatial index. The classifier uses the index to find the
    dominant kind under each vehicle."""
    parts: list[Polygon] = []
    kinds: list[str] = []
    priorities: list[int] = []
    for f in landuse_features:
        try:
            g = project_3765(f["geometry"])
        except Exception:
            continue
        if g.is_empty:
            continue
        kind = f["properties"].get("kind", "other")
        prio = f["properties"].get("kind_priority", 999)
        # Only Polygons go into the tree. buffer(0) cleanup can yield Points
        # or LineStrings on degenerate input, which would confuse contains().
        if hasattr(g, "geoms"):
            for piece in g.geoms:
                if isinstance(piece, Polygon) and not piece.is_empty:
                    parts.append(piece)
                    kinds.append(kind)
                    priorities.append(prio)
        elif isinstance(g, Polygon):
            parts.append(g)
            kinds.append(kind)
            priorities.append(prio)
    tree = STRtree(parts) if parts else None
    return parts, kinds, priorities, tree


def classify_informal_vehicle(pt_3765, parts, kinds, priorities, tree) -> str:
    """Find the highest-priority landuse polygon containing this point.
    Falls back to 'roadside_or_unknown' when no polygon contains it — most of
    those are vehicles parked on the street network or in pavement gaps that
    OSM doesn't model as polygons."""
    if tree is None or not parts:
        return "unknown"
    candidate_idxs = tree.query(pt_3765)
    best_kind = None
    best_prio = 999
    for idx in candidate_idxs:
        i = int(idx)
        # Defensive bounds check — Shapely 2.x STRtree has occasionally returned
        # indices outside the tree's input length on edge cases. Skip silently.
        if i < 0 or i >= len(parts):
            continue
        if parts[i].contains(pt_3765):
            if priorities[i] < best_prio:
                best_prio = priorities[i]
                best_kind = kinds[i]
    return best_kind or "roadside_or_unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--vehicles",
        default="../data/candidates/vehicles.geojson",
        help="GeoJSON of detected vehicles from 11_detect_vehicles.py",
    )
    parser.add_argument(
        "--osm",
        default="../data/osm/parking_zagreb.geojson",
        help="OSM parking baseline from 00_fetch_osm.py",
    )
    parser.add_argument(
        "--ml-candidates",
        default="../data/candidates/missing_parking.geojson",
        help="ML-detected parking from 04_diff_osm.py (optional, used if file exists)",
    )
    parser.add_argument(
        "--landuse",
        default="../data/osm/landuse_zagreb.geojson",
        help="OSM landuse polygons from 21_fetch_landuse.py (optional, used if file exists). "
             "When present, each informal vehicle is classified by what's underneath.",
    )
    parser.add_argument(
        "--out",
        default="../data/final/informal_parking.geojson",
        help="Output GeoJSON of informal parking candidates",
    )
    parser.add_argument(
        "--buffer",
        type=float,
        default=5.0,
        help="Edge tolerance in metres for the official parking polygons (default: 5)",
    )
    parser.add_argument(
        "--min-conf",
        type=float,
        default=0.0,
        help="Drop vehicles below this confidence (default: 0 = keep all)",
    )
    parser.add_argument(
        "--require-plausible-size",
        action="store_true",
        help="Drop vehicles whose ground-space bbox doesn't look like a car",
    )
    args = parser.parse_args()

    here = Path(__file__).parent
    vehicles_path = (here / args.vehicles).resolve()
    osm_path = (here / args.osm).resolve()
    ml_path = (here / args.ml_candidates).resolve()
    landuse_path = (here / args.landuse).resolve()
    out_path = (here / args.out).resolve()

    if not vehicles_path.exists():
        print(f"ERROR: vehicles.geojson not found at {vehicles_path}. Run 11_detect_vehicles.py first.",
              file=sys.stderr)
        return 2
    if not osm_path.exists():
        print(f"ERROR: OSM baseline not found at {osm_path}. Run 00_fetch_osm.py first.",
              file=sys.stderr)
        return 2

    log(f"Loading vehicles: {vehicles_path}")
    _, vehicles = load_features(vehicles_path)
    log(f"  {len(vehicles)} vehicles loaded")

    log(f"Loading OSM parking baseline: {osm_path}")
    _, osm_features = load_features(osm_path)
    log(f"  {len(osm_features)} OSM parking features")

    if ml_path.exists():
        log(f"Loading ML candidates: {ml_path}")
        _, ml_features = load_features(ml_path)
        log(f"  {len(ml_features)} ML candidate polygons")
    else:
        ml_features = []
        log(f"  no ML candidates file (skipping — run 04_diff_osm.py to add them)")

    if landuse_path.exists():
        log(f"Loading OSM landuse for classification: {landuse_path}")
        _, landuse_features = load_features(landuse_path)
        log(f"  {len(landuse_features)} landuse polygons")
        parts, kinds, priorities, landuse_tree = build_landuse_index(landuse_features)
        log(f"  built landuse index with {len(parts)} polygon parts")
    else:
        landuse_features = []
        parts, kinds, priorities, landuse_tree = [], [], [], None
        log(f"  no landuse file (run 21_fetch_landuse.py to enable classification)")

    log(f"Buffering official parking polygons by {args.buffer} m…")
    official_geoms = buffer_official_parking(osm_features + ml_features, args.buffer)
    log(f"  {len(official_geoms)} buffered geoms")

    log(f"Building union of official parking…")
    if not official_geoms:
        log(f"  no official parking — every vehicle will be flagged informal")
        official_union = None
        official_tree = None
        official_parts: list = []
    else:
        official_union = unary_union(official_geoms)
        # Spatial index over the unioned components for fast point-in-polygon.
        # NB: deliberately distinct from `parts` (landuse parts) — earlier
        # versions of this script reused that name and silently broke landuse
        # classification because the bounds check ate every result.
        if hasattr(official_union, "geoms"):
            official_parts = list(official_union.geoms)
        else:
            official_parts = [official_union]
        official_tree = STRtree(official_parts)
        log(f"  union has {len(official_parts)} parts")

    log(f"Classifying {len(vehicles)} vehicles…")
    informal: list[dict] = []
    inside = 0
    dropped_conf = 0
    dropped_size = 0

    for i, v in enumerate(vehicles, 1):
        if i % 1000 == 0:
            log(f"  progress: {i}/{len(vehicles)}")
        props = v.get("properties", {})
        if props.get("confidence", 1.0) < args.min_conf:
            dropped_conf += 1
            continue
        if args.require_plausible_size and not props.get("size_plausible", True):
            dropped_size += 1
            continue

        try:
            pt_3765 = project_3765(v["geometry"])
        except Exception as exc:
            log(f"  WARN bad vehicle geom #{i}: {exc}")
            continue

        is_official = False
        nearest_distance = None
        if official_tree is not None and official_parts:
            candidate_idxs = official_tree.query(pt_3765)
            for idx in candidate_idxs:
                i = int(idx)
                if i < 0 or i >= len(official_parts):
                    continue
                if official_parts[i].contains(pt_3765):
                    is_official = True
                    break
            if not is_official:
                # Compute distance to the nearest official polygon for QA.
                try:
                    nearest_idx = official_tree.nearest(pt_3765)
                    ni = int(nearest_idx)
                    if 0 <= ni < len(official_parts):
                        nearest_distance = float(pt_3765.distance(official_parts[ni]))
                except Exception:
                    nearest_distance = None

        if is_official:
            inside += 1
            continue

        out_props = dict(props)
        if nearest_distance is not None:
            out_props["distance_to_official_m"] = round(nearest_distance, 1)
        out_props["informal_type"] = classify_informal_vehicle(
            pt_3765, parts, kinds, priorities, landuse_tree
        )
        informal.append({
            "type": "Feature",
            "geometry": v["geometry"],
            "properties": out_props,
        })

    by_type: dict[str, int] = {}
    for f in informal:
        t = f["properties"].get("informal_type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1

    log(f"Result: {len(informal)} informal, {inside} inside official, "
        f"{dropped_conf} dropped (low conf), {dropped_size} dropped (implausible size)")
    log(f"By informal_type: {by_type}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "Phase 3 informal parking detection",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "input_vehicles": str(vehicles_path),
            "input_osm": str(osm_path),
            "input_ml_candidates": str(ml_path) if ml_path.exists() else None,
            "buffer_m": args.buffer,
            "min_conf": args.min_conf,
            "require_plausible_size": args.require_plausible_size,
            "vehicles_total": len(vehicles),
            "vehicles_inside_official": inside,
            "vehicles_informal": len(informal),
            "informal_by_type": by_type,
        },
        "features": informal,
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
