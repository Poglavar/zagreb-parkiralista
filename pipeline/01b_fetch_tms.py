#!/usr/bin/env python3
"""Fetch aerial imagery from a TMS (Tile Map Service) endpoint, stitch NxN
tiles into 1024×1024 GeoTIFFs, and reproject to EPSG:3765 for compatibility
with the rest of the pipeline.

Default source is the Croatian OSM community's Zagreb 2018 orthophoto at
https://tms.osm-hr.org/zagreb-2018/{z}/{x}/{y}.png — free, no auth needed.

Usage:
  python 01b_fetch_tms.py --bbox 15.96,45.80,15.98,45.82 --zoom 20
  python 01b_fetch_tms.py --bbox 15.94,45.79,16.02,45.83 --zoom 20 --max-tiles 20
  python 01b_fetch_tms.py --source-name zagreb-2018 --zoom 19
"""

import argparse
import io
import math
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import calculate_default_transform, reproject, Resampling
from PIL import Image
import requests


DEFAULT_TMS_URL = "https://tms.osm-hr.org/zagreb-2018/{z}/{x}/{y}.png"
DEFAULT_SOURCE_NAME = "zagreb-2018"
DEFAULT_ZOOM = 20
DEFAULT_STITCH = 4     # NxN TMS tiles per output tile → 4×4 = 1024×1024 from 256×256 sources
DEFAULT_BBOX = "15.96,45.80,15.98,45.82"  # small test area
USER_AGENT = "zagreb-parkiralista/0.1 (City of Zagreb)"
TMS_TILE_PX = 256

# EPSG:3857 constants (Web Mercator)
EARTH_CIRCUMFERENCE = 40075016.686


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# ───────── TMS coordinate math ─────────

def lonlat_to_tms(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    """Convert WGS84 lon/lat to TMS tile coordinates at a given zoom level.
    Returns (x, y_tms) where y is flipped (TMS convention: origin at bottom-left)."""
    n = 2 ** zoom
    x = int((lon + 180) / 360 * n)
    y_slippy = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    y_tms = n - 1 - y_slippy
    return (x, y_tms)


def tms_tile_bounds_3857(x: int, y_tms: int, zoom: int) -> tuple[float, float, float, float]:
    """Return EPSG:3857 (Web Mercator) bounds (minx, miny, maxx, maxy) for a TMS tile."""
    n = 2 ** zoom
    tile_size = EARTH_CIRCUMFERENCE / n
    origin = EARTH_CIRCUMFERENCE / 2  # 20037508.343 m

    minx = x * tile_size - origin
    maxx = (x + 1) * tile_size - origin
    miny = y_tms * tile_size - origin
    maxy = (y_tms + 1) * tile_size - origin

    return (minx, miny, maxx, maxy)


def compute_output_grid(bbox_wgs84: tuple[float, float, float, float], zoom: int, stitch: int
                        ) -> list[tuple[int, int, int, int, int, int, tuple]]:
    """Compute the output tile grid. Each output tile is stitch×stitch TMS tiles.
    Returns list of (out_col, out_row, tms_x_start, tms_y_start, tms_x_end, tms_y_end, bounds_3857)."""
    west, south, east, north = bbox_wgs84

    # Corner TMS coordinates
    x_min, y_max_tms = lonlat_to_tms(west, north, zoom)   # top-left
    x_max, y_min_tms = lonlat_to_tms(east, south, zoom)   # bottom-right
    x_max += 1  # exclusive end
    y_max_tms += 1

    # Snap to stitch-aligned grid
    x_min = (x_min // stitch) * stitch
    y_min_tms = (y_min_tms // stitch) * stitch
    x_max = math.ceil(x_max / stitch) * stitch
    y_max_tms = math.ceil(y_max_tms / stitch) * stitch

    grid = []
    out_col = 0
    for bx in range(x_min, x_max, stitch):
        out_row = 0
        for by in range(y_min_tms, y_max_tms, stitch):
            # EPSG:3857 bounds for the stitched output tile
            minx_3857 = tms_tile_bounds_3857(bx, by, zoom)[0]
            miny_3857 = tms_tile_bounds_3857(bx, by, zoom)[1]
            maxx_3857 = tms_tile_bounds_3857(bx + stitch - 1, by + stitch - 1, zoom)[2]
            maxy_3857 = tms_tile_bounds_3857(bx + stitch - 1, by + stitch - 1, zoom)[3]
            grid.append((out_col, out_row, bx, by, bx + stitch, by + stitch,
                         (minx_3857, miny_3857, maxx_3857, maxy_3857)))
            out_row += 1
        out_col += 1
    return grid


# ───────── Fetch + stitch ─────────

def fetch_tms_tile(url: str, session: requests.Session, timeout: int = 15) -> Image.Image | None:
    """Fetch a single 256×256 TMS tile. Returns PIL Image or None on failure."""
    try:
        r = session.get(url, timeout=timeout)
        if r.status_code == 404:
            return None  # no coverage at this tile
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception as exc:
        log(f"  WARN fetch failed: {url} → {type(exc).__name__}: {exc}")
        return None


def stitch_and_save(
    tms_url_template: str,
    tms_x_start: int, tms_y_start: int, tms_x_end: int, tms_y_end: int,
    bounds_3857: tuple,
    out_path: Path,
    zoom: int,
    session: requests.Session,
    throttle_s: float,
) -> bool:
    """Fetch a grid of TMS tiles, stitch into one image, reproject to EPSG:3765, save."""
    stitch_x = tms_x_end - tms_x_start
    stitch_y = tms_y_end - tms_y_start
    out_px = stitch_x * TMS_TILE_PX  # e.g. 4×256 = 1024

    canvas = Image.new("RGB", (out_px, out_px), (0, 0, 0))
    fetched = 0
    empty = 0

    for dx in range(stitch_x):
        for dy in range(stitch_y):
            tx = tms_x_start + dx
            # TMS y increases upward, but image paste goes top-down.
            # Top row of the stitched image = highest TMS y.
            ty = tms_y_start + (stitch_y - 1 - dy)
            url = tms_url_template.format(z=zoom, x=tx, y=ty)
            tile_img = fetch_tms_tile(url, session)
            if tile_img is None:
                empty += 1
                continue
            canvas.paste(tile_img, (dx * TMS_TILE_PX, dy * TMS_TILE_PX))
            fetched += 1
            if throttle_s > 0:
                time.sleep(throttle_s)

    if fetched == 0:
        return False  # no coverage at all

    # Convert to numpy array (H, W, 3) → (3, H, W) for rasterio
    arr = np.array(canvas)
    arr = np.transpose(arr, (2, 0, 1))

    # Write as in-memory EPSG:3857 raster, then reproject to EPSG:3765
    src_transform = from_bounds(*bounds_3857, out_px, out_px)

    dst_crs = "EPSG:3765"
    dst_transform, dst_width, dst_height = calculate_default_transform(
        "EPSG:3857", dst_crs, out_px, out_px, *bounds_3857
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path, "w", driver="GTiff",
        height=dst_height, width=dst_width,
        count=3, dtype="uint8",
        crs=dst_crs, transform=dst_transform,
        compress="jpeg", jpeg_quality=90,
    ) as dst:
        for band in range(1, 4):
            reproject(
                source=arr[band - 1],
                destination=rasterio.band(dst, band),
                src_transform=src_transform,
                src_crs="EPSG:3857",
                dst_transform=dst_transform,
                dst_crs=dst_crs,
                resampling=Resampling.bilinear,
            )

    return True


# ───────── Main ─────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--tms-url",
        default=DEFAULT_TMS_URL,
        help=f"TMS URL template (default: {DEFAULT_TMS_URL})",
    )
    parser.add_argument(
        "--source-name",
        default=DEFAULT_SOURCE_NAME,
        help="Name for the output subdirectory under data/tiles/ (default: zagreb-2018)",
    )
    parser.add_argument(
        "--bbox",
        default=DEFAULT_BBOX,
        help="WGS84 bbox 'west,south,east,north' (default: small test area in central Zagreb)",
    )
    parser.add_argument("--zoom", type=int, default=DEFAULT_ZOOM, help=f"TMS zoom level (default: {DEFAULT_ZOOM})")
    parser.add_argument("--stitch", type=int, default=DEFAULT_STITCH,
                        help=f"NxN TMS tiles per output tile (default: {DEFAULT_STITCH} → 1024×1024)")
    parser.add_argument("--throttle-ms", type=int, default=150,
                        help="Sleep between TMS requests in ms (be polite to community servers)")
    parser.add_argument("--max-tiles", type=int, default=None,
                        help="Stop after this many output tiles (for testing)")
    parser.add_argument("--out-dir", default="../data/tiles",
                        help="Parent output directory (a per-source subdir is created)")
    args = parser.parse_args()

    bbox_wgs84 = tuple(float(x) for x in args.bbox.split(","))
    if len(bbox_wgs84) != 4:
        print("ERROR: --bbox must be 'west,south,east,north'", file=sys.stderr)
        return 2

    out_root = (Path(__file__).parent / args.out_dir / args.source_name).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    grid = compute_output_grid(bbox_wgs84, args.zoom, args.stitch)
    tms_per_output = args.stitch ** 2
    total_tms = len(grid) * tms_per_output

    tile_size_m = EARTH_CIRCUMFERENCE * math.cos(math.radians((bbox_wgs84[1] + bbox_wgs84[3]) / 2)) / (2 ** args.zoom)
    gsd = tile_size_m / TMS_TILE_PX
    output_tile_m = tile_size_m * args.stitch

    log(f"Source: {args.tms_url}")
    log(f"Zoom: {args.zoom}, GSD: {gsd:.3f} m/px, output tile: {output_tile_m:.1f} m × {output_tile_m:.1f} m")
    log(f"Grid: {len(grid)} output tiles ({args.stitch}×{args.stitch} = {tms_per_output} TMS tiles each)")
    log(f"Total TMS fetches: {total_tms} (ETA ~{total_tms * args.throttle_ms / 1000 / 60:.1f} min at {args.throttle_ms} ms throttle)")
    log(f"Output: {out_root}")

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    fetched = skipped = failed = 0
    t_start = time.time()
    for i, (out_col, out_row, tx0, ty0, tx1, ty1, bounds) in enumerate(grid, 1):
        if args.max_tiles is not None and fetched >= args.max_tiles:
            log(f"Reached --max-tiles={args.max_tiles}, stopping")
            break
        out_path = out_root / f"tile_{out_col}_{out_row}.tif"
        if out_path.exists() and out_path.stat().st_size > 0:
            skipped += 1
            continue

        elapsed = time.time() - t_start
        eta = (elapsed / max(fetched, 1)) * (len(grid) - i) if fetched > 0 else 0
        log(f"  [{i}/{len(grid)}] tile_{out_col}_{out_row} "
            f"(TMS {tx0}-{tx1},{ty0}-{ty1}) (eta {eta:.0f}s)")

        ok = stitch_and_save(
            args.tms_url, tx0, ty0, tx1, ty1, bounds,
            out_path, args.zoom, session, args.throttle_ms / 1000.0,
        )
        if ok:
            fetched += 1
        else:
            failed += 1

    log(f"Done. fetched={fetched}, skipped={skipped} (cached), failed={failed}")
    log(f"Total time: {time.time() - t_start:.1f}s")
    log(f"Output dir: {out_root}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
