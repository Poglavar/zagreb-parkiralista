#!/usr/bin/env python3
"""Phase 5 step 1: Render a composite preview image for the LLM cartographer.

The composite stitches an N×N window of CDOF GeoTIFF tiles into one square
RGB image, then overlays:

  - OSM road network (yellow/white lines)             — visible even where canopy hides asphalt
  - OSM parking polygons (blue, thick border)          — what's already mapped
  - OSM enclosed parking nodes (purple "P" pin)        — multi-storey / underground garages
  - YOLO vehicle detections (small red dots)           — cars peeking through
  - A small legend in the corner

Output: PNG + sidecar JSON with the composite's geographic bounds in EPSG:3765
and WGS84, used by 31_llm_propose.py to invert LLM bbox suggestions back to
geographic coordinates.

Usage:
  python 30_render_composite.py --center-tile 2980,33035 --grid 3
  python 30_render_composite.py --bbox 15.96,45.80,15.98,45.82
  python 30_render_composite.py --bbox-3765 458000,5073000,458600,5073600
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.enums import Resampling
from PIL import Image, ImageDraw, ImageFont
from pyproj import Transformer
from shapely.geometry import shape, box
from shapely.ops import transform as shapely_transform


_to_3765 = Transformer.from_crs("EPSG:4326", "EPSG:3765", always_xy=True).transform
_to_4326 = Transformer.from_crs("EPSG:3765", "EPSG:4326", always_xy=True).transform


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ───────── Geometry helpers ─────────

def project_3765(geom_dict: dict):
    return shapely_transform(_to_3765, shape(geom_dict))


def to_pixel(x: float, y: float, bbox_3765: tuple, w: int, h: int) -> tuple[float, float]:
    """Map a point from EPSG:3765 to image pixel coordinates."""
    minx, miny, maxx, maxy = bbox_3765
    px = (x - minx) / (maxx - minx) * w
    py = (maxy - y) / (maxy - miny) * h  # y is flipped (image origin top-left)
    return (px, py)


# ───────── Tile selection / stitching ─────────

def find_intersecting_tiles(tile_dir: Path, bbox_3765: tuple) -> list[Path]:
    """Find all GeoTIFF tiles in tile_dir whose bounds intersect the target bbox."""
    target = box(*bbox_3765)
    out: list[Path] = []
    for p in sorted(tile_dir.glob("*.tif")):
        try:
            with rasterio.open(p) as src:
                tile_box = box(*src.bounds)
                if tile_box.intersects(target):
                    out.append(p)
        except Exception as exc:
            log(f"  WARN couldn't read {p.name}: {exc}")
    return out


def compute_bbox_from_center_tile(tile_dir: Path, col: int, row: int, grid: int) -> tuple[float, float, float, float]:
    """Compute an N×N tile-grid window centered on (col, row) and return its
    EPSG:3765 bounds. The center tile must exist on disk."""
    tile_path = tile_dir / f"tile_{col}_{row}.tif"
    if not tile_path.exists():
        raise SystemExit(f"center tile not found: {tile_path}")
    with rasterio.open(tile_path) as src:
        tx0, ty0, tx1, ty1 = src.bounds
        tile_w = tx1 - tx0
        tile_h = ty1 - ty0
    half = grid // 2
    return (
        tx0 - half * tile_w,
        ty0 - half * tile_h,
        tx1 + half * tile_w,
        ty1 + half * tile_h,
    )


def stitch_to_pil(tile_paths: list[Path], bbox_3765: tuple, output_size: tuple[int, int]) -> Image.Image:
    """Merge tiles within bbox using rasterio.merge, resample to output_size,
    return PIL RGB image."""
    if not tile_paths:
        raise SystemExit("no tiles to stitch — bbox doesn't intersect any cached tile")

    target_w, target_h = output_size
    target_res = (bbox_3765[2] - bbox_3765[0]) / target_w  # metres per pixel

    srcs = [rasterio.open(p) for p in tile_paths]
    try:
        merged_arr, _ = merge(
            srcs,
            bounds=bbox_3765,
            res=target_res,
            resampling=Resampling.bilinear,
        )
    finally:
        for s in srcs:
            s.close()

    # Drop alpha band; if grayscale, fan out to 3 channels.
    if merged_arr.shape[0] >= 3:
        rgb = merged_arr[:3]
    else:
        rgb = np.repeat(merged_arr[:1], 3, axis=0)
    rgb = np.transpose(rgb, (1, 2, 0))  # CHW -> HWC
    if rgb.dtype != np.uint8:
        rgb = rgb.astype(np.uint8)

    img = Image.fromarray(rgb, mode="RGB")
    if img.size != output_size:
        img = img.resize(output_size, Image.Resampling.LANCZOS)
    return img


# ───────── Overlays ─────────

# Yellow/white street network so it stays visible over both dark asphalt and
# bright canopy. Order roughly matches OSM importance — major streets thicker.
HIGHWAY_STYLE = {
    "motorway":      ((255, 200, 50, 230),  5),
    "trunk":         ((255, 200, 50, 230),  5),
    "primary":       ((255, 200, 50, 230),  4),
    "secondary":     ((255, 220, 100, 220), 3),
    "tertiary":      ((255, 230, 130, 220), 3),
    "residential":   ((255, 255, 255, 220), 2),
    "unclassified":  ((255, 255, 255, 200), 2),
    "living_street": ((255, 255, 255, 200), 2),
    "service":       ((220, 220, 220, 180), 1),
    "pedestrian":    ((255, 200, 200, 200), 2),
}


def overlay_roads(img: Image.Image, road_features: list[dict], bbox_3765: tuple, w: int, h: int) -> int:
    """Draw OSM road network on the image. Returns count of features drawn."""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    target = box(*bbox_3765)
    drawn = 0
    for f in road_features:
        try:
            line_3765 = project_3765(f["geometry"])
            if not line_3765.intersects(target):
                continue
            highway = (f["properties"].get("highway") or "").lower()
            style = HIGHWAY_STYLE.get(highway)
            if style is None:
                continue
            color, width = style
            coords = list(line_3765.coords)
            pixels = [to_pixel(x, y, bbox_3765, w, h) for x, y in coords]
            for i in range(len(pixels) - 1):
                draw.line([pixels[i], pixels[i + 1]], fill=color, width=width)
            drawn += 1
        except Exception:
            continue
    img.paste(overlay, (0, 0), overlay)
    return drawn


def overlay_parking(img: Image.Image, parking_features: list[dict], bbox_3765: tuple, w: int, h: int) -> tuple[int, int]:
    """Draw OSM parking polygons (blue translucent fill, thick navy border) and
    enclosed-garage nodes (purple P pin). Returns (polygons_drawn, nodes_drawn)."""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    target = box(*bbox_3765)

    polygons_drawn = nodes_drawn = 0
    for f in parking_features:
        gtype = f["geometry"]["type"]
        try:
            g_3765 = project_3765(f["geometry"])
            if not g_3765.intersects(target):
                continue

            if gtype == "Point":
                px, py = to_pixel(g_3765.x, g_3765.y, bbox_3765, w, h)
                r = 9
                draw.ellipse(
                    [px - r, py - r, px + r, py + r],
                    fill=(124, 58, 237, 230),
                    outline=(40, 10, 80, 255),
                    width=2,
                )
                # White P inside the circle
                try:
                    draw.text((px - 4, py - 7), "P", fill=(255, 255, 255, 255))
                except Exception:
                    pass
                nodes_drawn += 1
                continue

            if gtype == "Polygon":
                rings = [list(g_3765.exterior.coords)]
            elif gtype == "MultiPolygon":
                rings = [list(poly.exterior.coords) for poly in g_3765.geoms]
            else:
                continue

            for ring in rings:
                pixels = [to_pixel(x, y, bbox_3765, w, h) for x, y in ring]
                if len(pixels) < 3:
                    continue
                # Filled polygon for visibility
                draw.polygon(pixels, fill=(37, 99, 235, 110))
                # Then a thick border (PIL polygon outline doesn't support width)
                for i in range(len(pixels)):
                    p1 = pixels[i]
                    p2 = pixels[(i + 1) % len(pixels)]
                    draw.line([p1, p2], fill=(20, 40, 120, 255), width=3)
                polygons_drawn += 1
        except Exception:
            continue

    img.paste(overlay, (0, 0), overlay)
    return polygons_drawn, nodes_drawn


def overlay_vehicles(img: Image.Image, vehicle_features: list[dict], bbox_3765: tuple, w: int, h: int) -> int:
    """Draw YOLO vehicle detections as small red dots."""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    target = box(*bbox_3765)
    drawn = 0
    for f in vehicle_features:
        try:
            pt_3765 = project_3765(f["geometry"])
            if not target.contains(pt_3765):
                continue
            px, py = to_pixel(pt_3765.x, pt_3765.y, bbox_3765, w, h)
            r = 4
            draw.ellipse(
                [px - r, py - r, px + r, py + r],
                fill=(255, 60, 60, 255),
                outline=(120, 20, 20, 255),
                width=1,
            )
            drawn += 1
        except Exception:
            continue
    img.paste(overlay, (0, 0), overlay)
    return drawn


def draw_legend(img: Image.Image, w: int, h: int, meta: dict) -> None:
    """Draw a small legend in the bottom-left corner of the image."""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    pad = 12
    box_w = 220
    box_h = 110
    x0 = pad
    y0 = h - box_h - pad

    draw.rectangle(
        [x0, y0, x0 + box_w, y0 + box_h],
        fill=(0, 0, 0, 200),
        outline=(255, 255, 255, 220),
        width=1,
    )

    line_y = y0 + 8
    line_height = 18
    text_x = x0 + 36

    # Parking polygon swatch
    draw.rectangle([x0 + 12, line_y + 2, x0 + 28, line_y + 14],
                   fill=(37, 99, 235, 200), outline=(20, 40, 120, 255), width=2)
    draw.text((text_x, line_y), "OSM parking", fill=(255, 255, 255, 255))
    line_y += line_height

    # Garage pin
    draw.ellipse([x0 + 13, line_y + 2, x0 + 27, line_y + 14],
                 fill=(124, 58, 237, 230), outline=(40, 10, 80, 255), width=2)
    draw.text((text_x, line_y), "Garaža (node)", fill=(255, 255, 255, 255))
    line_y += line_height

    # Detected car
    draw.ellipse([x0 + 16, line_y + 4, x0 + 24, line_y + 12],
                 fill=(255, 60, 60, 255), outline=(120, 20, 20, 255), width=1)
    draw.text((text_x, line_y), "Detektirano vozilo", fill=(255, 255, 255, 255))
    line_y += line_height

    # Road
    draw.line([(x0 + 12, line_y + 8), (x0 + 28, line_y + 8)],
              fill=(255, 255, 255, 220), width=2)
    draw.text((text_x, line_y), "OSM ulica", fill=(255, 255, 255, 255))
    line_y += line_height

    # Footer with bbox info
    draw.text(
        (x0 + 8, y0 + box_h - 14),
        f"{meta['size_m']:.0f}×{meta['size_m']:.0f} m  ·  {meta['mpp']:.2f} m/px",
        fill=(200, 200, 200, 255),
    )

    img.paste(overlay, (0, 0), overlay)


# ───────── Main ─────────

def load_features(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    return data.get("features", [])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tiles", default="../data/tiles/cdof2022", help="Source tile dir")
    parser.add_argument("--center-tile", help="Center tile as 'col,row' for an N×N grid window")
    parser.add_argument("--grid", type=int, default=3, help="N for N×N grid window (default 3)")
    parser.add_argument("--bbox", help="WGS84 bbox 'west,south,east,north' (overrides --center-tile)")
    parser.add_argument("--bbox-3765", help="EPSG:3765 bbox 'minx,miny,maxx,maxy' (overrides others)")
    parser.add_argument("--output-size", type=int, default=1024, help="Output PNG size in pixels (square)")
    parser.add_argument(
        "--out",
        default=None,
        help="Output PNG path (default: data/composites/cdof2022/composite_<id>.png)",
    )
    parser.add_argument("--osm-parking", default="../data/osm/parking_zagreb.geojson")
    parser.add_argument("--osm-roads", default="../data/osm/highways_zagreb.geojson")
    parser.add_argument("--vehicles", default="../data/candidates/vehicles.geojson")
    parser.add_argument(
        "--no-vehicles",
        action="store_true",
        help="Skip drawing YOLO vehicle detections (cleaner image, less context for the LLM)",
    )
    args = parser.parse_args()

    tile_dir = Path(args.tiles)
    if not tile_dir.is_absolute():
        tile_dir = (Path(__file__).parent / tile_dir).resolve()
    if not tile_dir.is_dir():
        print(f"ERROR: tile dir not found: {tile_dir}", file=sys.stderr)
        return 2

    # Resolve target bbox in EPSG:3765
    if args.bbox_3765:
        parts = [float(x) for x in args.bbox_3765.split(",")]
        if len(parts) != 4:
            print("ERROR: --bbox-3765 must be 'minx,miny,maxx,maxy'", file=sys.stderr)
            return 2
        bbox_3765 = tuple(parts)
        composite_id = f"bbox_{int(parts[0])}_{int(parts[1])}"
    elif args.bbox:
        wgs = [float(x) for x in args.bbox.split(",")]
        if len(wgs) != 4:
            print("ERROR: --bbox must be 'west,south,east,north'", file=sys.stderr)
            return 2
        # WGS bbox -> EPSG:3765 envelope (4 corners, axis-aligned envelope)
        xs, ys = [], []
        for lon, lat in [(wgs[0], wgs[1]), (wgs[2], wgs[1]), (wgs[2], wgs[3]), (wgs[0], wgs[3])]:
            x, y = _to_3765(lon, lat)
            xs.append(x)
            ys.append(y)
        bbox_3765 = (min(xs), min(ys), max(xs), max(ys))
        composite_id = f"wgs_{wgs[0]:.4f}_{wgs[1]:.4f}"
    else:
        if not args.center_tile:
            print("ERROR: provide --center-tile, --bbox, or --bbox-3765", file=sys.stderr)
            return 2
        col, row = (int(x) for x in args.center_tile.split(","))
        bbox_3765 = compute_bbox_from_center_tile(tile_dir, col, row, args.grid)
        composite_id = f"tile_{col}_{row}_g{args.grid}"

    log(f"Target bbox EPSG:3765: {tuple(round(x, 1) for x in bbox_3765)}")
    size_m = bbox_3765[2] - bbox_3765[0]
    output_w = output_h = args.output_size
    log(f"Composite size: {output_w}×{output_h} px = {size_m:.0f} m × {size_m:.0f} m  "
        f"({size_m / output_w:.2f} m/px)")

    # Find source tiles
    intersecting = find_intersecting_tiles(tile_dir, bbox_3765)
    log(f"Found {len(intersecting)} source tiles intersecting bbox")
    if not intersecting:
        print(f"ERROR: no source tiles intersect this bbox. Run 01_fetch_tiles.py first.", file=sys.stderr)
        return 1

    # Stitch
    img = stitch_to_pil(intersecting, bbox_3765, (output_w, output_h))
    log(f"Stitched composite: {img.size}")

    # Overlays
    parking_features = load_features((Path(__file__).parent / args.osm_parking).resolve())
    road_features = load_features((Path(__file__).parent / args.osm_roads).resolve())
    vehicle_features = [] if args.no_vehicles else load_features(
        (Path(__file__).parent / args.vehicles).resolve()
    )
    log(f"Loaded {len(parking_features)} parking, {len(road_features)} roads, {len(vehicle_features)} vehicles")

    n_roads = overlay_roads(img, road_features, bbox_3765, output_w, output_h)
    n_polys, n_nodes = overlay_parking(img, parking_features, bbox_3765, output_w, output_h)
    n_cars = overlay_vehicles(img, vehicle_features, bbox_3765, output_w, output_h)
    log(f"Drew {n_roads} roads, {n_polys} parking polygons, {n_nodes} garage pins, {n_cars} vehicles")

    # Legend
    draw_legend(img, output_w, output_h, {
        "size_m": size_m,
        "mpp": size_m / output_w,
    })

    # Output paths
    if args.out:
        out_png = Path(args.out)
        if not out_png.is_absolute():
            out_png = (Path(__file__).parent / out_png).resolve()
    else:
        out_dir = (Path(__file__).parent / "../data/composites/cdof2022").resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        out_png = out_dir / f"composite_{composite_id}.png"
    out_png.parent.mkdir(parents=True, exist_ok=True)

    img.save(out_png, format="PNG")
    log(f"Wrote {out_png} ({out_png.stat().st_size / 1024:.1f} KiB)")

    # WGS84 corners for the metadata sidecar
    minx, miny, maxx, maxy = bbox_3765
    sw_lon, sw_lat = _to_4326(minx, miny)
    ne_lon, ne_lat = _to_4326(maxx, maxy)
    nw_lon, nw_lat = _to_4326(minx, maxy)
    se_lon, se_lat = _to_4326(maxx, miny)

    metadata = {
        "composite_id": composite_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tile_dir": str(tile_dir),
        "source_tiles": [p.name for p in intersecting],
        "image_w": output_w,
        "image_h": output_h,
        "size_m": size_m,
        "mpp": size_m / output_w,
        "bbox_3765": list(bbox_3765),
        "bbox_wgs84": {
            "west": min(sw_lon, nw_lon),
            "south": min(sw_lat, se_lat),
            "east": max(ne_lon, se_lon),
            "north": max(nw_lat, ne_lat),
        },
        "corners_wgs84": {
            "sw": [sw_lon, sw_lat],
            "se": [se_lon, se_lat],
            "ne": [ne_lon, ne_lat],
            "nw": [nw_lon, nw_lat],
        },
        "n_roads_drawn": n_roads,
        "n_parking_polygons_drawn": n_polys,
        "n_garage_pins_drawn": n_nodes,
        "n_vehicles_drawn": n_cars,
    }
    out_json = out_png.with_suffix(".json")
    with out_json.open("w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    log(f"Wrote {out_json} ({out_json.stat().st_size / 1024:.1f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
