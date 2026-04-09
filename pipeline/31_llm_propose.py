#!/usr/bin/env python3
"""Phase 5 step 2: Send a composite preview image (from 30_render_composite.py)
to Claude Sonnet 4.6 and ask it to identify likely-but-unmapped parking areas.

The composite has aerial imagery + OSM road network + existing parking polygons +
YOLO car detections all overlaid on a single PNG. Claude reads the image like a
human cartographer doing manual QA: looking for visual evidence of parking
(asphalt, lines, cars peeking through canopy), reasoning about continuity with
neighboring streets, and proposing specific places to look.

Output: GeoJSON FeatureCollection of LLM-proposed candidate areas, each with:
  - polygon geometry (rectangle from the LLM's bbox_pct, georeferenced via the
    composite's bbox metadata)
  - kind: street_parking | lot | courtyard
  - confidence: high | medium | low
  - reason: one short sentence from the LLM
  - source_composite + model + timestamp

The output is intentionally treated as PROPOSALS for human review, not
authoritative. The viewer renders them in a distinct color and shows the LLM's
reason text in the popup.

Setup:
  1. Get an Anthropic API key: https://console.anthropic.com/settings/keys
  2. Add to project root .env:
       ANTHROPIC_API_KEY=sk-ant-xxx
  3. Run: python 31_llm_propose.py path/to/composite.png

Usage:
  python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png
  python 31_llm_propose.py --all                # process every composite in the dir
  python 31_llm_propose.py --dry-run composite.png  # build the prompt + show what would be sent, no API call
"""

import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Provider config — both Claude (Anthropic) and GPT (OpenAI) supported. Same
# prompt structure, same JSON output schema, same georeferencing logic — only
# the API client and image-payload format differ. Each feature in the output
# carries a `provider` tag so the viewer can render them in distinct colors
# for side-by-side comparison.
DEFAULT_MODEL_BY_PROVIDER = {
    "anthropic": "claude-sonnet-4-6",
    # Default to gpt-4o for OpenAI: it's vision-capable without the hidden
    # reasoning tokens that gpt-5 spends invisibly (and that can swallow the
    # whole completion budget before any user-visible JSON is emitted). The
    # user can still pass --model gpt-5 explicitly with a bigger --max-tokens.
    "openai": "gpt-4o",
}
# Anthropic responses fit comfortably in 2k. OpenAI gpt-5 / o-series models
# use most tokens on hidden reasoning, so we give the OpenAI path more room.
DEFAULT_MAX_TOKENS_BY_PROVIDER = {
    "anthropic": 2000,
    "openai": 6000,
}

PROMPT_SYSTEM = """You are a Zagreb cartographer reviewing aerial imagery of the city.
You're checking whether OpenStreetMap is missing any parking areas that are
clearly visible in the image. Be conservative — only flag places where the
visual or contextual evidence is solid. Do not propose parking inside an
existing blue polygon (those are already mapped)."""

PROMPT_USER_TEMPLATE = """Analyse this composite image of a {size_m:.0f}×{size_m:.0f} m section
of Zagreb. The image is at roughly {mpp:.2f} m/pixel.

Layers drawn on top of the aerial imagery:
- BLUE polygons with thick navy borders = OSM amenity=parking already mapped
- PURPLE circles with "P" = enclosed garages mapped as a single OSM node
  (multi-storey or underground; their footprint isn't shown)
- RED dots = individual cars detected by computer vision (some are real cars,
  some are noise — use them as a soft signal)
- WHITE/YELLOW lines = the OSM road network drawn explicitly so you can still
  see streets where tree canopy hides the asphalt

Your task: identify any places where parking probably exists but is NOT yet
mapped as a blue polygon. Use these signals in order of importance:

1. Visible parking infrastructure: clear asphalt rectangles, painted stall
   lines, perpendicular/angled parking patterns
2. Clusters of red dots OUTSIDE any blue polygon — especially when they line
   up along a street or fill a courtyard
3. Continuity: if neighboring segments of the same street have blue parking
   polygons but a stretch in between is blank, flag the gap. Tree canopy
   often hides parking that's actually there
4. Building setbacks consistent with parking: a ~5–7 m gap between the
   building line and the road, with hints of cars or asphalt

Be CONSERVATIVE. Don't propose:
- Parking that's already inside a blue polygon
- Driveways and short access roads
- The road carriageway itself (cars in motion vs cars parked)
- Areas where you can see grass, lawn, or unbroken canopy with no cars
- Speculative guesses without at least one solid visual signal

Return STRICT JSON, no prose around it. Schema:

{{
  "summary": "one sentence about what you saw at a high level",
  "suggestions": [
    {{
      "kind": "street_parking" | "lot" | "courtyard",
      "confidence": "high" | "medium" | "low",
      "reason": "one sentence explaining the evidence",
      "bbox_pct": [x_min, y_min, x_max, y_max]
    }}
  ]
}}

bbox_pct is the proposed area as percentages of image dimensions, where
[0, 0] is top-left and [1, 1] is bottom-right. So bbox_pct of
[0.40, 0.55, 0.55, 0.65] means a rectangle from 40%–55% horizontally and
55%–65% vertically. Be precise about the bbox — it's how we re-project the
proposal back to GPS coordinates.

If you find nothing clearly missing, return an empty suggestions array. That's
a valid and useful answer."""


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_dotenv_minimal(env_path: Path) -> None:
    """Tiny .env parser. Same logic as 02_segment.py."""
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


def setup_provider_auth(provider: str) -> str | None:
    """Bridge .env API keys to the right env var for the chosen provider.
    Reads `.env` from project root once, then walks a few common alias names."""
    project_root = Path(__file__).resolve().parent.parent
    load_dotenv_minimal(project_root / ".env")

    if provider == "anthropic":
        token = (
            os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("ANTHROPIC_KEY")
            or os.environ.get("CLAUDE_API_KEY")
        )
        if token:
            os.environ["ANTHROPIC_API_KEY"] = token
            log(f"Anthropic auth: token found ({token[:10]}…)")
        else:
            log("Anthropic auth: no ANTHROPIC_API_KEY in env or .env")
        return token

    if provider == "openai":
        token = (
            os.environ.get("OPENAI_API_KEY")
            or os.environ.get("OPENAI_KEY")
            or os.environ.get("OAI_API_KEY")
        )
        if token:
            os.environ["OPENAI_API_KEY"] = token
            log(f"OpenAI auth: token found ({token[:10]}…)")
        else:
            log("OpenAI auth: no OPENAI_API_KEY in env or .env")
        return token

    raise ValueError(f"Unknown provider: {provider}")


def encode_image_b64(path: Path) -> tuple[str, str]:
    """Read a PNG and return (base64 string, media type)."""
    media = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return base64.standard_b64encode(path.read_bytes()).decode("utf-8"), media


def _strip_fences(text: str) -> str:
    """Strip optional ```json … ``` fences that LLMs sometimes wrap JSON in."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def call_claude(image_path: Path, model: str, max_tokens: int, meta: dict) -> dict:
    """Send the composite image to Claude (Anthropic) and return parsed JSON."""
    user_prompt = PROMPT_USER_TEMPLATE.format(size_m=meta["size_m"], mpp=meta["mpp"])

    import anthropic

    client = anthropic.Anthropic()
    img_b64, media_type = encode_image_b64(image_path)

    log(f"Calling Claude {model} with composite ({image_path.stat().st_size / 1024:.1f} KiB)…")
    t0 = time.time()
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=PROMPT_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": img_b64,
                        },
                    },
                    {"type": "text", "text": user_prompt},
                ],
            }
        ],
    )
    log(f"  done in {time.time() - t0:.1f}s, "
        f"input_tokens={response.usage.input_tokens}, output_tokens={response.usage.output_tokens}")

    text_blocks = [b.text for b in response.content if hasattr(b, "text")]
    full_text = _strip_fences("\n".join(text_blocks))

    try:
        parsed = json.loads(full_text)
    except json.JSONDecodeError as exc:
        log(f"  ERROR could not parse JSON: {exc}")
        log(f"  raw text: {full_text[:500]}")
        raise

    parsed["_raw_text"] = full_text
    parsed["_usage"] = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    }
    parsed["_provider"] = "anthropic"
    parsed["_model"] = model
    return parsed


def call_openai(image_path: Path, model: str, max_tokens: int, meta: dict) -> dict:
    """Send the composite image to GPT (OpenAI vision) and return parsed JSON.
    Uses the chat.completions API with image_url + base64 content. Same prompt
    + same JSON schema as the Claude path so results are directly comparable.

    Notes on reasoning models (gpt-5 / o-series): they spend most of the
    completion budget on hidden reasoning tokens. If you pass --model gpt-5 you
    typically need --max-tokens 8000+ otherwise the user-visible content comes
    back empty. gpt-4o (the default here) doesn't have this problem."""
    user_prompt = PROMPT_USER_TEMPLATE.format(size_m=meta["size_m"], mpp=meta["mpp"])

    import openai

    client = openai.OpenAI()
    img_b64, media_type = encode_image_b64(image_path)
    data_url = f"data:{media_type};base64,{img_b64}"

    log(f"Calling OpenAI {model} with composite ({image_path.stat().st_size / 1024:.1f} KiB), "
        f"max_tokens={max_tokens}…")
    t0 = time.time()
    response = client.chat.completions.create(
        model=model,
        max_completion_tokens=max_tokens,
        messages=[
            {"role": "system", "content": PROMPT_SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                ],
            },
        ],
        response_format={"type": "json_object"},
    )
    elapsed = time.time() - t0
    usage = response.usage
    # Some reasoning models report reasoning_tokens separately; surface them
    # so the user can see why a budget got swallowed.
    reasoning_tokens = None
    details = getattr(usage, "completion_tokens_details", None)
    if details is not None:
        reasoning_tokens = getattr(details, "reasoning_tokens", None)
    extra = f", reasoning_tokens={reasoning_tokens}" if reasoning_tokens is not None else ""
    log(f"  done in {elapsed:.1f}s, "
        f"prompt_tokens={usage.prompt_tokens}, completion_tokens={usage.completion_tokens}{extra}")

    full_text = _strip_fences(response.choices[0].message.content or "")

    if not full_text:
        finish = response.choices[0].finish_reason
        raise ValueError(
            f"OpenAI {model} returned empty content (finish_reason={finish}). "
            f"This usually means a reasoning model exhausted max_completion_tokens "
            f"({max_tokens}) on hidden reasoning. Either: (a) raise --max-tokens "
            f"to ~8000+, or (b) use --model gpt-4o which has no hidden reasoning."
        )

    try:
        parsed = json.loads(full_text)
    except json.JSONDecodeError as exc:
        log(f"  ERROR could not parse JSON: {exc}")
        log(f"  raw text: {full_text[:500]}")
        raise

    parsed["_raw_text"] = full_text
    parsed["_usage"] = {
        "input_tokens": usage.prompt_tokens,
        "output_tokens": usage.completion_tokens,
        "reasoning_tokens": reasoning_tokens,
    }
    parsed["_provider"] = "openai"
    parsed["_model"] = model
    return parsed


def call_provider(provider: str, image_path: Path, model: str, max_tokens: int, dry_run: bool, meta: dict) -> dict:
    """Provider-agnostic dispatch. Returns the same parsed dict shape for both."""
    if dry_run:
        user_prompt = PROMPT_USER_TEMPLATE.format(size_m=meta["size_m"], mpp=meta["mpp"])
        log("[dry-run] would send:")
        log(f"  provider: {provider}")
        log(f"  model: {model}")
        log(f"  image: {image_path.name} ({image_path.stat().st_size / 1024:.1f} KiB)")
        log(f"  system prompt: {len(PROMPT_SYSTEM)} chars")
        log(f"  user prompt: {len(user_prompt)} chars")
        return {
            "summary": "(dry-run, no call made)",
            "suggestions": [],
            "_provider": provider,
            "_model": model,
            "_usage": {"input_tokens": 0, "output_tokens": 0},
        }
    if provider == "anthropic":
        return call_claude(image_path, model, max_tokens, meta)
    if provider == "openai":
        return call_openai(image_path, model, max_tokens, meta)
    raise ValueError(f"Unknown provider: {provider}")


def bbox_pct_to_polygon(bbox_pct: list[float], meta: dict) -> dict:
    """Convert a [x_min, y_min, x_max, y_max] image-space pct (0..1) to a
    WGS84 GeoJSON polygon, using the composite's bbox metadata. The result is
    a closed rectangle (5 coords) in lon/lat order."""
    if not bbox_pct or len(bbox_pct) != 4:
        raise ValueError(f"bbox_pct must be [x_min, y_min, x_max, y_max], got {bbox_pct}")
    x0, y0, x1, y1 = [float(v) for v in bbox_pct]
    # Clamp to [0,1] in case the model went a hair outside
    x0 = max(0.0, min(x0, 1.0))
    y0 = max(0.0, min(y0, 1.0))
    x1 = max(0.0, min(x1, 1.0))
    y1 = max(0.0, min(y1, 1.0))
    if x0 >= x1 or y0 >= y1:
        raise ValueError(f"degenerate bbox_pct {bbox_pct}")

    # Map image-space (0..1, top-down) to EPSG:3765 bbox (bottom-up).
    bbox = meta["bbox_3765"]  # [minx, miny, maxx, maxy]
    minx, miny, maxx, maxy = bbox
    span_x = maxx - minx
    span_y = maxy - miny
    # Image y is top-down; geographic y is bottom-up. Flip.
    geo_x0 = minx + x0 * span_x
    geo_x1 = minx + x1 * span_x
    geo_y0 = maxy - y1 * span_y  # bottom edge of bbox in geographic Y
    geo_y1 = maxy - y0 * span_y  # top edge

    # Reproject the 4 corners to WGS84
    from pyproj import Transformer
    to_4326 = Transformer.from_crs("EPSG:3765", "EPSG:4326", always_xy=True).transform
    corners_3765 = [
        (geo_x0, geo_y0),
        (geo_x1, geo_y0),
        (geo_x1, geo_y1),
        (geo_x0, geo_y1),
        (geo_x0, geo_y0),  # close the ring
    ]
    coords = [list(to_4326(x, y)) for x, y in corners_3765]
    return {"type": "Polygon", "coordinates": [coords]}


def parse_proposals(parsed: dict, composite_meta: dict, image_path: Path, provider: str, model: str) -> list[dict]:
    """Convert an LLM's `suggestions` list to a list of GeoJSON Features.
    Each feature carries the provider tag so multi-provider results can coexist
    in one file without losing attribution."""
    features: list[dict] = []
    for i, sugg in enumerate(parsed.get("suggestions", []) or []):
        try:
            geom = bbox_pct_to_polygon(sugg.get("bbox_pct"), composite_meta)
        except Exception as exc:
            log(f"  skipping suggestion #{i}: {exc}")
            continue
        features.append({
            "type": "Feature",
            "id": f"{image_path.stem}/{provider}/{i}",
            "geometry": geom,
            "properties": {
                "kind": sugg.get("kind", "unknown"),
                "confidence": sugg.get("confidence", "low"),
                "reason": sugg.get("reason", ""),
                "bbox_pct": sugg.get("bbox_pct"),
                "source_composite": image_path.stem,
                "provider": provider,
                "model": model,
            },
        })
    return features


def process_composite(image_path: Path, provider: str, model: str, max_tokens: int, dry_run: bool) -> tuple[list[dict], dict]:
    """End-to-end: load metadata, call provider, parse suggestions to features."""
    meta_path = image_path.with_suffix(".json")
    if not meta_path.exists():
        raise SystemExit(f"sidecar metadata not found: {meta_path}. Run 30_render_composite.py first.")
    with meta_path.open(encoding="utf-8") as f:
        composite_meta = json.load(f)

    parsed = call_provider(provider, image_path, model, max_tokens, dry_run, composite_meta)
    features = parse_proposals(parsed, composite_meta, image_path, provider, model)
    return features, parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("composite", nargs="?", help="Composite PNG path (or use --all)")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Process every composite in data/composites/cdof2022/",
    )
    parser.add_argument(
        "--composites-dir",
        default="../data/composites/cdof2022",
        help="Directory of composite PNGs (used with --all)",
    )
    parser.add_argument(
        "--out",
        default="../data/candidates/llm_parking_candidates.geojson",
        help="Output GeoJSON path",
    )
    parser.add_argument(
        "--provider",
        choices=["anthropic", "openai", "both"],
        default="anthropic",
        help="LLM provider (default: anthropic). 'both' runs each provider in turn for A/B comparison.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Override model name (default: per-provider sensible default — claude-sonnet-4-6 / gpt-5)",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=None,
        help="Override per-provider default (anthropic: 2000, openai: 6000). gpt-5 needs 8000+.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would be sent without calling the API")
    parser.add_argument("--throttle-ms", type=int, default=500, help="Sleep between API calls (default: 500)")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Discard any existing features in the output file. Default: append + replace-by-id, "
             "so multi-provider runs accumulate in one file.",
    )
    args = parser.parse_args()

    providers = ["anthropic", "openai"] if args.provider == "both" else [args.provider]

    if not args.dry_run:
        for prov in providers:
            token = setup_provider_auth(prov)
            if not token:
                key_var = "ANTHROPIC_API_KEY" if prov == "anthropic" else "OPENAI_API_KEY"
                console_url = (
                    "https://console.anthropic.com/settings/keys"
                    if prov == "anthropic"
                    else "https://platform.openai.com/api-keys"
                )
                print(
                    f"ERROR: {key_var} not set. Either:\n"
                    f"  1. Add to project root .env: {key_var}=...\n"
                    f"  2. Or run with --dry-run to skip the API call\n"
                    f"Get a key at {console_url}",
                    file=sys.stderr,
                )
                return 2

    here = Path(__file__).parent
    out_path = (here / args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Resolve composite paths
    if args.all:
        comp_dir = (here / args.composites_dir).resolve()
        if not comp_dir.is_dir():
            print(f"ERROR: composites dir not found: {comp_dir}", file=sys.stderr)
            return 2
        composite_paths = sorted(comp_dir.glob("*.png"))
        if not composite_paths:
            print(f"ERROR: no composites in {comp_dir}", file=sys.stderr)
            return 1
        log(f"Processing {len(composite_paths)} composites from {comp_dir}")
    elif args.composite:
        p = Path(args.composite)
        if not p.is_absolute():
            p = (here / p).resolve() if (here / p).exists() else p.resolve()
        if not p.exists():
            print(f"ERROR: composite not found: {p}", file=sys.stderr)
            return 2
        composite_paths = [p]
    else:
        print("ERROR: provide a composite path or --all", file=sys.stderr)
        return 2

    # Load existing file if appending. We delete features that match the
    # (composite, provider) we're about to regenerate so re-runs are idempotent.
    existing_features: list[dict] = []
    existing_meta_log: list[dict] = []
    if not args.overwrite and out_path.exists():
        try:
            with out_path.open(encoding="utf-8") as f:
                existing_data = json.load(f)
                existing_features = existing_data.get("features", []) or []
                existing_meta_log = (existing_data.get("metadata") or {}).get("raw_log", []) or []
            log(f"Read {len(existing_features)} existing features from {out_path}")
        except Exception as exc:
            log(f"  WARN couldn't parse existing file ({exc}), starting fresh")
            existing_features = []
            existing_meta_log = []

    new_features: list[dict] = []
    raw_log: list[dict] = []

    for prov in providers:
        model = args.model or DEFAULT_MODEL_BY_PROVIDER[prov]
        max_tok = args.max_tokens or DEFAULT_MAX_TOKENS_BY_PROVIDER[prov]
        log(f"=== provider: {prov} ({model}, max_tokens={max_tok}) ===")

        for i, composite_path in enumerate(composite_paths, 1):
            log(f"[{i}/{len(composite_paths)}] {composite_path.name}")
            try:
                features, parsed = process_composite(
                    composite_path, prov, model, max_tok, args.dry_run
                )
            except Exception as exc:
                log(f"  ERROR: {type(exc).__name__}: {exc}")
                continue
            log(f"  → {len(features)} suggestions")
            if parsed.get("summary"):
                log(f"  summary: {parsed['summary']}")
            new_features.extend(features)
            raw_log.append({
                "composite": composite_path.name,
                "provider": prov,
                "model": model,
                "summary": parsed.get("summary"),
                "n_features": len(features),
                "raw_text": parsed.get("_raw_text"),
                "usage": parsed.get("_usage"),
            })
            if i < len(composite_paths) and not args.dry_run:
                time.sleep(args.throttle_ms / 1000.0)

    # Replace-by-id: drop any existing features whose id matches a freshly
    # produced one (so re-runs of the same composite/provider don't duplicate).
    new_ids = {f["id"] for f in new_features}
    kept_existing = [f for f in existing_features if f.get("id") not in new_ids]
    all_features = kept_existing + new_features

    log(f"Merge: kept {len(kept_existing)} existing, added {len(new_features)} new "
        f"= {len(all_features)} total features")

    # Aggregated stats
    by_kind: dict[str, int] = {}
    by_conf: dict[str, int] = {}
    by_provider: dict[str, int] = {}
    for f in all_features:
        p = f["properties"]
        by_kind[p.get("kind", "unknown")] = by_kind.get(p.get("kind", "unknown"), 0) + 1
        by_conf[p.get("confidence", "low")] = by_conf.get(p.get("confidence", "low"), 0) + 1
        by_provider[p.get("provider", "?")] = by_provider.get(p.get("provider", "?"), 0) + 1

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "Phase 5 LLM cartographer",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "providers_run_now": providers,
            "n_composites": len(composite_paths),
            "feature_count": len(all_features),
            "by_kind": by_kind,
            "by_confidence": by_conf,
            "by_provider": by_provider,
            "raw_log": existing_meta_log + raw_log if not args.overwrite else raw_log,
        },
        "features": all_features,
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    log(f"Total: {len(all_features)} features ({len(new_features)} new, "
        f"{len(kept_existing)} kept from previous run)")
    log(f"By provider: {by_provider}")
    log(f"By kind: {by_kind}")
    log(f"By confidence: {by_conf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
