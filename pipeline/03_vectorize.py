#!/usr/bin/env python3
"""Phase 1 step 3: Convert binary mask GeoTIFFs from 02_segment.py into a single
GeoJSON FeatureCollection of candidate parking-lot polygons.

For each mask:
  1. Read the raster and use rasterio.features.shapes() to extract polygons
     for the foreground (mask > 0) regions.
  2. Reproject pixel coordinates to the raster's CRS, then to WGS84 for output.
  3. Apply geometric filters (min area, compactness) to drop obvious false
     positives like roads, sidewalks, and noise blobs.
  4. Optionally regularize edges (parallel/perpendicular snapping) for cleaner
     orthogonal parking-lot polygons. Falls back to Douglas-Peucker simplify
     if samgeo's regularize is unavailable.

Usage:
  python 03_vectorize.py --masks ../data/masks/cdof2022 --out ../data/candidates/raw_candidates.geojson
  python 03_vectorize.py --masks ../data/masks/cdof2022 --min-area 200 --min-compactness 0.1
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import rasterio
from rasterio.features import shapes as raster_shapes
from rasterio.warp import transform_geom
from shapely.geometry import shape, mapping, MultiPolygon, Polygon


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def polsby_popper(geom) -> float:
    """Compactness score: 1.0 = perfect circle, → 0 for elongated/irregular.
    Most parking lots score 0.2–0.6; roads and sidewalks score < 0.05."""
    if geom.length == 0:
        return 0.0
    return 4 * math.pi * geom.area / (geom.length ** 2)


def extract_polygons_from_mask(mask_path: Path) -> list[dict]:
    """Read a binary mask GeoTIFF and return a list of GeoJSON features in WGS84
    with computed area, perimeter, and compactness in the source CRS."""
    out: list[dict] = []
    with rasterio.open(mask_path) as src:
        band = src.read(1)
        if band.max() == 0:
            return []  # nothing detected in this tile

        # Threshold to a strict binary mask. samgeo's text-SAM output is usually
        # already 0/1 or 0/255, but harden against soft probabilities just in case.
        binary = (band > 0).astype("uint8")
        crs = src.crs

        # rasterio.features.shapes yields (geom, value) for each contiguous region.
        for geom_dict, value in raster_shapes(binary, mask=binary > 0, transform=src.transform):
            if value == 0:
                continue
            geom = shape(geom_dict)
            if geom.is_empty:
                continue
            if isinstance(geom, MultiPolygon):
                # Split for per-piece filtering; recombine downstream if needed.
                pieces = list(geom.geoms)
            elif isinstance(geom, Polygon):
                pieces = [geom]
            else:
                continue

            for piece in pieces:
                area_m2 = piece.area
                perimeter_m = piece.length
                compactness = polsby_popper(piece)

                # Reproject to WGS84 for the GeoJSON output.
                wgs84_geom = transform_geom(crs, "EPSG:4326", mapping(piece))

                out.append({
                    "type": "Feature",
                    "geometry": wgs84_geom,
                    "properties": {
                        "source_tile": mask_path.stem,
                        "area_m2": round(area_m2, 1),
                        "perimeter_m": round(perimeter_m, 1),
                        "compactness": round(compactness, 3),
                        "source_crs": str(crs),
                    },
                })
    return out


def try_regularize(features: list[dict]) -> list[dict]:
    """Try to use samgeo's polygon regularization if available; otherwise no-op.
    Regularization snaps edges to common angles, producing cleaner orthogonal
    polygons that match human-made structures like parking lots."""
    try:
        from samgeo.common import regularize  # samgeo v1.3.x; may move
    except ImportError:
        log("  samgeo regularize() unavailable — skipping regularization step")
        return features

    log(f"  Regularizing {len(features)} features…")
    # The samgeo regularize API expects a path. We round-trip to a temp file.
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".geojson", mode="w", delete=False) as tmp_in:
        json.dump({"type": "FeatureCollection", "features": features}, tmp_in)
        tmp_in_path = tmp_in.name
    tmp_out_path = tmp_in_path.replace(".geojson", "_reg.geojson")
    try:
        regularize(tmp_in_path, tmp_out_path)
        with open(tmp_out_path) as f:
            return json.load(f).get("features", features)
    except Exception as exc:
        log(f"  regularize failed ({exc}) — keeping raw polygons")
        return features


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--masks",
        required=True,
        help="Input directory of mask GeoTIFFs (typically data/masks/<source>/)",
    )
    parser.add_argument(
        "--out",
        default="../data/candidates/raw_candidates.geojson",
        help="Output GeoJSON path",
    )
    parser.add_argument(
        "--min-area",
        type=float,
        default=200.0,
        help="Drop polygons smaller than this area in m² (default: 200)",
    )
    parser.add_argument(
        "--max-area",
        type=float,
        default=200_000.0,
        help="Drop polygons larger than this area in m² (default: 200000 — drops whole-block false positives)",
    )
    parser.add_argument(
        "--min-compactness",
        type=float,
        default=0.08,
        help="Drop polygons with Polsby-Popper score below this (default: 0.08)",
    )
    parser.add_argument(
        "--no-regularize",
        action="store_true",
        help="Skip the regularize step even if samgeo offers it",
    )
    args = parser.parse_args()

    mask_dir = Path(args.masks).resolve()
    if not mask_dir.is_dir():
        print(f"ERROR: input dir does not exist: {mask_dir}", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = (Path(__file__).parent / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    mask_paths = sorted(mask_dir.glob("*.tif"))
    if not mask_paths:
        log(f"No mask .tif files in {mask_dir}; did you run 02_segment.py?")
        return 1
    log(f"Vectorizing {len(mask_paths)} masks from {mask_dir}")

    raw_features: list[dict] = []
    for i, mp in enumerate(mask_paths, 1):
        if i % 25 == 0 or i == 1:
            log(f"  [{i}/{len(mask_paths)}] {mp.name}")
        raw_features.extend(extract_polygons_from_mask(mp))
    log(f"Extracted {len(raw_features)} raw polygons before filtering")

    # Apply area + compactness filters.
    filtered: list[dict] = []
    rejected_area = rejected_compact = 0
    for feat in raw_features:
        area = feat["properties"]["area_m2"]
        compactness = feat["properties"]["compactness"]
        if area < args.min_area or area > args.max_area:
            rejected_area += 1
            continue
        if compactness < args.min_compactness:
            rejected_compact += 1
            continue
        filtered.append(feat)
    log(f"After filters: {len(filtered)} kept, {rejected_area} rejected by area, "
        f"{rejected_compact} rejected by compactness")

    # Try to regularize edges of the surviving polygons.
    if not args.no_regularize and filtered:
        filtered = try_regularize(filtered)

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "SAM 3 (text-prompted) on WMS orthophoto tiles",
            "vectorized_at": datetime.now(timezone.utc).isoformat(),
            "input_mask_dir": str(mask_dir),
            "input_mask_count": len(mask_paths),
            "filter_min_area_m2": args.min_area,
            "filter_max_area_m2": args.max_area,
            "filter_min_compactness": args.min_compactness,
            "feature_count": len(filtered),
        },
        "features": filtered,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
