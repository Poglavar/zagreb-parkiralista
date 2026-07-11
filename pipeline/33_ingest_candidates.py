#!/usr/bin/env python3
"""Phase 5 step 3: Ingest LLM-proposed parking candidates (from
31_llm_propose.py) into the shared PostGIS table parking.aerial_candidate for
the human review workflow.

The input is the GeoJSON FeatureCollection written by 31_llm_propose.py: each
feature has a stable string `id` (e.g. "composite_tile_2980_33035_g4/anthropic/0"),
a WGS84 Polygon geometry, and properties (kind, confidence, reason,
source_composite, provider, model, engine). Rows land as review_status='pending'
and a human later confirms or rejects them in the review UI.

Versioning mirrors parking.area: the logical key is the candidate `id`. On
re-ingest we compute a geom_hash (md5 of the canonical GeoJSON geometry) and
compare it — plus kind/confidence/reason — against the current row:
  - no row for this id            → INSERT version 1
  - current row, content matches  → skip (unchanged)
  - current row, review_status != 'pending' → PROTECTED, never clobbered
  - current row is pending, changed → old row current=false, INSERT next version

DRY-RUN BY DEFAULT: running with no args (or --help) prints what it would do and
touches nothing. Pass --write to actually commit.

DATABASE_URL is read from the project root .env first
(/Users/simun/Code/zagreb-parkiralista/.env), then from
/Users/simun/Code/cadastre-data/api/.env as a fallback.

Setup:
  .venv/bin/pip install "psycopg[binary]"

Usage:
  python 33_ingest_candidates.py                       # dry-run, default candidates file
  python 33_ingest_candidates.py --candidates path.geojson
  python 33_ingest_candidates.py --write               # actually commit
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import psycopg

DEFAULT_CANDIDATES = "../data/candidates/llm_parking_candidates.geojson"
ROOT_ENV = Path("/Users/simun/Code/zagreb-parkiralista/.env")
FALLBACK_ENV = Path("/Users/simun/Code/cadastre-data/api/.env")


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_dotenv_minimal(env_path: Path) -> None:
    """Tiny .env parser. Same logic as 31_llm_propose.py — setdefault so an
    already-set env var (or an earlier-loaded .env) always wins."""
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def resolve_database_url() -> str | None:
    """Root project .env takes priority; cadastre-data api .env is the fallback.
    setdefault means the root value (loaded first) is never overridden."""
    load_dotenv_minimal(ROOT_ENV)
    load_dotenv_minimal(FALLBACK_ENV)
    return os.environ.get("DATABASE_URL")


def geom_hash(geometry: dict) -> str:
    """md5 of the canonical GeoJSON geometry string (sorted keys, no spaces) so
    the same polygon always hashes identically regardless of key ordering."""
    canonical = json.dumps(geometry, sort_keys=True, separators=(",", ":"))
    return hashlib.md5(canonical.encode("utf-8")).hexdigest()


def load_candidates(path: Path) -> list[dict]:
    """Read the FeatureCollection and return its features, validating basics."""
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    features = data.get("features") or []
    if not features:
        raise SystemExit(f"No features in {path}")
    return features


def feature_to_record(feature: dict) -> dict:
    """Flatten a GeoJSON feature into the columns of parking.aerial_candidate."""
    props = feature.get("properties") or {}
    geometry = feature.get("geometry")
    fid = feature.get("id")
    if not fid:
        raise ValueError(f"feature missing id: {json.dumps(feature)[:200]}")
    if not geometry or geometry.get("type") != "Polygon":
        raise ValueError(f"feature {fid} has no Polygon geometry")
    return {
        "id": str(fid),
        "kind": props.get("kind", "unknown"),
        "confidence": props.get("confidence", "low"),
        "reason": props.get("reason"),
        "source_composite": props.get("source_composite"),
        "provider": props.get("provider"),
        "model": props.get("model"),
        "engine": props.get("engine"),
        # Image-space bbox (fractions 0..1 of the composite) — the viewer popup
        # uses it to render the cropped composite preview. Coerced to float:
        # psycopg refuses mixed int/float lists (e.g. [0, 0.5, 0.3, 0.6]).
        "bbox_pct": [float(v) for v in props["bbox_pct"]] if props.get("bbox_pct") else None,
        "geom_json": json.dumps(geometry, separators=(",", ":")),
        "geom_hash": geom_hash(geometry),
    }


def table_exists(conn) -> bool:
    """True if parking.aerial_candidate exists (DDL applied). Lets dry-run run
    against a DB where the table isn't created yet without exploding."""
    cur = conn.cursor()
    cur.execute("SELECT to_regclass('parking.aerial_candidate')")
    return cur.fetchone()[0] is not None


def ingest(conn, records: list[dict], write: bool) -> dict:
    """Apply version-aware upsert logic per candidate. Returns count summary."""
    counts = {"inserted": 0, "updated": 0, "skipped": 0, "protected": 0}
    cur = conn.cursor()

    for rec in records:
        cur.execute(
            """
            SELECT version, geom_hash, kind, confidence, reason, review_status
            FROM parking.aerial_candidate
            WHERE id = %s AND current = true
            """,
            (rec["id"],),
        )
        row = cur.fetchone()

        if row is None:
            # No prior row → fresh candidate, version 1.
            if write:
                cur.execute(
                    """
                    INSERT INTO parking.aerial_candidate
                        (id, version, current, kind, confidence, reason,
                         source_composite, provider, model, engine, bbox_pct,
                         geom, geom_hash, review_status, updated_by)
                    VALUES (%s, 1, true, %s, %s, %s, %s, %s, %s, %s, %s,
                            ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s,
                            'pending', %s)
                    """,
                    (
                        rec["id"], rec["kind"], rec["confidence"], rec["reason"],
                        rec["source_composite"], rec["provider"], rec["model"], rec["engine"],
                        rec["bbox_pct"],
                        rec["geom_json"], rec["geom_hash"],
                        "ingest-33",
                    ),
                )
            counts["inserted"] += 1
            continue

        cur_version, cur_hash, cur_kind, cur_conf, cur_reason, cur_status = row

        unchanged = (
            cur_hash == rec["geom_hash"]
            and cur_kind == rec["kind"]
            and cur_conf == rec["confidence"]
            and (cur_reason or None) == (rec["reason"] or None)
        )

        if unchanged:
            counts["skipped"] += 1
            continue

        # Content changed. Never clobber a human decision.
        if cur_status != "pending":
            counts["protected"] += 1
            continue

        # Pending + changed → supersede with a new version.
        if write:
            cur.execute(
                """
                UPDATE parking.aerial_candidate
                SET current = false, updated_at = now()
                WHERE id = %s AND current = true
                """,
                (rec["id"],),
            )
            cur.execute(
                """
                SELECT COALESCE(MAX(version), 0) + 1
                FROM parking.aerial_candidate WHERE id = %s
                """,
                (rec["id"],),
            )
            next_version = cur.fetchone()[0]
            cur.execute(
                """
                INSERT INTO parking.aerial_candidate
                    (id, version, current, kind, confidence, reason,
                     source_composite, provider, model, engine, bbox_pct,
                     geom, geom_hash, review_status, updated_by)
                VALUES (%s, %s, true, %s, %s, %s, %s, %s, %s, %s, %s,
                        ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s,
                        'pending', %s)
                """,
                (
                    rec["id"], next_version, rec["kind"], rec["confidence"], rec["reason"],
                    rec["source_composite"], rec["provider"], rec["model"], rec["engine"],
                    rec["bbox_pct"],
                    rec["geom_json"], rec["geom_hash"],
                    "ingest-33",
                ),
            )
        counts["updated"] += 1

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--candidates",
        default=DEFAULT_CANDIDATES,
        help=f"Input GeoJSON FeatureCollection (default: {DEFAULT_CANDIDATES})",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Actually commit to the database. Default is a dry run (no writes).",
    )
    args = parser.parse_args()

    here = Path(__file__).parent
    cand_path = Path(args.candidates)
    if not cand_path.is_absolute():
        cand_path = (here / cand_path).resolve()
    if not cand_path.exists():
        print(f"ERROR: candidates file not found: {cand_path}", file=sys.stderr)
        return 2

    log(f"Reading candidates from {cand_path}")
    features = load_candidates(cand_path)

    records: list[dict] = []
    for feat in features:
        try:
            records.append(feature_to_record(feat))
        except ValueError as exc:
            log(f"  skipping feature: {exc}")
    log(f"Parsed {len(records)} candidates (from {len(features)} features)")

    db_url = resolve_database_url()
    if not db_url:
        print(
            "ERROR: DATABASE_URL not found in "
            f"{ROOT_ENV} or {FALLBACK_ENV}",
            file=sys.stderr,
        )
        return 2

    mode = "WRITE" if args.write else "DRY-RUN"
    log(f"Mode: {mode}")

    if not args.write:
        # Dry run: try to classify against the live table, but degrade
        # gracefully if the DB is unreachable or the table isn't created yet
        # (DDL not applied) — every candidate then counts as a would-insert.
        try:
            with psycopg.connect(db_url, connect_timeout=5) as conn:
                if table_exists(conn):
                    counts = ingest(conn, records, write=False)
                    conn.rollback()
                    log("Dry run — no writes. Pass --write to commit.")
                else:
                    counts = {"inserted": len(records), "updated": 0,
                              "skipped": 0, "protected": 0}
                    log("parking.aerial_candidate does not exist yet "
                        "(DDL not applied) — all candidates would be new inserts.")
        except psycopg.Error as exc:
            counts = {"inserted": len(records), "updated": 0,
                      "skipped": 0, "protected": 0}
            log(f"Dry run — DB not reachable ({type(exc).__name__}); "
                "reporting all candidates as would-insert.")
    else:
        try:
            with psycopg.connect(db_url) as conn:
                counts = ingest(conn, records, write=True)
                conn.commit()
                log("Committed.")
        except psycopg.Error as exc:
            log(f"ERROR database: {type(exc).__name__}: {exc}")
            return 1

    verb = "would insert / would update" if not args.write else "inserted / updated"
    log(
        f"Summary: {verb}: {counts['inserted']} new, {counts['updated']} changed; "
        f"{counts['skipped']} unchanged (skipped); {counts['protected']} protected "
        f"(reviewed, not clobbered)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
