#!/usr/bin/env python3
"""Phase 1 step 1: Download a grid of WMS GeoTIFF tiles covering a bounding box,
saving each tile as a georeferenced .tif under data/tiles/<source>/.

Default source is the City of Zagreb CDOF 2022 orthophoto (~0.10–0.15 m GSD,
layer ZG_CDOF2022, native EPSG:3765). The DGU DOF5 2023/24 endpoint is wired up
as a fallback. Both expose `image/geotiff` from their WMS so we don't have to
assemble georeferencing manually.

Resumable: tiles that already exist on disk are skipped, so re-running after
an interruption picks up where it left off.

Usage:
  python 01_fetch_tiles.py                     # default test bbox in central Zagreb
  python 01_fetch_tiles.py --bbox 15.96,45.79,15.99,45.81 --source cdof2022
  python 01_fetch_tiles.py --bbox-3765 444000,5071000,447000,5074000 --source cdof2022 --gsd 0.15
"""

import argparse
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

import requests
from pyproj import Transformer

# Default test bbox — small ~1 km² area in central Zagreb (Glavni kolodvor / Vinogradska),
# chosen to be cheap to run end-to-end the first time.
DEFAULT_BBOX_WGS84 = (15.965, 45.798, 15.985, 45.812)  # west, south, east, north

USER_AGENT = "zagreb-parkiralista/0.1 (City of Zagreb / GitHub: simun)"


@dataclass(frozen=True)
class WmsSource:
    """A WMS endpoint configured for a specific orthophoto product."""
    key: str
    url: str
    layer: str
    native_gsd_m: float        # native ground sample distance in metres
    label: str

SOURCES: dict[str, WmsSource] = {
    "cdof2022": WmsSource(
        key="cdof2022",
        url="https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer",
        layer="ZG_CDOF2022",
        native_gsd_m=0.15,
        label="City of Zagreb CDOF 2022",
    ),
    "dof5": WmsSource(
        key="dof5",
        url="https://geoportal.dgu.hr/services/inspire/orthophoto_2023_2024/wms",
        layer="OI.OrthoimageCoverage",  # standard INSPIRE Orthoimagery layer name; verify with GetCapabilities if it changes
        native_gsd_m=0.50,
        label="DGU DOF5 2023/24",
    ),
}

# WGS84 -> HTRS96/TM, the native projected CRS for everything Croatian.
_to_3765 = Transformer.from_crs("EPSG:4326", "EPSG:3765", always_xy=True).transform


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def project_bbox_to_3765(bbox_wgs84: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Reproject a (west, south, east, north) bbox from WGS84 to EPSG:3765,
    returning (minx, miny, maxx, maxy) in metres."""
    w, s, e, n = bbox_wgs84
    # Project all four corners and take the axis-aligned envelope. Conservative
    # but correct for small bboxes; meaningful distortion only at country scale.
    xs, ys = [], []
    for lon, lat in [(w, s), (e, s), (e, n), (w, n)]:
        x, y = _to_3765(lon, lat)
        xs.append(x)
        ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys))


def snap_to_grid(value: float, step: float) -> float:
    """Snap a coordinate down to the nearest multiple of `step` for tile alignment."""
    return (value // step) * step


def build_tile_grid(
    bbox_3765: tuple[float, float, float, float],
    tile_px: int,
    gsd_m: float,
) -> list[tuple[int, int, tuple[float, float, float, float]]]:
    """Generate (col, row, tile_bbox_3765) for a regular grid covering the bbox.
    Tiles are aligned to a global grid in EPSG:3765 so that two runs over
    overlapping bboxes produce the same tile filenames (re-use cache)."""
    tile_size_m = tile_px * gsd_m
    minx, miny, maxx, maxy = bbox_3765
    # Snap to a global multiple of tile_size_m so tiles are reproducible.
    start_x = snap_to_grid(minx, tile_size_m)
    start_y = snap_to_grid(miny, tile_size_m)

    tiles = []
    x = start_x
    col = int(start_x / tile_size_m)
    while x < maxx:
        y = start_y
        row = int(start_y / tile_size_m)
        while y < maxy:
            tiles.append((col, row, (x, y, x + tile_size_m, y + tile_size_m)))
            y += tile_size_m
            row += 1
        x += tile_size_m
        col += 1
    return tiles


def fetch_tile(
    source: WmsSource,
    bbox_3765: tuple[float, float, float, float],
    tile_px: int,
    out_path: Path,
    timeout: int = 60,
) -> bool:
    """Fetch a single GeoTIFF from the WMS server and save to disk.
    Returns True on success, False on failure (logged but not raised)."""
    minx, miny, maxx, maxy = bbox_3765
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": source.layer,
        "STYLES": "",
        # WMS 1.3.0 axis order for projected CRSs (per the EPSG definition for 3765):
        # X (Easting) first, then Y (Northing). The official GetCapabilities BBOX
        # for ZG_CDOF2022 uses minx,miny,maxx,maxy in EPSG:3765, so this is correct.
        "CRS": "EPSG:3765",
        "BBOX": f"{minx},{miny},{maxx},{maxy}",
        "WIDTH": str(tile_px),
        "HEIGHT": str(tile_px),
        "FORMAT": "image/geotiff",
    }
    url = f"{source.url}?{urlencode(params)}"

    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
    except requests.RequestException as exc:
        log(f"  ERROR network: {exc}")
        return False

    if r.status_code != 200:
        log(f"  ERROR HTTP {r.status_code}: {r.text[:200]}")
        return False
    # WMS error responses are XML even on HTTP 200; sniff for that.
    if r.headers.get("content-type", "").startswith("text/xml") or r.content.startswith(b"<?xml"):
        log(f"  ERROR WMS exception: {r.text[:300]}")
        return False
    if not r.content:
        log("  ERROR empty response")
        return False

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(r.content)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--source",
        choices=list(SOURCES.keys()),
        default="cdof2022",
        help=f"WMS source (default: cdof2022). Options: {', '.join(SOURCES)}",
    )
    parser.add_argument(
        "--bbox",
        default=",".join(str(x) for x in DEFAULT_BBOX_WGS84),
        help="WGS84 bbox 'west,south,east,north' (default: small central Zagreb test area)",
    )
    parser.add_argument(
        "--bbox-3765",
        help="EPSG:3765 bbox 'minx,miny,maxx,maxy' in metres (overrides --bbox)",
    )
    parser.add_argument(
        "--gsd",
        type=float,
        default=None,
        help="Ground sample distance in metres per pixel (default: source native)",
    )
    parser.add_argument(
        "--tile-px",
        type=int,
        default=1024,
        help="Tile dimension in pixels (default: 1024). Tile covers tile_px*gsd metres.",
    )
    parser.add_argument(
        "--out-dir",
        default="../data/tiles",
        help="Output directory for tile GeoTIFFs (a per-source subdir is created)",
    )
    parser.add_argument(
        "--max-tiles",
        type=int,
        default=None,
        help="Stop after fetching this many tiles (handy for sanity-checks)",
    )
    parser.add_argument(
        "--throttle-ms",
        type=int,
        default=200,
        help="Sleep between requests in milliseconds, to be polite to the server",
    )
    args = parser.parse_args()

    source = SOURCES[args.source]
    gsd = args.gsd if args.gsd is not None else source.native_gsd_m

    if args.bbox_3765:
        parts = [float(x) for x in args.bbox_3765.split(",")]
        if len(parts) != 4:
            print("ERROR: --bbox-3765 must be 'minx,miny,maxx,maxy'", file=sys.stderr)
            return 2
        bbox_3765 = tuple(parts)  # type: ignore[assignment]
        log(f"Using EPSG:3765 bbox {bbox_3765}")
    else:
        bbox_wgs84 = tuple(float(x) for x in args.bbox.split(","))
        if len(bbox_wgs84) != 4:
            print("ERROR: --bbox must be 'west,south,east,north'", file=sys.stderr)
            return 2
        bbox_3765 = project_bbox_to_3765(bbox_wgs84)  # type: ignore[arg-type]
        log(f"Projected WGS84 bbox {bbox_wgs84} -> EPSG:3765 {tuple(round(x, 1) for x in bbox_3765)}")

    log(f"Source: {source.label} ({source.url})")
    log(f"Layer: {source.layer}, GSD: {gsd} m/px, tile: {args.tile_px}×{args.tile_px} px = {args.tile_px * gsd:.1f} m")

    tiles = build_tile_grid(bbox_3765, args.tile_px, gsd)  # type: ignore[arg-type]
    log(f"Grid: {len(tiles)} tiles total")

    out_root = (Path(__file__).parent / args.out_dir / source.key).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    fetched = skipped = failed = 0
    for i, (col, row, tile_bbox) in enumerate(tiles, 1):
        if args.max_tiles is not None and fetched >= args.max_tiles:
            log(f"Reached --max-tiles={args.max_tiles}, stopping")
            break
        out_path = out_root / f"tile_{col}_{row}.tif"
        if out_path.exists() and out_path.stat().st_size > 0:
            skipped += 1
            continue
        log(f"  [{i}/{len(tiles)}] tile {col},{row} bbox=({tile_bbox[0]:.0f},{tile_bbox[1]:.0f}) -> {out_path.name}")
        if fetch_tile(source, tile_bbox, args.tile_px, out_path):
            fetched += 1
        else:
            failed += 1
        time.sleep(args.throttle_ms / 1000.0)

    log(f"Done. fetched={fetched}, skipped={skipped} (cached), failed={failed}")
    log(f"Output dir: {out_root}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
