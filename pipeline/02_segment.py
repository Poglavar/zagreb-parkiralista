#!/usr/bin/env python3
"""Phase 1 step 2: Run text-prompted SAM 3 segmentation over a directory of
GeoTIFF tiles and write a binary mask GeoTIFF (georeferencing preserved) for
each input tile.

Uses samgeo's `SamGeo3` class with `backend="transformers"`, which loads SAM 3
through the HuggingFace `transformers` library and runs on Apple Silicon via MPS.
The default `backend="meta"` is broken on Mac because Meta's reference repo
needs NVIDIA Triton/CUDA.

IMPORTANT — HuggingFace gated repo:
  facebook/sam3 is access-gated. Before running this script the first time:
    1. Visit https://huggingface.co/facebook/sam3 and click "Request access"
    2. Generate a token at https://huggingface.co/settings/tokens (read scope)
    3. Authenticate locally with one of:
         hf auth login          # paste token interactively
         export HF_TOKEN=hf_xxx  # one-liner for the current shell
  Same applies if you fall back to `--model sam2` (also gated).

Usage:
  python 02_segment.py --tiles ../data/tiles/cdof2022 --prompt "parking lot"
  python 02_segment.py --tiles ../data/tiles/cdof2022 --limit 3 --conf-threshold 0.3
"""

import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def load_dotenv_minimal(env_path: Path) -> dict[str, str]:
    """Tiny .env parser — returns the parsed dict and applies it to os.environ
    via setdefault (does not override variables already in the environment).
    Avoids pulling in python-dotenv for a 3-line config file."""
    out: dict[str, str] = {}
    if not env_path.exists():
        return out
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        out[key] = val
        os.environ.setdefault(key, val)
    return out


def setup_hf_auth() -> str | None:
    """Find an HF token via several conventions and export it as HF_TOKEN, which
    is what the `transformers` and `huggingface_hub` libraries look for. Reads
    the project's `.env` file if present.

    Search order:
      1. HF_TOKEN env var (already set)
      2. HUGGING_FACE_HUB_TOKEN env var (older alias)
      3. HF_API_KEY from .env (the convention used in this project's .env)
    """
    project_root = Path(__file__).resolve().parent.parent
    load_dotenv_minimal(project_root / ".env")

    token = (
        os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or os.environ.get("HF_API_KEY")
    )
    if token:
        os.environ["HF_TOKEN"] = token
        os.environ["HUGGING_FACE_HUB_TOKEN"] = token
        log(f"HF auth: token found ({token[:6]}…), exported as HF_TOKEN")
    else:
        log("HF auth: no token found in env or .env — first run will fail with 401")
    return token


class _SegBackend:
    """Thin wrapper around the two segmentation backends so the main loop can
    treat them uniformly. Each instance owns the underlying samgeo model object."""

    def __init__(self, kind: str, model):
        self.kind = kind
        self.model = model

    def segment(self, image_path: Path, mask_path: Path, prompt: str,
                box_threshold: float, text_threshold: float) -> tuple[bool, int]:
        if self.kind == "sam3":
            try:
                self.model.set_image(str(image_path))
                masks = self.model.generate_masks(prompt=prompt, quiet=True)
                self.model.save_masks(output=str(mask_path), dtype="uint8")
                n = len(masks) if masks is not None else 0
                return mask_path.exists() and mask_path.stat().st_size > 0, n
            except Exception as exc:
                log(f"  ERROR on {image_path.name}: {type(exc).__name__}: {exc}")
                return False, 0
        elif self.kind == "langsam":
            try:
                self.model.predict(
                    image=str(image_path),
                    text_prompt=prompt,
                    box_threshold=box_threshold,
                    text_threshold=text_threshold,
                    output=str(mask_path),
                )
                # LangSAM doesn't return mask count directly; pull it from the
                # model's last-prediction state if available, else 1 means "any".
                boxes = getattr(self.model, "boxes", None)
                n = int(boxes.shape[0]) if hasattr(boxes, "shape") else (1 if mask_path.exists() else 0)
                return mask_path.exists() and mask_path.stat().st_size > 0, n
            except Exception as exc:
                log(f"  ERROR on {image_path.name}: {type(exc).__name__}: {exc}")
                return False, 0
        else:
            raise ValueError(f"Unknown backend kind: {self.kind}")


def init_sam3(model_id: str, conf_threshold: float, mask_threshold: float) -> _SegBackend:
    """Lazy-load samgeo and instantiate SamGeo3 with the transformers backend.
    The transformers backend works on Apple Silicon (MPS) and avoids the
    Triton/CUDA hard-requirement of the official Meta backend."""
    setup_hf_auth()  # bridge .env HF_API_KEY -> HF_TOKEN before transformers imports
    log(f"Importing samgeo (this can take a few seconds)…")
    try:
        from samgeo import SamGeo3, SAM3_TRANSFORMERS_AVAILABLE
    except ImportError as exc:
        print(
            "ERROR: segment-geospatial[samgeo3] not installed. Install with:\n"
            '  pip install -r requirements-ml.txt && pip install "segment-geospatial[samgeo3]"',
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    if not SAM3_TRANSFORMERS_AVAILABLE:
        from samgeo import SAM3_TRANSFORMERS_IMPORT_ERROR
        print(
            "ERROR: SAM 3 transformers backend not available. "
            f"Import error: {SAM3_TRANSFORMERS_IMPORT_ERROR}\n"
            'Install with: pip install "segment-geospatial[samgeo3]"',
            file=sys.stderr,
        )
        raise SystemExit(1)

    log(f"Initializing SamGeo3 (backend=transformers, model={model_id})…")
    log(f"  First run downloads model weights (~3 GB) and requires HF auth.")
    t0 = time.time()
    model = SamGeo3(
        backend="transformers",
        model_id=model_id,
        confidence_threshold=conf_threshold,
        mask_threshold=mask_threshold,
    )
    log(f"  ready in {time.time() - t0:.1f}s, device={getattr(model, 'device', '?')}")
    return _SegBackend("sam3", model)


def init_langsam(model_type: str) -> _SegBackend:
    """Fallback for when SAM 3 access is pending: GroundingDINO + SAM 1.
    Both components are non-gated — GroundingDINO weights live on a public HF
    repo (`IDEA-Research/grounding-dino-tiny`) and SAM 1 weights are downloaded
    directly from Meta's CDN (`https://dl.fbaipublicfiles.com/segment_anything/...`),
    so this path works without any HF authorization step.
    Quality is lower than SAM 3 for aerial imagery, but it's enough to validate
    the rest of the pipeline (vectorize / diff / viewer) end-to-end."""
    log(f"Importing samgeo.text_sam.LangSAM (GroundingDINO + SAM 1)…")
    try:
        from samgeo.text_sam import LangSAM
    except ImportError as exc:
        print(
            "ERROR: segment-geospatial[text] not installed. Run: pip install -r requirements-ml.txt",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    log(f"Initializing LangSAM (model_type={model_type})…")
    log(f"  First run downloads SAM 1 weights from Meta CDN (~2.6 GB for vit_h)")
    t0 = time.time()
    model = LangSAM(model_type=model_type)
    log(f"  ready in {time.time() - t0:.1f}s")
    return _SegBackend("langsam", model)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--tiles",
        required=True,
        help="Input directory of GeoTIFF tiles (typically data/tiles/<source>/)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output directory for mask GeoTIFFs (default: ../data/masks/<input dir name>/)",
    )
    parser.add_argument(
        "--prompt",
        default="parking lot",
        help="Text prompt for the model (default: 'parking lot'). Examples: 'asphalt parking', 'paved parking lot'",
    )
    parser.add_argument(
        "--backend",
        choices=["sam3", "langsam"],
        default="sam3",
        help="sam3: SamGeo3 + facebook/sam3 (best quality, gated). "
             "langsam: GroundingDINO + SAM 1 (non-gated fallback while SAM 3 access is pending).",
    )
    parser.add_argument(
        "--model-id",
        default="facebook/sam3",
        help="HuggingFace model ID for SAM 3 backend (default: facebook/sam3). Ignored for langsam.",
    )
    parser.add_argument(
        "--langsam-model",
        default="vit_h",
        help="SAM 1 weight variant for langsam backend: vit_h (best), vit_l, vit_b. Default: vit_h.",
    )
    parser.add_argument(
        "--box-threshold",
        type=float,
        default=0.24,
        help="GroundingDINO box detection threshold for langsam backend (default: 0.24)",
    )
    parser.add_argument(
        "--text-threshold",
        type=float,
        default=0.24,
        help="GroundingDINO text similarity threshold for langsam backend (default: 0.24)",
    )
    parser.add_argument(
        "--conf-threshold",
        type=float,
        default=0.5,
        help="Confidence threshold for box detections (default: 0.5)",
    )
    parser.add_argument(
        "--mask-threshold",
        type=float,
        default=0.5,
        help="Mask probability threshold for binarization (default: 0.5)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Stop after this many tiles (handy for smoke tests)",
    )
    args = parser.parse_args()

    tile_dir = Path(args.tiles).resolve()
    if not tile_dir.is_dir():
        print(f"ERROR: input dir does not exist: {tile_dir}", file=sys.stderr)
        return 2

    out_dir = Path(args.out).resolve() if args.out else (
        Path(__file__).parent / "../data/masks" / tile_dir.name
    ).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    tile_paths = sorted(tile_dir.glob("*.tif"))
    if not tile_paths:
        log(f"No .tif files in {tile_dir}; did you run 01_fetch_tiles.py?")
        return 1
    log(f"Found {len(tile_paths)} tiles in {tile_dir}")
    log(f"Output dir: {out_dir}")
    log(f"Prompt: '{args.prompt}', backend: {args.backend}")

    if args.backend == "sam3":
        backend = init_sam3(args.model_id, args.conf_threshold, args.mask_threshold)
    else:
        backend = init_langsam(args.langsam_model)

    processed = skipped = failed = 0
    total_masks = 0
    t_start = time.time()
    for i, tile_path in enumerate(tile_paths, 1):
        if args.limit is not None and processed >= args.limit:
            log(f"Reached --limit={args.limit}, stopping")
            break
        mask_path = out_dir / f"{tile_path.stem}_mask.tif"
        if mask_path.exists() and mask_path.stat().st_size > 0:
            skipped += 1
            continue

        elapsed = time.time() - t_start
        eta = (elapsed / max(processed, 1)) * (len(tile_paths) - i) if processed > 0 else 0
        log(f"  [{i}/{len(tile_paths)}] {tile_path.name} -> {mask_path.name} (eta {eta:.0f}s)")
        ok, n_masks = backend.segment(
            tile_path, mask_path, args.prompt, args.box_threshold, args.text_threshold
        )
        if ok:
            processed += 1
            total_masks += n_masks
            log(f"    → {n_masks} masks")
        else:
            failed += 1

    log(f"Done. processed={processed}, skipped={skipped} (cached), failed={failed}, "
        f"total_masks={total_masks}")
    log(f"Total time: {time.time() - t_start:.1f}s")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
