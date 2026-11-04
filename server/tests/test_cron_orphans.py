"""A run killed before its end leaves its job shell running: the next run of the job stops that orphan only when it
is still the same process (its start time, not only its number). Without /proc (macOS) the identity comes from `ps`."""
import json
import os
import subprocess
import time

import pytest

from _org_helpers import org  # noqa: F401
from maxxing import crons


@pytest.fixture(params=["platform", "ps"])
def identity(request, monkeypatch, tmp_path):
    """The identity method of this machine, and the `ps` one (what macOS uses) everywhere."""
    if request.param == "ps":
        monkeypatch.setattr(crons, "BOOT_ID", tmp_path / "no-proc" / "boot_id")
    return request.param


def test_process_identity_is_stable_and_none_for_a_dead_process(identity):
    me = crons._proc_start(os.getpid())
    assert isinstance(me, str) and me and me == crons._proc_start(os.getpid())
    if identity == "ps":
        assert me.startswith("ps:")
    gone = subprocess.Popen(["true"])
    gone.wait()
    assert crons._proc_start(gone.pid) is None
    assert crons._proc_start(0) is None and crons._proc_start(-1) is None and crons._proc_start(True) is None


def test_orphan_job_shell_is_stopped_only_when_it_is_the_same_process(org, monkeypatch, identity):
    monkeypatch.setattr(crons, "_notify", lambda job, run, answer=None: None)
    j = crons.create_job({"name": "big", "command": "true"})
    lock = crons._lock_path(j["id"])
    orphan = subprocess.Popen(["sleep", "600"], start_new_session=True)
    try:
        # same number, another start: never killed (the number may belong to anything now)
        lock.write_text(json.dumps({"pid": 999999, "at": time.time() - 5, "pgid": orphan.pid,
                                    "pgid_start": "ps:Thu Jan  1 00:00:00 1970"}))
        crons.run_job(j["id"])
        assert orphan.poll() is None
        mark = crons._proc_start(orphan.pid)
        assert mark is not None
        lock.write_text(json.dumps({"pid": 999999, "at": time.time() - 5, "pgid": orphan.pid, "pgid_start": mark}))
        assert crons.run_job(j["id"])["ok"]
        assert orphan.wait(timeout=5) == -9
        interrupted = [r for r in crons.read_runs(j["id"]) if not r["ok"]]
        assert len(interrupted) == 2 and all("interrupted" in r["output_tail"] for r in interrupted)
    finally:
        if orphan.poll() is None:
            orphan.kill()
