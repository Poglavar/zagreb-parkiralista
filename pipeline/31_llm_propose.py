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
  Default provider is `claude-cli`: it invokes the locally installed Claude
  Code CLI (`claude -p`) in headless mode, so usage is billed against the
  logged-in Claude subscription (Max) — no API key needed. For the API
  providers, put ANTHROPIC_API_KEY / OPENAI_API_KEY in the project root .env.

Usage:
  python 31_llm_propose.py ../data/composites/cdof2022/composite_tile_2980_33035_g4.png
  python 31_llm_propose.py --all                # process every composite in the dir (4 parallel CLI workers)
  python 31_llm_propose.py --all --provider anthropic   # old API path
  python 31_llm_propose.py --dry-run composite.png  # build the prompt + show what would be sent, no call
"""

import argparse
import base64
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from progress_status import report_progress

# Provider config — Claude via local CLI (subscription-billed), Claude via
# Anthropic API, and GPT (OpenAI API). Same prompt structure, same JSON output
# schema, same georeferencing logic — only the transport differs. Each feature
# in the output carries a `provider` tag so the viewer can render them in
# distinct colors for side-by-side comparison. claude-cli results are tagged
# provider=anthropic (they ARE Claude) so the viewer needs no changes; the
# raw_log records engine=claude-cli for attribution.
DEFAULT_MODEL_BY_PROVIDER = {
    # claude-cli: model alias resolved by the CLI ("sonnet" → current Sonnet).
    # Billed against the local Claude subscription (Max), not an API key.
    "claude-cli": "sonnet",
    # codex-cli: None = the codex config default (ChatGPT accounts only allow
    # that model set). Billed against the ChatGPT subscription.
    "codex-cli": None,
    "anthropic": "claude-sonnet-4-6",
    # Default to gpt-4o for OpenAI: it's vision-capable without the hidden
    # reasoning tokens that gpt-5 spends invisibly (and that can swallow the
    # whole completion budget before any user-visible JSON is emitted). The
    # user can still pass --model gpt-5 explicitly with a bigger --max-tokens.
    "openai": "gpt-4o",
}
# Anthropic responses fit comfortably in 2k. OpenAI gpt-5 / o-series models
# use most tokens on hidden reasoning, so we give the OpenAI path more room.
# claude-cli manages its own budget; the value is unused there.
DEFAULT_MAX_TOKENS_BY_PROVIDER = {
    "claude-cli": 0,
    "codex-cli": 0,
    "anthropic": 2000,
    "openai": 6000,
}

# JSON Schema handed to `claude --json-schema` so the CLI enforces the output
# shape (structured_output in the result wrapper) — no fence-stripping needed.
# polygon_pct is a FLAT alternating x,y list (nested pair-arrays made the CLI's
# structured-output enforcement flaky); 8-16 numbers = 4-8 vertices.
SUGGESTIONS_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["street_parking", "lot", "courtyard"]},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "reason": {"type": "string"},
                    "polygon_pct": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 8,
                        "maxItems": 16,
                    },
                },
                "required": ["kind", "confidence", "reason", "polygon_pct"],
            },
        },
    },
    "required": ["summary", "suggestions"],
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
      "polygon_pct": [x1, y1, x2, y2, x3, y3, x4, y4, ...]
    }}
  ]
}}

polygon_pct is a TIGHT polygon tracing the actual parking surface outline —
NOT a bounding box. It should hug the row of cars / pavement edge, may be
rotated relative to the image axes, and has 4-8 vertices (8-16 numbers, flat
alternating x,y). Coordinates are fractions of image dimensions: [0, 0] is
top-left, [1, 1] is bottom-right. Do NOT repeat the first vertex at the end.
For a row of parked cars, the polygon is a thin slanted strip along the row.
Be precise — the vertices are re-projected directly to GPS coordinates.

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
    Reads `.env` from project root once, then walks a few common alias names.
    claude-cli needs no API key — only the `claude` binary and a logged-in
    subscription — so it returns a sentinel if the binary is on PATH."""
    project_root = Path(__file__).resolve().parent.parent
    load_dotenv_minimal(project_root / ".env")

    if provider == "claude-cli":
        binary = shutil.which("claude")
        if binary:
            log(f"claude CLI found: {binary} (subscription-billed, no API key needed)")
            return binary
        log("claude CLI not found on PATH — install Claude Code or use --provider anthropic")
        return None

    if provider == "codex-cli":
        binary = shutil.which("codex")
        if binary:
            log(f"codex CLI found: {binary} (ChatGPT-subscription billed, no API key needed)")
            return binary
        log("codex CLI not found on PATH — install Codex or use --provider openai")
        return None

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


def call_claude_cli(image_path: Path, model: str, meta: dict, max_turns: int = 20) -> dict:
    """Send the composite to Claude through the LOCAL `claude` CLI in headless
    mode (`claude -p`). Usage is billed against the logged-in Claude
    subscription (Max plan), not per-token API billing — the wrapper's
    total_cost_usd is the nominal API-equivalent, reported for reference only.

    The CLI reads the image itself via its Read tool, and --json-schema forces
    the reply into SUGGESTIONS_JSON_SCHEMA (returned as structured_output).
    NOTE: --bare is deliberately NOT used — it skips the keychain OAuth lookup
    and the run fails with "Not logged in"."""
    user_prompt = PROMPT_USER_TEMPLATE.format(size_m=meta["size_m"], mpp=meta["mpp"])
    prompt = (
        f"{PROMPT_SYSTEM}\n\n"
        f"First use the Read tool to view the image file at: {image_path.resolve()}\n\n"
        f"{user_prompt}"
    )

    cmd = [
        "claude", "-p", prompt,
        "--output-format", "json",
        "--json-schema", json.dumps(SUGGESTIONS_JSON_SCHEMA),
        "--allowedTools", "Read",
        "--permission-mode", "dontAsk",
        "--max-turns", str(max_turns),
        "--model", model,
        "--no-session-persistence",
    ]

    # Strip any Anthropic API keys from the child env — if present, the CLI
    # would silently bill the API key instead of the subscription.
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_KEY", "CLAUDE_API_KEY")}

    log(f"Calling claude CLI ({model}) with composite ({image_path.stat().st_size / 1024:.1f} KiB)…")
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI exited {proc.returncode}: {proc.stderr[:500] or proc.stdout[:500]}")

    try:
        wrapper = json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise RuntimeError(f"claude CLI returned unparseable output: {exc}: {proc.stdout[:500]}")

    if wrapper.get("is_error"):
        raise RuntimeError(f"claude CLI error: {wrapper.get('result', '')[:500]}")

    parsed = wrapper.get("structured_output")
    if not isinstance(parsed, dict):
        raise RuntimeError(
            f"claude CLI returned no structured_output "
            f"(subtype={wrapper.get('subtype')}): {str(wrapper.get('result'))[:300]}"
        )

    usage = wrapper.get("usage", {})
    # The CLI resolves model aliases ("sonnet") to a concrete id — record it.
    resolved_model = next(iter(wrapper.get("modelUsage", {}) or {}), model)
    cost = wrapper.get("total_cost_usd", 0.0)
    log(f"  done in {time.time() - t0:.1f}s, turns={wrapper.get('num_turns')}, "
        f"nominal_cost=${cost:.3f} (subscription-covered), "
        f"tokens in/cached/out={usage.get('input_tokens')}/"
        f"{usage.get('cache_read_input_tokens')}/{usage.get('output_tokens')}")

    parsed["_raw_text"] = json.dumps(parsed, ensure_ascii=False)
    parsed["_usage"] = {
        "input_tokens": usage.get("input_tokens"),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "nominal_cost_usd": cost,
    }
    # Tagged as anthropic so the viewer renders these with the existing teal
    # style; engine records the actual transport.
    parsed["_provider"] = "anthropic"
    parsed["_model"] = resolved_model
    parsed["_engine"] = "claude-cli"
    return parsed


def _strictify_schema(node):
    """OpenAI structured-output strict mode requires every property in
    `required` and additionalProperties: false on every object. Recursively
    produce a strict copy of a JSON schema."""
    if isinstance(node, list):
        return [_strictify_schema(v) for v in node]
    if isinstance(node, dict):
        out = {k: _strictify_schema(v) for k, v in node.items()}
        if out.get("type") == "object" and "properties" in out:
            out["required"] = list(out["properties"].keys())
            out["additionalProperties"] = False
        return out
    return node


def call_codex_cli(image_path: Path, model: str | None, meta: dict) -> dict:
    """Send the composite through the LOCAL Codex CLI (`codex exec`) — billed
    against the logged-in ChatGPT subscription, not an API key. The image is
    attached natively via -i and --output-schema forces the reply into a
    strict-mode variant of SUGGESTIONS_JSON_SCHEMA."""
    import tempfile

    user_prompt = PROMPT_USER_TEMPLATE.format(size_m=meta["size_m"], mpp=meta["mpp"])
    prompt = f"{PROMPT_SYSTEM}\n\nThe attached image is the composite to analyse.\n\n{user_prompt}"

    # Strip OpenAI API keys so codex bills the subscription, not a key.
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "OPENAI_KEY", "OAI_API_KEY")}

    with tempfile.TemporaryDirectory(prefix="codex-aerial-") as tmp:
        schema_path = Path(tmp) / "schema.json"
        schema_path.write_text(json.dumps(_strictify_schema(SUGGESTIONS_JSON_SCHEMA)))
        out_path = Path(tmp) / "out.json"

        cmd = [
            "codex", "exec",
            "-i", str(image_path.resolve()),
            "--output-schema", str(schema_path),
            "-o", str(out_path),
            "--ephemeral", "--skip-git-repo-check",
            "-s", "read-only",
            "-c", 'model_reasoning_effort="medium"',
            "--color", "never",
        ]
        if model:
            cmd += ["-m", model]
        cmd.append(prompt)

        log(f"Calling codex CLI ({model or 'config default'}) with composite ({image_path.stat().st_size / 1024:.1f} KiB)…")
        t0 = time.time()
        # stdin MUST be devnull: codex exec treats a piped-open stdin as
        # "prompt will arrive on stdin" and waits for EOF forever.
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                              env=env, stdin=subprocess.DEVNULL)
        if proc.returncode != 0:
            raise RuntimeError(f"codex CLI exited {proc.returncode}: {(proc.stderr or proc.stdout)[-400:]}")
        try:
            parsed = json.loads(out_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"codex final message unparseable: {exc}: {proc.stdout[-300:]}")

    # Human-readable header/footer land on stderr when stdout isn't a TTY.
    combined = proc.stdout + "\n" + proc.stderr
    tokens_m = re.search(r"tokens used\s*\n\s*([\d,]+)", combined, re.IGNORECASE)
    model_m = re.search(r"^model:\s*(\S+)", combined, re.MULTILINE)
    total_tokens = int(tokens_m.group(1).replace(",", "")) if tokens_m else None
    resolved_model = model_m.group(1) if model_m else (model or "codex-config-default")

    log(f"  done in {time.time() - t0:.1f}s, tokens={total_tokens} (ChatGPT-subscription covered)")

    parsed["_raw_text"] = json.dumps(parsed, ensure_ascii=False)
    parsed["_usage"] = {"total_tokens": total_tokens}
    parsed["_provider"] = "openai"
    parsed["_model"] = resolved_model
    parsed["_engine"] = "codex-cli"
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
    if provider == "claude-cli":
        return call_claude_cli(image_path, model, meta, max_turns=max_tokens or 20)
    if provider == "codex-cli":
        return call_codex_cli(image_path, model, meta)
    if provider == "anthropic":
        return call_claude(image_path, model, max_tokens, meta)
    if provider == "openai":
        return call_openai(image_path, model, max_tokens, meta)
    raise ValueError(f"Unknown provider: {provider}")


def polygon_pct_to_polygon(polygon_pct: list[float], meta: dict) -> dict:
    """Convert a flat [x1, y1, x2, y2, …] image-space vertex list (0..1) to a
    WGS84 GeoJSON polygon, using the composite's bbox metadata. Each vertex is
    mapped independently so the polygon keeps its orientation (unlike the old
    axis-aligned bbox rectangles)."""
    if not polygon_pct or len(polygon_pct) < 8 or len(polygon_pct) % 2 != 0:
        raise ValueError(f"polygon_pct must be a flat list of >= 4 x,y pairs, got {polygon_pct}")
    verts = [
        (max(0.0, min(float(polygon_pct[i]), 1.0)),
         max(0.0, min(float(polygon_pct[i + 1]), 1.0)))
        for i in range(0, len(polygon_pct), 2)
    ]
    if len({v for v in verts}) < 3:
        raise ValueError(f"degenerate polygon_pct {polygon_pct}")

    # Map image-space (0..1, top-down) to EPSG:3765 (bottom-up y).
    minx, miny, maxx, maxy = meta["bbox_3765"]
    span_x = maxx - minx
    span_y = maxy - miny

    from pyproj import Transformer
    to_4326 = Transformer.from_crs("EPSG:3765", "EPSG:4326", always_xy=True).transform
    ring_3765 = [(minx + x * span_x, maxy - y * span_y) for x, y in verts]
    ring_3765.append(ring_3765[0])  # close the ring
    coords = [list(to_4326(x, y)) for x, y in ring_3765]
    return {"type": "Polygon", "coordinates": [coords]}


def parse_proposals(parsed: dict, composite_meta: dict, image_path: Path, provider: str, model: str) -> list[dict]:
    """Convert an LLM's `suggestions` list to a list of GeoJSON Features.
    Each feature carries the provider tag so multi-provider results can coexist
    in one file without losing attribution. The provider/model recorded on the
    feature come from the parsed result (claude-cli runs are tagged anthropic
    with the resolved model id, so the viewer needs no changes)."""
    feature_provider = parsed.get("_provider", provider)
    feature_model = parsed.get("_model", model)
    engine = parsed.get("_engine")
    features: list[dict] = []
    for i, sugg in enumerate(parsed.get("suggestions", []) or []):
        poly_pct = sugg.get("polygon_pct")
        try:
            geom = polygon_pct_to_polygon(poly_pct, composite_meta)
        except Exception as exc:
            log(f"  skipping suggestion #{i}: {exc}")
            continue
        # Envelope of the polygon in image space — the viewer's composite-crop
        # popup preview is bbox-based, so keep providing one.
        xs = [poly_pct[k] for k in range(0, len(poly_pct), 2)]
        ys = [poly_pct[k] for k in range(1, len(poly_pct), 2)]
        props = {
            "kind": sugg.get("kind", "unknown"),
            "confidence": sugg.get("confidence", "low"),
            "reason": sugg.get("reason", ""),
            "polygon_pct": poly_pct,
            "bbox_pct": [min(xs), min(ys), max(xs), max(ys)],
            "source_composite": image_path.stem,
            "provider": feature_provider,
            "model": feature_model,
        }
        if engine:
            props["engine"] = engine
        features.append({
            "type": "Feature",
            "id": f"{image_path.stem}/{feature_provider}/{i}",
            "geometry": geom,
            "properties": props,
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
        choices=["claude-cli", "codex-cli", "anthropic", "openai", "both"],
        default="claude-cli",
        help="LLM provider (default: claude-cli — local Claude Code CLI, billed against the "
             "Claude subscription). 'codex-cli' uses the local Codex CLI (ChatGPT subscription). "
             "'anthropic'/'openai' use API keys. 'both' runs anthropic + openai for A/B.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Parallel requests (default: 4 for claude-cli, 1 for API providers).",
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
        help="Override per-provider default (anthropic: 2000, openai: 6000). gpt-5 needs 8000+. "
             "For claude-cli this sets --max-turns instead (default 20; dense city-core tiles may need 40).",
    )
    parser.add_argument(
        "--skip-processed",
        action="store_true",
        help="Skip composites already present in the output file (per raw_log). "
             "Makes interrupted city-scale runs resumable.",
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

    if args.skip_processed and existing_meta_log:
        already = {entry.get("composite") for entry in existing_meta_log if entry.get("n_features") is not None}
        before = len(composite_paths)
        composite_paths = [p for p in composite_paths if p.name not in already]
        log(f"--skip-processed: {before - len(composite_paths)} already done, {len(composite_paths)} to go")
        if not composite_paths:
            log("Nothing left to process.")
            return 0

    new_features: list[dict] = []
    raw_log: list[dict] = []

    for prov in providers:
        model = args.model or DEFAULT_MODEL_BY_PROVIDER[prov]
        max_tok = args.max_tokens or DEFAULT_MAX_TOKENS_BY_PROVIDER[prov]
        workers = args.workers or (4 if prov in ("claude-cli", "codex-cli") else 1)
        log(f"=== provider: {prov} ({model}, max_tokens={max_tok}, workers={workers}) ===")

        def run_one(composite_path: Path) -> tuple[Path, list[dict], dict] | None:
            try:
                features, parsed = process_composite(
                    composite_path, prov, model, max_tok, args.dry_run
                )
                return composite_path, features, parsed
            except Exception as exc:
                log(f"  ERROR {composite_path.name}: {type(exc).__name__}: {exc}")
                return None

        results: list[tuple[Path, list[dict], dict] | None] = []
        if workers > 1 and not args.dry_run:
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                futures = {pool.submit(run_one, p): p for p in composite_paths}
                done = 0
                for fut in concurrent.futures.as_completed(futures):
                    done += 1
                    res = fut.result()
                    if res:
                        log(f"[{done}/{len(composite_paths)}] {res[0].name} → {len(res[1])} suggestions")
                    results.append(res)
                    report_progress("aerial-llm", done, len(composite_paths),
                                    message=futures[fut].name, area=prov)
        else:
            for i, composite_path in enumerate(composite_paths, 1):
                log(f"[{i}/{len(composite_paths)}] {composite_path.name}")
                res = run_one(composite_path)
                if res:
                    log(f"  → {len(res[1])} suggestions")
                results.append(res)
                report_progress("aerial-llm", i, len(composite_paths),
                                message=composite_path.name, area=prov)
                if i < len(composite_paths) and not args.dry_run:
                    time.sleep(args.throttle_ms / 1000.0)
        report_progress("aerial-llm", len(composite_paths), len(composite_paths),
                        message="finished", area=prov, done=True)

        prov_cost = 0.0
        for res in results:
            if not res:
                continue
            composite_path, features, parsed = res
            if parsed.get("summary"):
                log(f"  {composite_path.name}: {parsed['summary']}")
            new_features.extend(features)
            prov_cost += (parsed.get("_usage") or {}).get("nominal_cost_usd") or 0.0
            raw_log.append({
                "composite": composite_path.name,
                "provider": parsed.get("_provider", prov),
                "engine": parsed.get("_engine"),
                "model": parsed.get("_model", model),
                "summary": parsed.get("summary"),
                "n_features": len(features),
                "raw_text": parsed.get("_raw_text"),
                "usage": parsed.get("_usage"),
            })
        if prov == "claude-cli":
            log(f"=== {prov} total nominal cost: ${prov_cost:.2f} (API-equivalent; "
                f"actually billed to Claude subscription) ===")

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
