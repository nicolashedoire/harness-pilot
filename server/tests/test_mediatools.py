"""Media tools (maxxing/mediatools.py): ffmpeg with its WebP encoder and pdftoppm, found or not, with the commands that
install what is missing, in `pilot doctor` and GET /api/system/media-tools. Fake tools on a PATH of their own."""
from __future__ import annotations

import json
import logging

import pytest

from _org_helpers import client, org  # noqa: F401
from maxxing import cmd_core, mediatools


def _tool(d, name: str, out: str = "") -> None:
    f = d / name
    f.write_text(f"#!/bin/sh\nprintf '%s\\n' {json.dumps(out)}\n")
    f.chmod(0o755)


@pytest.fixture
def bin_dir(tmp_path, monkeypatch):
    d = tmp_path / "bin"
    d.mkdir()
    monkeypatch.setenv("PATH", str(d))
    mediatools._encodes_webp.cache_clear()
    return d


WEBP = " V....D libwebp_anim         libwebp WebP image (codec webp)\n V....D libwebp              libwebp WebP image (codec webp)"


@pytest.mark.parametrize("platform, cmds", [
    ("darwin", ["brew install ffmpeg-full", "brew install poppler"]),
    ("linux", ["sudo apt-get install -y ffmpeg poppler-utils"]),
])
def test_nothing_installed(bin_dir, monkeypatch, platform, cmds):
    monkeypatch.setattr(mediatools.sys, "platform", platform)
    st = mediatools.status()
    assert st == {"ok": False, "ffmpeg": {"path": None, "webp": False}, "pdftoppm": {"path": None},
                  "missing": ["ffmpeg", "pdftoppm"], "install": cmds}


def test_an_ffmpeg_without_the_webp_encoder_is_not_enough(bin_dir, monkeypatch):
    """Homebrew's ffmpeg: installed, but thumbnails (-c:v libwebp) fail; ffmpeg-full has the encoder."""
    monkeypatch.setattr(mediatools.sys, "platform", "darwin")
    _tool(bin_dir, "ffmpeg", " V....D libx264  libx264 H.264")
    _tool(bin_dir, "pdftoppm")
    st = mediatools.status()
    assert st["ffmpeg"] == {"path": str(bin_dir / "ffmpeg"), "webp": False} and st["missing"] == ["ffmpeg_webp"]
    assert st["install"] == ["brew install ffmpeg-full"] and st["ok"] is False


def test_everything_ready(bin_dir):
    _tool(bin_dir, "ffmpeg", WEBP)
    _tool(bin_dir, "pdftoppm")
    st = mediatools.status()
    assert st["ok"] is True and st["missing"] == [] and st["install"] == [] and st["ffmpeg"]["webp"] is True
    c = cmd_core.check_media_tools()
    assert c["level"] == cmd_core.OK and c["detail"] == str(bin_dir / "ffmpeg")


def test_doctor_names_what_is_missing_and_the_command(bin_dir, monkeypatch):
    monkeypatch.setattr(mediatools.sys, "platform", "darwin")
    _tool(bin_dir, "ffmpeg", "no encoder of interest")
    c = cmd_core.check_media_tools()
    assert c["level"] == cmd_core.WARN and "WebP" in c["title"] and "pdftoppm" in c["title"]
    assert c["fix"].startswith("brew install ffmpeg-full && brew install poppler")


def test_start_warns_in_the_server_log(bin_dir, caplog):
    with caplog.at_level(logging.WARNING, logger="maxxing.mediatools"):
        mediatools.log_missing()
    text = caplog.text
    assert "ffmpeg is not installed" in text and "pdftoppm is not installed" in text and "then restart" in text
    _tool(bin_dir, "ffmpeg", WEBP)
    _tool(bin_dir, "pdftoppm")
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="maxxing.mediatools"):
        mediatools.log_missing()
    assert caplog.text == ""


def test_media_tools_route(client, bin_dir, monkeypatch):  # noqa: F811
    monkeypatch.setattr(mediatools.sys, "platform", "darwin")
    _tool(bin_dir, "pdftoppm")
    r = client.get("/api/system/media-tools")
    assert r.status_code == 200
    assert r.json()["missing"] == ["ffmpeg"] and r.json()["install"] == ["brew install ffmpeg-full"]
