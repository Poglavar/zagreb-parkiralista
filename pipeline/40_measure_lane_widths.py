#!/usr/bin/env python3
"""Phase B: Measure individual lane widths from aerial imagery.

For each road segment, extracts perpendicular brightness profiles from aerial
tiles, detects lane markings (bright peaks on dark asphalt), and measures the
distance between them. Uses cadastral road-parcel boundaries and OSM lane
counts as constraints to narrow the search space.

Three tiers of output confidence:
  - high: lane markings detected, widths measured directly
  - medium: road edges detected, total width ÷ lane count
  - low: cadastral corridor width ÷ lane count (no visual signal)

This is a standalone analysis — nothing downstream depends on it.

Usage:
  python 40_measure_lane_widths.py --segment-id 529
  python 40_measure_lane_widths.py --bbox 15.96,45.80,15.98,45.82 --limit 20
  python 40_measure_lane_widths.py --bbox 15.96,45.80,15.98,45.82 --debug  # saves profile plots
"""

import argparse
import json
import math
import sys
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from pyproj import Transformer
from scipy import signal
from shapely.geometry import shape, LineString, Point, box
from shapely.ops import transform as shapely_transform


_to_3765 = Transformer.from_crs("EPSG:4326", "EPSG:3765", always_xy=True).transform
_to_4326 = Transformer.from_crs("EPSG:3765", "EPSG:4326", always_xy=True).transform

# Road-related land use types in the DGU cadastral data.
ROAD_LAND_USE_TYPES = {
    "PUT", "ULICA", "CESTA", "NERAZVRSTANA CESTA", "AUTOCESTA",
    "DRŽAVNA CESTA", "NOVA ULICA", "CESTA,PARKIRALIŠTE",
    "ULICA I UREĐENO ZEMLJIŠTE",
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_dotenv(env_path: Path) -> None:
    """Minimal .env parser."""
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


# ───────── OSM context ─────────

def load_osm_highways(geojson_path: Path) -> list[dict]:
    """Load OSM highway features, keeping only those with geometry."""
    with geojson_path.open() as f:
        fc = json.load(f)
    return [f for f in fc.get("features", []) if f.get("geometry")]


def get_osm_lanes(feature: dict) -> int | None:
    """Extract lane count from OSM highway feature."""
    raw = feature["properties"].get("lanes")
    if raw is None:
        return None
    try:
        return int(str(raw).strip().split(";")[0])
    except (ValueError, IndexError):
        return None


# ───────── Cadastral corridor ─────────

def get_road_corridor_width(segment_3765, db_url: str | None) -> float | None:
    """Query the land_use table for road parcels intersecting this segment,
    compute the perpendicular corridor width. Returns metres or None."""
    if not db_url:
        return None
    try:
        import psycopg2
    except ImportError:
        try:
            import pg8000
        except ImportError:
            return None

    try:
        import pg8000
        conn = pg8000.connect(dsn=db_url)
        cur = conn.cursor()
    except Exception:
        try:
            import psycopg2
            conn = psycopg2.connect(db_url)
            cur = conn.cursor()
        except Exception as exc:
            log(f"  DB connection failed: {exc}")
            return None

    try:
        # Find road parcels intersecting the segment, compute max perpendicular width
        # by measuring the distance across the parcel perpendicular to the segment direction
        wkt = segment_3765.wkt
        cur.execute("""
            SELECT ST_Distance(
                ST_ClosestPoint(ST_ExteriorRing(geom_simple), ST_StartPoint(seg)),
                ST_ClosestPoint(ST_ExteriorRing(geom_simple), ST_EndPoint(seg))
            ) as corridor_width
            FROM (
                SELECT (ST_Dump(geom)).geom as geom_simple,
                       ST_GeomFromText(%s, 3765) as seg
                FROM land_use
                WHERE nacina_uporabe_zemljista IN ('ULICA', 'CESTA', 'NERAZVRSTANA CESTA', 'AUTOCESTA', 'DRŽAVNA CESTA')
                  AND ST_Intersects(geom, ST_Buffer(ST_GeomFromText(%s, 3765), 5))
            ) sub
            ORDER BY ST_Area(geom_simple) DESC
            LIMIT 1
        """, (wkt, wkt))
        row = cur.fetchone()
        if row and row[0]:
            return float(row[0])
    except Exception as exc:
        log(f"  cadastral query failed: {exc}")
    finally:
        conn.close()
    return None


# ───────── Aerial profile extraction ─────────

def find_covering_tile(segment_3765, tile_dir: Path) -> Path | None:
    """Find a GeoTIFF tile that covers the segment's centroid."""
    centroid = segment_3765.centroid
    for tile_path in sorted(tile_dir.glob("*.tif")):
        try:
            with rasterio.open(tile_path) as src:
                tile_box = box(*src.bounds)
                if tile_box.contains(centroid):
                    return tile_path
        except Exception:
            continue
    return None


def extract_road_profile(
    segment_3765: LineString,
    tile_path: Path,
    profile_half_width_m: float = 15.0,
    num_samples: int = 20,
) -> tuple[np.ndarray, float, list[dict]] | None:
    """Extract an averaged perpendicular brightness profile across the road.

    Samples `num_samples` cross-sections perpendicular to the road direction,
    averages them, and returns (1D profile array, metres-per-pixel, sample_points).

    Each sample_point records the geographic coordinates at each pixel offset
    along the perpendicular, so detected marking positions can be converted to
    geographic coordinates for lane polyline output.

    Returns None if the tile doesn't cover enough of the segment.
    """
    with rasterio.open(tile_path) as src:
        gsd_x = abs(src.transform.a)
        gsd_y = abs(src.transform.e)
        gsd = (gsd_x + gsd_y) / 2

        profile_half_px = int(profile_half_width_m / gsd)
        profile_width_px = 2 * profile_half_px + 1

        profiles = []
        sample_points = []  # per-sample perpendicular geometry for polyline output
        total_length = segment_3765.length

        for i in range(num_samples):
            frac = (i + 0.5) / num_samples
            pt = segment_3765.interpolate(frac, normalized=True)

            # Compute road direction at this point
            delta = min(2.0, total_length * 0.05)  # 2m or 5% of segment length
            p1 = segment_3765.interpolate(max(0, frac * total_length - delta))
            p2 = segment_3765.interpolate(min(total_length, frac * total_length + delta))
            dx = p2.x - p1.x
            dy = p2.y - p1.y
            road_angle = math.atan2(dy, dx)

            # Perpendicular direction
            perp_angle = road_angle + math.pi / 2
            cos_p = math.cos(perp_angle)
            sin_p = math.sin(perp_angle)

            # Sample pixels along the perpendicular line
            profile = np.zeros(profile_width_px, dtype=np.float64)
            valid = True
            for j in range(profile_width_px):
                offset_m = (j - profile_half_px) * gsd
                sx = pt.x + offset_m * cos_p
                sy = pt.y + offset_m * sin_p

                try:
                    row, col = src.index(sx, sy)
                    if 0 <= row < src.height and 0 <= col < src.width:
                        pixel = src.read(window=((row, row + 1), (col, col + 1)))
                        # Average RGB channels for brightness
                        profile[j] = float(pixel[:3, 0, 0].mean())
                    else:
                        valid = False
                        break
                except Exception:
                    valid = False
                    break

            if valid:
                profiles.append(profile)
                # Store the perpendicular geometry for this sample so we can
                # convert detected pixel positions → geographic coords later
                sample_points.append({
                    "center_x": pt.x,
                    "center_y": pt.y,
                    "cos_perp": cos_p,
                    "sin_perp": sin_p,
                    "profile_half_px": profile_half_px,
                })

        if len(profiles) < num_samples // 2:
            return None

        averaged = np.mean(profiles, axis=0)
        return averaged, gsd, sample_points


def detect_road_edges(profile: np.ndarray, gsd: float) -> tuple[int, int] | None:
    """Detect the left and right edges of the road surface in the averaged profile.

    The road is typically the darkest continuous region (asphalt). Sidewalks and
    grass are lighter. We look for significant brightness transitions.
    """
    # Smooth the profile to reduce noise
    kernel_size = max(3, int(0.5 / gsd))  # ~0.5m smoothing kernel
    if kernel_size % 2 == 0:
        kernel_size += 1
    smoothed = np.convolve(profile, np.ones(kernel_size) / kernel_size, mode="same")

    # Compute the gradient (derivative)
    gradient = np.gradient(smoothed)

    # The road edges are where the gradient has strong negative (left edge: bright→dark)
    # and strong positive (right edge: dark→bright) values
    center = len(profile) // 2
    threshold = np.std(gradient) * 1.0

    # Search for left edge (going left from center, find where gradient goes negative→positive)
    left_edge = None
    for i in range(center, 0, -1):
        if gradient[i] < -threshold:
            left_edge = i
            break

    # Search for right edge (going right from center)
    right_edge = None
    for i in range(center, len(profile)):
        if gradient[i] > threshold:
            right_edge = i
            break

    if left_edge is not None and right_edge is not None and right_edge > left_edge:
        return (left_edge, right_edge)
    return None


def detect_lane_markings(
    profile: np.ndarray,
    gsd: float,
    road_edges: tuple[int, int] | None = None,
) -> list[int]:
    """Detect lane marking positions as bright peaks within the road surface.

    Lane markings are white/yellow lines that appear as local brightness maxima
    against the dark asphalt background.
    """
    if road_edges:
        left, right = road_edges
        road_profile = profile[left:right]
        offset = left
    else:
        # Use the middle 60% of the profile as a rough road estimate
        margin = len(profile) // 5
        road_profile = profile[margin:-margin]
        offset = margin

    if len(road_profile) < 5:
        return []

    # Normalize road profile
    road_min = road_profile.min()
    road_range = road_profile.max() - road_min
    if road_range < 5:  # very uniform → no markings visible
        return []
    normalized = (road_profile - road_min) / road_range

    # Find peaks (bright spots = lane markings)
    # Minimum distance between markings: ~2m (narrowest lane)
    min_distance_px = max(3, int(2.0 / gsd))
    # Minimum prominence: marking should be >20% brighter than surrounding asphalt
    peaks, properties = signal.find_peaks(
        normalized,
        distance=min_distance_px,
        prominence=0.15,
        height=0.3,
    )

    return [int(p + offset) for p in peaks]


# ───────── Measurement ─────────

def measure_lane_widths(
    profile: np.ndarray,
    gsd: float,
    osm_lanes: int | None,
    corridor_width_m: float | None,
) -> dict:
    """Full measurement pipeline: detect edges + markings, compute widths."""
    result = {
        "lane_count": None,
        "lane_widths_m": [],
        "total_carriageway_m": None,
        "corridor_width_m": corridor_width_m,
        "osm_lanes": osm_lanes,
        "confidence": 0.0,
        "method": "none",
        "marking_positions_px": [],
        "road_edges_px": None,
    }

    road_edges = detect_road_edges(profile, gsd)
    if road_edges:
        left, right = road_edges
        total_width = (right - left) * gsd
        result["total_carriageway_m"] = round(total_width, 2)
        result["road_edges_px"] = [left, right]

    marking_positions = detect_lane_markings(profile, gsd, road_edges)
    result["marking_positions_px"] = marking_positions

    if len(marking_positions) >= 1 and road_edges:
        # We have markings + edges → compute per-lane widths
        left, right = road_edges
        boundaries = [left] + marking_positions + [right]
        widths = []
        for i in range(len(boundaries) - 1):
            w = (boundaries[i + 1] - boundaries[i]) * gsd
            if w > 0.5:  # minimum plausible lane width
                widths.append(round(w, 2))
        if widths:
            result["lane_count"] = len(widths)
            result["lane_widths_m"] = widths
            result["confidence"] = 0.8
            result["method"] = "marking_detection"
            return result

    if road_edges and osm_lanes:
        # Road edges detected but no markings → divide by lane count
        total = result["total_carriageway_m"]
        per_lane = round(total / osm_lanes, 2)
        result["lane_count"] = osm_lanes
        result["lane_widths_m"] = [per_lane] * osm_lanes
        result["confidence"] = 0.5
        result["method"] = "edge_divided_by_osm_lanes"
        return result

    if corridor_width_m and osm_lanes:
        # Last resort: cadastral corridor ÷ lane count
        # Subtract typical sidewalk widths (~2m each side)
        carriageway = max(corridor_width_m - 4.0, corridor_width_m * 0.6)
        per_lane = round(carriageway / osm_lanes, 2)
        result["total_carriageway_m"] = round(carriageway, 2)
        result["lane_count"] = osm_lanes
        result["lane_widths_m"] = [per_lane] * osm_lanes
        result["confidence"] = 0.2
        result["method"] = "cadastral_corridor_estimate"
        return result

    result["method"] = "insufficient_data"
    return result


def build_lane_polylines(
    sample_points: list[dict],
    marking_positions_px: list[int],
    road_edges_px: list[int] | None,
    gsd: float,
) -> list[list[list[float]]]:
    """Build WGS84 polylines for each lane boundary (edges + markings).

    Each polyline is a list of [lon, lat] coords tracing the boundary along the
    segment. Returns one polyline per boundary (left edge, markings..., right edge).
    """
    if not sample_points or not road_edges_px:
        return []

    all_boundaries = [road_edges_px[0]] + marking_positions_px + [road_edges_px[1]]
    polylines = []

    for boundary_px in all_boundaries:
        coords = []
        for sp in sample_points:
            offset_m = (boundary_px - sp["profile_half_px"]) * gsd
            bx = sp["center_x"] + offset_m * sp["cos_perp"]
            by = sp["center_y"] + offset_m * sp["sin_perp"]
            lon, lat = _to_4326(bx, by)
            coords.append([round(lon, 7), round(lat, 7)])
        if len(coords) >= 2:
            polylines.append(coords)

    return polylines


# ───────── Debug visualization ─────────

def save_debug_plot(
    profile: np.ndarray,
    gsd: float,
    measurement: dict,
    output_path: Path,
    title: str = "",
) -> None:
    """Save a plot of the road profile with detected edges and markings."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        log("  matplotlib not installed, skipping debug plot")
        return

    x_m = np.arange(len(profile)) * gsd
    fig, ax = plt.subplots(figsize=(12, 4))
    ax.plot(x_m, profile, "k-", linewidth=0.8, label="brightness")
    ax.set_xlabel("distance (m)")
    ax.set_ylabel("brightness")
    ax.set_title(title or "Road cross-section profile")

    # Draw road edges
    edges = measurement.get("road_edges_px")
    if edges:
        for e in edges:
            ax.axvline(e * gsd, color="blue", linestyle="--", alpha=0.7, label="road edge")

    # Draw marking positions
    for m in measurement.get("marking_positions_px", []):
        ax.axvline(m * gsd, color="red", linestyle="-", alpha=0.8, label="marking")

    # Annotate lane widths
    widths = measurement.get("lane_widths_m", [])
    if widths and edges:
        boundaries = [edges[0]] + measurement.get("marking_positions_px", []) + [edges[1]]
        for i in range(min(len(widths), len(boundaries) - 1)):
            cx = (boundaries[i] + boundaries[i + 1]) / 2 * gsd
            ax.text(cx, profile.max() * 0.9, f"{widths[i]}m", ha="center", fontsize=9, color="green", fontweight="bold")

    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150)
    plt.close(fig)


# ───────── Main ─────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tiles", default="../data/tiles/cdof2022", help="Aerial tile directory")
    parser.add_argument("--highways", default="../data/osm/highways_zagreb.geojson", help="OSM highways GeoJSON")
    parser.add_argument("--bbox", help="WGS84 bbox 'west,south,east,north'")
    parser.add_argument("--segment-id", help="Specific OSM highway feature ID to process")
    parser.add_argument("--limit", type=int, default=None, help="Max segments to process")
    parser.add_argument("--out", default="../data/analysis/lane-widths.json", help="Output JSON path")
    parser.add_argument("--debug", action="store_true", help="Save profile plots to data/analysis/debug/")
    parser.add_argument("--profile-width", type=float, default=15.0, help="Half-width of profile extraction in metres")
    parser.add_argument("--num-samples", type=int, default=20, help="Number of cross-sections to average per segment")
    args = parser.parse_args()

    here = Path(__file__).parent
    tile_dir = (here / args.tiles).resolve()
    highways_path = (here / args.highways).resolve()
    out_path = (here / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not tile_dir.is_dir():
        print(f"ERROR: tile dir not found: {tile_dir}", file=sys.stderr)
        return 2

    # Load .env for database access (cadastral data)
    load_dotenv(here.parent / ".env")
    load_dotenv(Path.home() / "Code" / "cadastre-data" / ".env")
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        log(f"Database: connected (cadastral corridor queries enabled)")
    else:
        log(f"Database: not available (no DATABASE_URL, cadastral queries disabled)")

    log(f"Loading OSM highways from {highways_path}")
    highways = load_osm_highways(highways_path)
    log(f"  {len(highways)} features loaded")

    # Filter to bbox if specified
    if args.bbox:
        west, south, east, north = (float(x) for x in args.bbox.split(","))
        xs, ys = [], []
        for lon, lat in [(west, south), (east, south), (east, north), (west, north)]:
            x, y = _to_3765(lon, lat)
            xs.append(x)
            ys.append(y)
        bbox_3765 = box(min(xs), min(ys), max(xs), max(ys))
        highways = [
            f for f in highways
            if shapely_transform(_to_3765, shape(f["geometry"])).intersects(bbox_3765)
        ]
        log(f"  {len(highways)} in bbox")

    if args.segment_id:
        highways = [f for f in highways if str(f.get("id", "")).endswith(args.segment_id) or f["properties"].get("osm_id") == int(args.segment_id)]
        log(f"  {len(highways)} matching segment-id {args.segment_id}")

    # Filter to drivable roads (skip footways, cycleways, paths)
    drivable = {"motorway", "trunk", "primary", "secondary", "tertiary",
                "residential", "unclassified", "living_street", "service"}
    highways = [f for f in highways if f["properties"].get("highway") in drivable]
    log(f"  {len(highways)} drivable roads")

    if args.limit:
        highways = highways[:args.limit]

    results = []
    processed = skipped = 0

    for i, feature in enumerate(highways, 1):
        if i % 50 == 0:
            log(f"  [{i}/{len(highways)}]")

        props = feature["properties"]
        osm_id = props.get("osm_id", feature.get("id", i))
        highway_type = props.get("highway", "?")
        osm_lanes = get_osm_lanes(feature)
        name = props.get("name") or props.get("ref") or ""

        # Project to EPSG:3765
        segment_4326 = shape(feature["geometry"])
        segment_3765 = shapely_transform(_to_3765, segment_4326)

        if segment_3765.length < 10:
            skipped += 1
            continue

        # Find aerial tile
        tile_path = find_covering_tile(segment_3765, tile_dir)
        if not tile_path:
            skipped += 1
            continue

        # Extract road profile
        profile_result = extract_road_profile(
            segment_3765, tile_path,
            profile_half_width_m=args.profile_width,
            num_samples=args.num_samples,
        )
        if profile_result is None:
            skipped += 1
            continue

        profile, gsd, sample_points = profile_result

        # Cadastral corridor width (optional)
        corridor_width = get_road_corridor_width(segment_3765, db_url)

        # Measure lane widths
        measurement = measure_lane_widths(profile, gsd, osm_lanes, corridor_width)

        # Save debug plot if requested
        if args.debug:
            debug_dir = out_path.parent / "debug"
            title = f"osm_id={osm_id} ({highway_type}) '{name}' lanes={osm_lanes}"
            save_debug_plot(profile, gsd, measurement, debug_dir / f"profile_{osm_id}.png", title)

        # Convert centroid to WGS84 for the output
        centroid = segment_3765.centroid
        lon, lat = _to_4326(centroid.x, centroid.y)

        # Build lane boundary polylines (WGS84)
        lane_polylines = build_lane_polylines(
            sample_points,
            measurement.get("marking_positions_px", []),
            measurement.get("road_edges_px"),
            gsd,
        )

        results.append({
            "osm_id": osm_id,
            "name": name,
            "highway": highway_type,
            "osm_lanes": osm_lanes,
            "centroid": [round(lon, 6), round(lat, 6)],
            "segment_length_m": round(segment_3765.length, 1),
            "measurement": measurement,
            "lane_boundary_polylines": lane_polylines,
        })
        processed += 1

    log(f"Done. processed={processed}, skipped={skipped}")

    # Aggregate stats
    by_method = {}
    for r in results:
        m = r["measurement"]["method"]
        by_method[m] = by_method.get(m, 0) + 1

    output = {
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "tile_dir": str(tile_dir),
        "segment_count": len(results),
        "by_method": by_method,
        "results": results,
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=1)
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    log(f"By method: {by_method}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
