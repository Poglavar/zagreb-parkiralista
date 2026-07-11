# MEMORY — major decisions for future sessions

<!-- Append-only log of user decisions, architecture choices, and library selections. One-line rationale each. -->

- 2026-07-11: Phase 5 LLM cartographer default switched to `--provider claude-cli` (headless `claude -p`, subscription-billed) — API-token cost was the blocker for city-scale coverage; nominal cost still logged per composite in the output's `metadata.raw_log`.
- 2026-07-11: Area-scale composite coverage via `pipeline/32_render_area.py` (borders API → grid of centers, spacing 3 tiles, `--grid 4`) — Donji Grad = 29 composites; whole corpus reprocessed with claude-sonnet-5 (106 proposals, replacing the April Sonnet 4.6 set).
- 2026-07-11: SAM 3 unblocked — HF access approved and weights already cached from zgrade-datiranje (`~/.cache/huggingface`); Phase 1.2 smoke-tested OK on MPS (~15 s/tile → full 1260-tile run is an overnight job).
- 2026-07-11: `data/candidates/vehicles.geojson` + `data/final/informal_parking.geojson` are regenerated artifacts (fresh YOLO run) — they were dropped from git in 2acd5e0; treat them as pipeline outputs, not tracked data.
