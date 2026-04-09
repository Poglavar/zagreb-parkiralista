#!/usr/bin/env python3
"""Convert GeoTIFF orthophoto tiles into browser-friendly JPEG previews so the
viewer can show the source image when a user clicks an informal-parking
detection in the popup.

The output JPEGs are NOT georeferenced — they're just visual previews keyed by
the same tile_<col>_<row> filename stem. The pixel grid matches the original
tile, so the viewer can compute an overlay rectangle from the bbox_px_* fields
in vehicles.geojson and draw it on top of the JPEG.

Resumable: skips JPEGs that already exist with non-zero size.

Usage:
  python 12_export_tile_jpegs.py
  python 12_export_tile_jpegs.py --tiles ../data/tiles/cdof2022 --quality 85
  python 12_export_tile_jpegs.py --max-size 512   # downscale for smaller files
"""

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def convert_tile(tif_path: Path, jpg_path: Path, quality: int, max_size: int | None) -> bool:
    """Read RGB(A) from a GeoTIFF and write a JPEG. Returns True on success."""
    try:
        with rasterio.open(tif_path) as src:
            n = src.count
            bands = [1, 2, 3] if n >= 3 else [1, 1, 1]
            arr = src.read(bands)
            arr = np.transpose(arr, (1, 2, 0))  # CHW -> HWC
            if arr.dtype != np.uint8:
                arr = arr.astype(np.uint8)
        img = Image.fromarray(arr, mode="RGB")
        if max_size is not None and (img.width > max_size or img.height > max_size):
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        jpg_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(jpg_path, format="JPEG", quality=quality, optimize=True, progressive=True)
        return True
    except Exception as exc:
        log(f"  ERROR converting {tif_path.name}: {type(exc).__name__}: {exc}")
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--tiles",
        default="../data/tiles/cdof2022",
        help="Input dir of GeoTIFF tiles (default: ../data/tiles/cdof2022)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output dir for JPEGs (default: ../data/tiles_jpg/<input dir name>/)",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=80,
        help="JPEG quality 1–100 (default: 80)",
    )
    parser.add_argument(
        "--max-size",
        type=int,
        default=None,
        help="If set, downscale so neither dimension exceeds this many pixels (default: keep native 1024)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Stop after this many conversions (handy for smoke tests)",
    )
    args = parser.parse_args()

    tile_dir = Path(args.tiles)
    if not tile_dir.is_absolute():
        tile_dir = (Path(__file__).parent / tile_dir).resolve()
    if not tile_dir.is_dir():
        print(f"ERROR: input dir does not exist: {tile_dir}", file=sys.stderr)
        return 2

    out_dir = Path(args.out).resolve() if args.out else (
        Path(__file__).parent / "../data/tiles_jpg" / tile_dir.name
    ).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    tile_paths = sorted(tile_dir.glob("*.tif"))
    if not tile_paths:
        log(f"No .tif files in {tile_dir}; did you run 01_fetch_tiles.py?")
        return 1
    log(f"Found {len(tile_paths)} tiles in {tile_dir}")
    log(f"Output dir: {out_dir}")
    log(f"Quality: {args.quality}, max-size: {args.max_size or 'native'}")

    converted = skipped = failed = 0
    total_in = total_out = 0
    t_start = time.time()
    for i, tif_path in enumerate(tile_paths, 1):
        if args.limit is not None and converted >= args.limit:
            log(f"Reached --limit={args.limit}, stopping")
            break
        jpg_path = out_dir / f"{tif_path.stem}.jpg"
        if jpg_path.exists() and jpg_path.stat().st_size > 0:
            skipped += 1
            continue
        if i % 50 == 0 or i == 1:
            log(f"  [{i}/{len(tile_paths)}] {tif_path.name}")
        if convert_tile(tif_path, jpg_path, args.quality, args.max_size):
            converted += 1
            total_in += tif_path.stat().st_size
            total_out += jpg_path.stat().st_size
        else:
            failed += 1

    elapsed = time.time() - t_start
    log(f"Done. converted={converted}, skipped={skipped} (cached), failed={failed}")
    if converted > 0:
        compression = total_in / max(total_out, 1)
        log(f"Compression: {total_in / 1024 / 1024:.1f} MB (TIFF) -> "
            f"{total_out / 1024 / 1024:.1f} MB (JPEG), ratio {compression:.1f}×")
    log(f"Total time: {elapsed:.1f}s")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
