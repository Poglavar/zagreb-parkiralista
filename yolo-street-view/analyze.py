#!/usr/bin/env python3
"""Run YOLO on street-level images and produce a per-image analysis JSON with
car positions, side-of-street classification, density patterns, size
distributions, and derived parking signals.

This is an independent pipeline — it reads images from street-view/out/images/
and metadata from street-view/out/*-candidates.json, but does NOT modify
anything in the street-view directory.

Output: yolo-street-view/out/yolo-analysis.json (consumed by viewer.html)

Usage:
  python analyze.py                         # default: all images
  python analyze.py --limit 50              # first 50 for testing
  python analyze.py --conf 0.20 --limit 10  # stricter confidence
"""

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ───────── Side classification ─────────

# In a street-view image, the camera is centered on the road. Cars near the
# left or right edge are likely parked. Cars in the center are in traffic.
# These thresholds are fractions of image width (0..1).
SIDE_LEFT_MAX = 0.30
SIDE_RIGHT_MIN = 0.70


def classify_side(x_center_frac: float) -> str:
    """Classify a detection as left-side, right-side, or center of the street."""
    if x_center_frac < SIDE_LEFT_MAX:
        return "left"
    if x_center_frac > SIDE_RIGHT_MIN:
        return "right"
    return "center"


# ───────── Parking signal analysis ─────────

def analyze_parking_signals(detections: list[dict], img_w: int, img_h: int) -> dict:
    """Derive parking signals from a set of per-image detections."""
    if not detections:
        return {
            "car_count": 0,
            "left_count": 0,
            "right_count": 0,
            "center_count": 0,
            "parking_score": 0.0,
            "parking_assessment": "no_vehicles",
            "dominant_side": "none",
            "pattern": "none",
            "avg_car_area_px": 0,
            "car_area_std_px": 0,
        }

    left = [d for d in detections if d["side"] == "left"]
    right = [d for d in detections if d["side"] == "right"]
    center = [d for d in detections if d["side"] == "center"]
    total = len(detections)

    # Size distribution (bbox area in px²)
    areas = [d["area_px"] for d in detections]
    avg_area = float(np.mean(areas)) if areas else 0
    std_area = float(np.std(areas)) if len(areas) > 1 else 0

    # Parking score: heuristic 0..1
    score = 0.0

    # Signal 1: cars concentrated on one side → likely parked
    max_side = max(len(left), len(right))
    if max_side >= 3:
        score += 0.30
    elif max_side >= 2:
        score += 0.15

    # Signal 2: cars spread vertically along the dominant side → parallel parking
    dominant = left if len(left) >= len(right) else right
    if len(dominant) >= 2:
        y_positions = [d["y_pct"] for d in dominant]
        y_spread = max(y_positions) - min(y_positions)
        if y_spread > 0.3:  # spread across >30% of image height
            score += 0.20

    # Signal 3: similar aspect ratios on dominant side → uniform parking angle
    if len(dominant) >= 2:
        aspects = [d["aspect_ratio"] for d in dominant]
        aspect_cv = float(np.std(aspects) / max(np.mean(aspects), 0.01))
        if aspect_cv < 0.4:  # coefficient of variation < 40%
            score += 0.10

    # Penalty: most cars in center → traffic, not parking
    if total > 0 and len(center) / total > 0.7:
        score -= 0.20

    # Penalty: only 1 car total → not enough evidence
    if total == 1:
        score -= 0.10

    score = max(0.0, min(1.0, score))

    # Assessment
    if score >= 0.4:
        assessment = "likely_parking"
    elif score >= 0.2:
        assessment = "possible_parking"
    else:
        assessment = "no_clear_signal"

    # Dominant side
    if len(left) > len(right) * 2 and len(left) >= 2:
        dominant_side = "left"
    elif len(right) > len(left) * 2 and len(right) >= 2:
        dominant_side = "right"
    elif len(left) >= 2 and len(right) >= 2:
        dominant_side = "both"
    else:
        dominant_side = "unclear"

    # Pattern (simple heuristic)
    if max_side >= 3 and len(dominant) >= 3:
        y_positions = sorted([d["y_pct"] for d in dominant])
        gaps = [y_positions[i + 1] - y_positions[i] for i in range(len(y_positions) - 1)]
        gap_cv = float(np.std(gaps) / max(np.mean(gaps), 0.01)) if gaps else 999
        if gap_cv < 0.6:
            pattern = "parallel"  # evenly spaced
        else:
            pattern = "clustered"  # could be angle parking or lot
    else:
        pattern = "sparse"

    return {
        "car_count": total,
        "left_count": len(left),
        "right_count": len(right),
        "center_count": len(center),
        "parking_score": round(score, 2),
        "parking_assessment": assessment,
        "dominant_side": dominant_side,
        "pattern": pattern,
        "avg_car_area_px": round(avg_area, 1),
        "car_area_std_px": round(std_area, 1),
    }


# ───────── Metadata loading ─────────

def load_capture_metadata(street_view_dir: Path) -> dict[str, dict]:
    """Build a lookup from capture_id → metadata by reading all *candidates.json files."""
    out_dir = street_view_dir / "out"
    lookup: dict[str, dict] = {}
    for f in sorted(out_dir.glob("*candidates*.json")):
        try:
            d = json.load(f.open())
            for s in d.get("segments", []):
                for c in s.get("captures", []):
                    cid = c.get("capture_id")
                    if cid:
                        lookup[cid] = {
                            "segment_id": s.get("segment_id"),
                            "heading": c.get("heading"),
                            "viewpoint": c.get("viewpoint"),
                            "direction": c.get("direction"),
                            "width_m": s.get("width_m"),
                            "length_m": s.get("length_m"),
                            "label": s.get("label"),
                        }
        except Exception as exc:
            log(f"  WARN couldn't read {f.name}: {exc}")
    return lookup


# ───────── Main ─────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--images",
        default="../street-view/out/images",
        help="Directory of street-view JPEG images",
    )
    parser.add_argument(
        "--street-view-dir",
        default="../street-view",
        help="Street-view sub-project root (for *candidates.json metadata)",
    )
    parser.add_argument("--out", default="out/yolo-analysis.json", help="Output JSON path")
    parser.add_argument("--model", default="yolov8n.pt", help="Ultralytics model (default: yolov8n.pt)")
    parser.add_argument("--conf", type=float, default=0.15, help="Confidence threshold (default: 0.15)")
    parser.add_argument("--limit", type=int, default=None, help="Stop after N images (for testing)")
    parser.add_argument(
        "--classes",
        type=int,
        nargs="+",
        default=[2, 3, 5, 7],
        help="COCO class IDs (default: car=2, motorcycle=3, bus=5, truck=7)",
    )
    args = parser.parse_args()

    here = Path(__file__).parent
    img_dir = (here / args.images).resolve()
    sv_dir = (here / args.street_view_dir).resolve()
    out_path = (here / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not img_dir.is_dir():
        print(f"ERROR: image dir not found: {img_dir}", file=sys.stderr)
        return 2

    image_paths = sorted(img_dir.glob("*.jpg"))
    if not image_paths:
        print(f"ERROR: no .jpg files in {img_dir}", file=sys.stderr)
        return 1
    log(f"Found {len(image_paths)} images in {img_dir}")

    # Load metadata
    capture_meta = load_capture_metadata(sv_dir)
    log(f"Loaded metadata for {len(capture_meta)} captures")

    # Load YOLO
    log(f"Loading {args.model}…")
    from ultralytics import YOLO
    model = YOLO(args.model)
    class_names = {k: v for k, v in model.names.items() if k in args.classes}
    log(f"  classes: {class_names}")

    # Process images
    results_list: list[dict] = []
    total_cars = 0
    t_start = time.time()
    for i, img_path in enumerate(image_paths, 1):
        if args.limit is not None and i > args.limit:
            break
        if i % 100 == 0 or i == 1:
            elapsed = time.time() - t_start
            eta = (elapsed / max(i - 1, 1)) * (len(image_paths) - i) if i > 1 else 0
            log(f"  [{i}/{len(image_paths)}] (eta {eta:.0f}s)")

        # Run YOLO
        preds = model.predict(str(img_path), conf=args.conf, classes=args.classes,
                              imgsz=640, verbose=False)
        pred = preds[0]
        boxes = pred.boxes
        img_w, img_h = 640, 640  # street-view images are always 640×640

        # Build per-detection records
        detections: list[dict] = []
        if boxes is not None and len(boxes) > 0:
            for j in range(len(boxes)):
                cls_id = int(boxes.cls[j].item())
                conf = float(boxes.conf[j].item())
                x1, y1, x2, y2 = boxes.xyxy[j].tolist()
                cx = (x1 + x2) / 2
                cy = (y1 + y2) / 2
                w = x2 - x1
                h = y2 - y1

                x_pct = cx / img_w
                y_pct = cy / img_h
                area = w * h
                aspect = w / max(h, 1)

                detections.append({
                    "class": class_names.get(cls_id, str(cls_id)),
                    "confidence": round(conf, 3),
                    "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "x_pct": round(x_pct, 3),
                    "y_pct": round(y_pct, 3),
                    "w_px": round(w, 1),
                    "h_px": round(h, 1),
                    "area_px": round(area, 1),
                    "aspect_ratio": round(aspect, 2),
                    "side": classify_side(x_pct),
                })

        # Parking signal analysis
        analysis = analyze_parking_signals(detections, img_w, img_h)
        total_cars += analysis["car_count"]

        # Merge with capture metadata
        capture_id = img_path.stem
        meta = capture_meta.get(capture_id, {})

        results_list.append({
            "filename": img_path.name,
            "capture_id": capture_id,
            "segment_id": meta.get("segment_id"),
            "direction": meta.get("direction"),
            "heading": meta.get("heading"),
            "viewpoint": meta.get("viewpoint"),
            "road_width_m": meta.get("width_m"),
            "road_length_m": meta.get("length_m"),
            "road_label": meta.get("label"),
            "detections": detections,
            "analysis": analysis,
        })

    elapsed = time.time() - t_start
    n_processed = min(len(image_paths), args.limit or len(image_paths))

    # Aggregate stats
    scores = [r["analysis"]["parking_score"] for r in results_list]
    assessments = {}
    for r in results_list:
        a = r["analysis"]["parking_assessment"]
        assessments[a] = assessments.get(a, 0) + 1

    output = {
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "conf_threshold": args.conf,
        "image_count": n_processed,
        "total_vehicles": total_cars,
        "avg_vehicles_per_image": round(total_cars / max(n_processed, 1), 2),
        "parking_assessments": assessments,
        "elapsed_s": round(elapsed, 1),
        "images": results_list,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=1)
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    log(f"Processed {n_processed} images in {elapsed:.1f}s ({elapsed / max(n_processed, 1):.2f}s/img)")
    log(f"Total vehicles: {total_cars}, avg/image: {total_cars / max(n_processed, 1):.1f}")
    log(f"Parking assessments: {assessments}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
