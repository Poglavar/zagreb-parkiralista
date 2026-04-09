#!/usr/bin/env python3
"""Phase 3 step 1: Run an aerial vehicle detector over a directory of GeoTIFF
tiles and write a single GeoJSON FeatureCollection of detected vehicles (one
Point per detection).

Default model is Ultralytics YOLOv8n trained on COCO. **This is a placeholder.**
COCO YOLO is trained on ground-level photos and finds parked cars from above
only at low confidence (~0.05–0.15). For production we should fine-tune on
CARPK / VEDAI / DOTA — drone-captured top-down vehicle datasets at the right
GSD. Until then, expect noisy output and use --conf to tune precision/recall.

The script avoids HuggingFace gating entirely: Ultralytics weights are pulled
from GitHub releases, no token required.

Usage:
  python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022
  python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022 --model yolov8x.pt --conf 0.15
  python 11_detect_vehicles.py --tiles ../data/tiles/cdof2022 --limit 3
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

# COCO class IDs for vehicles. We deliberately skip class 4 (airplane) and 8 (boat).
COCO_VEHICLE_CLASSES = {
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

# Reproject EPSG:3765 (HTRS96/TM, native for CDOF/DOF5) to WGS84 for the output.
_to_4326 = Transformer.from_crs("EPSG:3765", "EPSG:4326", always_xy=True).transform


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def init_yolo(model_name: str):
    """Lazy-import ultralytics so the heavy ML deps aren't required for other phases."""
    log(f"Importing ultralytics…")
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        print(
            "ERROR: ultralytics not installed. Run: pip install -r requirements-ml.txt",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    log(f"Loading {model_name} (auto-downloads from GitHub releases on first run)…")
    t0 = time.time()
    model = YOLO(model_name)
    log(f"  loaded in {time.time() - t0:.1f}s, {len(model.names)} classes")
    return model


def read_tile_as_rgb(path: Path) -> tuple[np.ndarray, rasterio.Affine, str]:
    """Read a GeoTIFF tile and return (HWC RGB uint8 array, affine transform, CRS)."""
    with rasterio.open(path) as src:
        n_bands = src.count
        # CDOF tiles are RGBA; YOLO needs RGB.
        bands_to_read = [1, 2, 3] if n_bands >= 3 else [1, 1, 1]
        arr = src.read(bands_to_read)
        arr = np.transpose(arr, (1, 2, 0))  # CHW -> HWC
        if arr.dtype != np.uint8:
            arr = arr.astype(np.uint8)
        return arr, src.transform, str(src.crs)


def pixel_to_world(transform: rasterio.Affine, px: float, py: float) -> tuple[float, float]:
    """Apply an affine transform to a pixel coordinate. Returns (X, Y) in the
    raster's native CRS (EPSG:3765 for CDOF / DOF5)."""
    x, y = transform * (px, py)
    return float(x), float(y)


def detect_in_tile(
    model,
    tile_path: Path,
    conf: float,
    imgsz: int,
    classes: list[int],
) -> list[dict]:
    """Run YOLO on one tile and return a list of GeoJSON Point features."""
    img, transform, crs = read_tile_as_rgb(tile_path)
    if crs != "EPSG:3765":
        log(f"  WARN tile {tile_path.name} has CRS {crs}, expected EPSG:3765 — output may be misaligned")

    results = model.predict(
        img,
        conf=conf,
        classes=classes,
        imgsz=imgsz,
        verbose=False,
    )
    if not results:
        return []

    out: list[dict] = []
    r = results[0]
    if r.boxes is None or len(r.boxes) == 0:
        return out

    boxes = r.boxes
    for i in range(len(boxes)):
        cls_id = int(boxes.cls[i].item())
        confidence = float(boxes.conf[i].item())
        x, y, w, h = boxes.xywh[i].tolist()  # pixel space, centered

        # Centroid in pixel space → projected coords (EPSG:3765) → WGS84
        cx_3765, cy_3765 = pixel_to_world(transform, x, y)
        lon, lat = _to_4326(cx_3765, cy_3765)

        # Approximate ground-space size of the detection.
        # transform.a is the X pixel size in metres (positive), transform.e is the Y
        # pixel size (negative for north-up rasters). Take absolute values.
        px_w_m = abs(transform.a)
        px_h_m = abs(transform.e)
        bbox_w_m = w * px_w_m
        bbox_h_m = h * px_h_m

        out.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "source_tile": tile_path.stem,
                "class": COCO_VEHICLE_CLASSES.get(cls_id, str(cls_id)),
                "class_id": cls_id,
                "confidence": round(confidence, 3),
                "bbox_w_m": round(bbox_w_m, 1),
                "bbox_h_m": round(bbox_h_m, 1),
                # Pixel-space bbox in the source tile, used by the viewer to draw
                # a red box overlay on top of the JPEG preview. Center xy + w/h.
                "bbox_px_cx": round(x, 1),
                "bbox_px_cy": round(y, 1),
                "bbox_px_w": round(w, 1),
                "bbox_px_h": round(h, 1),
                "tile_px_w": img.shape[1],
                "tile_px_h": img.shape[0],
                # Cheap sanity flag — real cars are roughly 4×2 m, allow 2.5–7 × 1.0–3.5
                "size_plausible": 2.5 <= bbox_w_m <= 8.0 and 1.0 <= bbox_h_m <= 4.0
                                  or 1.0 <= bbox_w_m <= 4.0 and 2.5 <= bbox_h_m <= 8.0,
            },
        })
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--tiles",
        required=True,
        help="Input directory of GeoTIFF tiles (typically data/tiles/<source>/)",
    )
    parser.add_argument(
        "--out",
        default="../data/candidates/vehicles.geojson",
        help="Output GeoJSON path (relative to script dir if not absolute)",
    )
    parser.add_argument(
        "--model",
        default="yolov8n.pt",
        help="Ultralytics model file. Options: yolov8n/s/m/l/x.pt, yolo11n/s/m/l/x.pt. "
             "n = fastest, x = most accurate. Default: yolov8n.pt (placeholder; fine-tune on CARPK for production).",
    )
    parser.add_argument(
        "--conf",
        type=float,
        default=0.05,
        help="Confidence threshold (default: 0.05). COCO YOLO scores aerial cars low; raise for production.",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=1024,
        help="Inference image size in pixels (default: 1024 = full tile)",
    )
    parser.add_argument(
        "--classes",
        type=int,
        nargs="+",
        default=list(COCO_VEHICLE_CLASSES.keys()),
        help="COCO class IDs to keep (default: car=2, motorcycle=3, bus=5, truck=7)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Stop after this many tiles (handy for smoke tests)",
    )
    parser.add_argument(
        "--require-plausible-size",
        action="store_true",
        help="Drop detections whose ground-space bbox doesn't look like a car",
    )
    args = parser.parse_args()

    tile_dir = Path(args.tiles).resolve()
    if not tile_dir.is_dir():
        print(f"ERROR: input dir does not exist: {tile_dir}", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = (Path(__file__).parent / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    tile_paths = sorted(tile_dir.glob("*.tif"))
    if not tile_paths:
        log(f"No .tif files in {tile_dir}; did you run 01_fetch_tiles.py?")
        return 1
    log(f"Found {len(tile_paths)} tiles in {tile_dir}")
    log(f"Model: {args.model}, conf: {args.conf}, classes: {args.classes}")

    model = init_yolo(args.model)

    all_features: list[dict] = []
    processed = failed = 0
    t_start = time.time()
    for i, tile_path in enumerate(tile_paths, 1):
        if args.limit is not None and processed >= args.limit:
            log(f"Reached --limit={args.limit}, stopping")
            break
        elapsed = time.time() - t_start
        eta = (elapsed / max(processed, 1)) * (len(tile_paths) - i) if processed > 0 else 0
        try:
            features = detect_in_tile(
                model, tile_path, args.conf, args.imgsz, args.classes
            )
            if args.require_plausible_size:
                features = [f for f in features if f["properties"]["size_plausible"]]
            all_features.extend(features)
            processed += 1
            log(f"  [{i}/{len(tile_paths)}] {tile_path.name}: {len(features)} detections (eta {eta:.0f}s)")
        except Exception as exc:
            failed += 1
            log(f"  [{i}/{len(tile_paths)}] {tile_path.name}: ERROR {type(exc).__name__}: {exc}")

    # Summary stats by class.
    by_class: dict[str, int] = {}
    for f in all_features:
        c = f["properties"]["class"]
        by_class[c] = by_class.get(c, 0) + 1
    plausible = sum(1 for f in all_features if f["properties"]["size_plausible"])

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": f"Ultralytics YOLO ({args.model}) on aerial GeoTIFF tiles",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "input_dir": str(tile_dir),
            "tile_count": processed,
            "model": args.model,
            "conf_threshold": args.conf,
            "feature_count": len(all_features),
            "feature_count_plausible_size": plausible,
            "by_class": by_class,
        },
        "features": all_features,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))

    log(f"Done. tiles_processed={processed} failed={failed} detections={len(all_features)} "
        f"plausible={plausible}")
    log(f"By class: {by_class}")
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    log(f"Total time: {time.time() - t_start:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
