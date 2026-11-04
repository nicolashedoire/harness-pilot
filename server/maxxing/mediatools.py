"""External media tools: found or not, and the command that installs what is missing (nothing is ever installed here).

Thumbnails and previews of images and videos are WebP images written by ffmpeg with its libwebp encoder
(api/files._ffmpeg_thumb); PDF thumbnails start with pdftoppm (poppler). Homebrew's `ffmpeg` has no libwebp encoder,
its keg-only `ffmpeg-full` has one (scripts/dev-local.sh puts it first on the PATH when it is installed).
Used by `pilot doctor` (check `media_tools`), GET /api/system/media-tools (Settings -> System) and a warning in the
server log at start in the local setup."""
from __future__ import annotations

import functools
import logging
import os
import re
import shutil
import subprocess
import sys

log = logging.getLogger(__name__)


@functools.lru_cache(maxsize=8)
def _encodes_webp(ffmpeg: str, mtime: float) -> bool:      # mtime: a reinstalled ffmpeg is asked again
    try:
        r = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=15,
                           stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(re.search(r"\blibwebp\b", r.stdout))


def _webp(ffmpeg: str) -> bool:
    try:
        return _encodes_webp(ffmpeg, os.stat(ffmpeg).st_mtime)
    except OSError:
        return False


def install_commands(missing: list[str]) -> list[str]:
    """The commands that install what is missing on this system (Homebrew on macOS, apt elsewhere)."""
    need_ffmpeg = "ffmpeg" in missing or "ffmpeg_webp" in missing
    need_pdf = "pdftoppm" in missing
    if sys.platform == "darwin":
        return (["brew install ffmpeg-full"] if need_ffmpeg else []) + (["brew install poppler"] if need_pdf else [])
    pkgs = (["ffmpeg"] if need_ffmpeg else []) + (["poppler-utils"] if need_pdf else [])
    return [f"sudo apt-get install -y {' '.join(pkgs)}"] if pkgs else []


def status() -> dict:
    """{ok, ffmpeg: {path, webp}, pdftoppm: {path}, missing: ["ffmpeg" | "ffmpeg_webp" | "pdftoppm"], install: [cmd]}"""
    ffmpeg, pdftoppm = shutil.which("ffmpeg"), shutil.which("pdftoppm")
    webp = bool(ffmpeg) and _webp(ffmpeg)
    missing = (["ffmpeg"] if not ffmpeg else [] if webp else ["ffmpeg_webp"]) + ([] if pdftoppm else ["pdftoppm"])
    return {"ok": not missing, "ffmpeg": {"path": ffmpeg, "webp": webp}, "pdftoppm": {"path": pdftoppm},
            "missing": missing, "install": install_commands(missing)}


WHAT = {
    "ffmpeg": "ffmpeg is not installed (thumbnails and previews of images and videos, voice messages)",
    "ffmpeg_webp": "ffmpeg has no WebP encoder (libwebp): images and videos get no thumbnails or previews",
    "pdftoppm": "pdftoppm is not installed (PDF thumbnails)",
}


def log_missing() -> None:
    """At start (local setup): one warning line per missing tool and the commands, in the server's terminal."""
    st = status()
    for m in st["missing"]:
        log.warning("media tools: %s", WHAT[m])
    if st["install"]:
        log.warning("media tools: install with `%s`, then restart", " && ".join(st["install"]))
