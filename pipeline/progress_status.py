#!/usr/bin/env python3
"""Heartbeat writer for the localhost processing-status dashboard.

Long-running pipeline scripts call report_progress() inside their main loop;
it writes a small JSON file to data/status/<process>.json (atomically, throttled
to once per second) that status/server.mjs picks up. Dead cheap — safe to call
on every iteration. The status dir is gitignored and never deployed.
"""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

STATUS_DIR = Path(__file__).resolve().parent.parent / "data" / "status"

_last_write: dict[str, float] = {}


def report_progress(process: str, current: int, total: int | None,
                    message: str = "", area: str | None = None,
                    done: bool = False) -> None:
    """Write the heartbeat for `process`. Throttled to 1 write/sec per process
    unless done=True (final state is always written)."""
    now = time.monotonic()
    if not done and now - _last_write.get(process, 0.0) < 1.0:
        return
    _last_write[process] = now

    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "process": process,
        "area": area,
        "current": current,
        "total": total,
        "message": message,
        "done": done,
        "pid": os.getpid(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    tmp = STATUS_DIR / f".{process}.json.tmp"
    final = STATUS_DIR / f"{process}.json"
    try:
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(final)
    except OSError:
        pass  # a status heartbeat must never take the pipeline down
