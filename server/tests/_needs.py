"""Skip marks for tests that need something of the machine they run on. Each one checks the feature itself, never
the name of the system: the tests run wherever the feature exists (Linux servers, CI) and skip where it does not
(a Mac with the system bash 3.2, APFS, no /proc, a ffmpeg built without libwebp)."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile

import pytest


def _bash_major(path: str = "/usr/bin:/bin") -> int:
    """Major version of the `bash` the installer tests run (they call `bash` with PATH=/usr/bin:/bin)."""
    bash = shutil.which("bash", path=path)
    if not bash:
        return 0
    try:
        r = subprocess.run([bash, "-c", 'echo "${BASH_VERSINFO[0]}"'], capture_output=True, text=True, timeout=10)
        return int(r.stdout.strip())
    except (OSError, subprocess.SubprocessError, ValueError):
        return 0


def _accepts_non_utf8_names() -> bool:
    """The file system of the temporary folder (where tmp_path lives) stores a name that is not UTF-8 (APFS
    refuses it with EILSEQ)."""
    with tempfile.TemporaryDirectory() as d:
        try:
            os.close(os.open(os.fsencode(d) + b"/caf\xe9", os.O_CREAT | os.O_WRONLY, 0o600))
        except OSError:
            return False
        return True


def _ffmpeg_encodes_webp() -> bool:
    """ffmpeg is installed with the libwebp encoder (thumbnails and previews are WebP)."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    try:
        r = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(re.search(r"\blibwebp\b", r.stdout))


# install.sh declares an associative array (`declare -A`): sourcing it needs bash 4 or newer
bash4 = pytest.mark.skipif(_bash_major() < 4, reason="install.sh needs bash >= 4 (bash on /usr/bin:/bin is older)")
non_utf8_names = pytest.mark.skipif(not _accepts_non_utf8_names(),
                                    reason="the file system of the temporary folder refuses non-UTF-8 names")
proc_fd = pytest.mark.skipif(not os.path.isdir("/proc/self/fd"), reason="no /proc/self/fd")
ffmpeg_webp = pytest.mark.skipif(not _ffmpeg_encodes_webp(), reason="ffmpeg with the libwebp encoder not installed")
