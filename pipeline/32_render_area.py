#!/usr/bin/env python3
"""Phase 5 driver: render LLM-cartographer composites covering a whole named
administrative area (gradska četvrt / naselje / mjesni odbor) instead of one
hand-picked center tile. Fetches the area boundary from the borders API,
computes the grid of composite center-tiles whose windows intersect the
boundary, and shells out to 30_render_composite.py for each. Composites can
then be processed with 31_llm_propose.py (use --composites-dir or --all).

Usage:
  python 32_render_area.py --area "Donji grad"                 # gradske četvrti (level 1)
  python 32_render_area.py --area "Trešnjevka - sjever" --level 1
  python 32_render_area.py --area "Donji grad" --dry-run       # list centers, render nothing
  python 32_render_area.py --bbox 15.96,45.80,15.99,45.82      # raw WGS84 bbox instead of a name
"""

import argparse
import json
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

DEFAULT_BORDERS_API = "https://zagreb.lol/parkiralista/api/borders"

# Composite windows follow the convention of the existing corpus: --grid 4
# (768 m windows) with centers every 3 tile-steps → ~40% overlap between
# neighboring composites so features cut at one edge are whole in the next.
DEFAULT_GRID = 4
DEFAULT_STEP = 3


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def fetch_boundary(api_base: str, city: str, level: int, area_name: str) -> dict:
    """Fetch the named area's boundary polygon (GeoJSON geometry, WGS84) from
    the borders API. Name match is case-insensitive."""
    url = f"{api_base}?city={urllib.request.quote(city)}&level={level}"
    log(f"Fetching borders: {url}")
    # Cloudflare blocks the default urllib UA — send a browser-ish one.
    req = urllib.request.Request(url, headers={"User-Agent": "zagreb-parkiralista-pipeline/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        fc = json.load(resp)
    names = []
    for feat in fc.get("features", []):
        name = (feat.get("properties") or {}).get("name", "")
        names.append(name)
        if name.strip().lower() == area_name.strip().lower():
            log(f"Matched area: {name}")
            return feat["geometry"]
    raise SystemExit(
        f"area {area_name!r} not found at level {level}. Available: {', '.join(sorted(names))}"
    )


def bbox_geometry(bbox_wgs84: tuple[float, float, float, float]) -> dict:
    w, s, e, n = bbox_wgs84
    return {
        "type": "Polygon",
        "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    }


def tile_size_from_sample(tile_dir: Path) -> float:
    """Read one tile's bounds to learn the grid pitch (EPSG:3765 meters)."""
    import rasterio

    sample = next(tile_dir.glob("tile_*.tif"), None)
    if sample is None:
        raise SystemExit(f"no tiles in {tile_dir} — run 01_fetch_tiles.py first")
    with rasterio.open(sample) as src:
        x0, y0, x1, y1 = src.bounds
    return x1 - x0


def compute_centers(geom_wgs84: dict, tile_dir: Path, grid: int, step: int) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """All (col, row) composite centers whose grid-window intersects the area.
    Returns (centers_with_tile_on_disk, centers_missing_their_center_tile)."""
    from pyproj import Transformer
    from shapely.geometry import box, shape
    from shapely.ops import transform as shp_transform

    to_3765 = Transformer.from_crs("EPSG:4326", "EPSG:3765", always_xy=True).transform
    area_3765 = shp_transform(to_3765, shape(geom_wgs84))

    tile_m = tile_size_from_sample(tile_dir)
    # grid N renders a (N+1)-tile window: center tile ± N//2 on each side
    half_m = (grid // 2 + 0.5) * tile_m

    minx, miny, maxx, maxy = area_3765.bounds
    col_lo, col_hi = int(minx // tile_m), int(maxx // tile_m)
    row_lo, row_hi = int(miny // tile_m), int(maxy // tile_m)
    # Snap the start of the walk to the global step grid so re-runs and
    # adjacent areas produce identical, deduplicatable composite ids.
    col_lo -= col_lo % step
    row_lo -= row_lo % step

    have: list[tuple[int, int]] = []
    missing: list[tuple[int, int]] = []
    for col in range(col_lo, col_hi + 1, step):
        for row in range(row_lo, row_hi + 1, step):
            cx = (col + 0.5) * tile_m
            cy = (row + 0.5) * tile_m
            window = box(cx - half_m, cy - half_m, cx + half_m, cy + half_m)
            if not window.intersects(area_3765):
                continue
            if (tile_dir / f"tile_{col}_{row}.tif").exists():
                have.append((col, row))
            else:
                missing.append((col, row))
    return have, missing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--area", help="Area name as in the borders API (e.g. 'Donji grad')")
    parser.add_argument("--level", type=int, default=1, help="Admin level: 1 četvrti / 2 naselja / 3 mjesni odbori (default 1)")
    parser.add_argument("--city", default="Zagreb")
    parser.add_argument("--borders-api", default=DEFAULT_BORDERS_API)
    parser.add_argument("--bbox", help="WGS84 bbox 'west,south,east,north' instead of --area")
    parser.add_argument("--tiles", default="../data/tiles/cdof2022", help="Tile dir (default ../data/tiles/cdof2022)")
    parser.add_argument("--grid", type=int, default=DEFAULT_GRID)
    parser.add_argument("--step", type=int, default=DEFAULT_STEP, help="Center spacing in tiles (default 3)")
    parser.add_argument("--limit", type=int, default=None, help="Render at most N composites")
    parser.add_argument("--skip-existing", action="store_true", help="Skip composites whose PNG already exists")
    parser.add_argument("--dry-run", action="store_true", help="List centers without rendering")
    args = parser.parse_args()

    if not args.area and not args.bbox:
        parser.print_help()
        return 2

    here = Path(__file__).parent
    tile_dir = (here / args.tiles).resolve()

    if args.bbox:
        w, s, e, n = (float(v) for v in args.bbox.split(","))
        geom = bbox_geometry((w, s, e, n))
        log(f"Using raw bbox {args.bbox}")
    else:
        geom = fetch_boundary(args.borders_api, args.city, args.level, args.area)

    have, missing = compute_centers(geom, tile_dir, args.grid, args.step)
    log(f"Composite centers intersecting area: {len(have) + len(missing)} "
        f"({len(have)} renderable, {len(missing)} missing their center tile)")
    if missing:
        cols = sorted({c for c, _ in missing})
        rows = sorted({r for _, r in missing})
        log(f"  MISSING center tiles, e.g. {missing[:8]} — extend coverage with "
            f"01_fetch_tiles.py (cols {cols[0]}–{cols[-1]}, rows {rows[0]}–{rows[-1]})")

    if args.limit:
        have = have[: args.limit]

    out_dir = (here / "../data/composites/cdof2022").resolve()
    rendered = skipped = failed = 0
    for i, (col, row) in enumerate(have, 1):
        composite_png = out_dir / f"composite_tile_{col}_{row}_g{args.grid}.png"
        if args.skip_existing and composite_png.exists():
            log(f"[{i}/{len(have)}] tile_{col}_{row} — exists, skipping")
            skipped += 1
            continue
        if args.dry_run:
            log(f"[{i}/{len(have)}] would render --center-tile {col},{row} --grid {args.grid}")
            continue
        log(f"[{i}/{len(have)}] rendering composite for center tile_{col}_{row}")
        proc = subprocess.run(
            [sys.executable, str(here / "30_render_composite.py"),
             "--center-tile", f"{col},{row}", "--grid", str(args.grid),
             "--tiles", str(tile_dir)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            log(f"  ERROR: {proc.stderr.strip().splitlines()[-1] if proc.stderr else 'unknown'}")
            failed += 1
        else:
            rendered += 1

    log(f"Done: {rendered} rendered, {skipped} skipped, {failed} failed, "
        f"{len(missing)} unreachable (missing tiles)")
    if not args.dry_run and rendered:
        log(f"Next: .venv/bin/python 31_llm_propose.py --all   (or pass individual PNGs)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
