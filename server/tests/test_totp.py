"""Two-step sign-in with an authenticator app (maxxing/totp.py, /api/auth/totp*, /api/auth/two-factor)."""
from __future__ import annotations

import base64
import time

import pytest

from maxxing import config, security, totp, twofactor

PASSWORD = "correct horse battery"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    twofactor.reset()
    with security._fails_lock:                       # noqa: SLF001 - throttles are per process
        security._fails.clear()                      # noqa: SLF001
    real_end = security.end_attempt
    monkeypatch.setattr(security, "end_attempt", lambda key, ok: real_end(key, ok) and 0.0)   # no 1-8 s waits
    yield
    twofactor.reset()


def _on(now: float | None = None) -> tuple[str, list[str]]:
    secret = totp.begin("me")["secret"]
    now = time.time() if now is None else now
    return secret, totp.confirm(totp.code_at(secret, now - totp.STEP), now)


# ---- RFC 6238 ------------------------------------------------------------------------------
@pytest.mark.parametrize("t,code", [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"),
                                    (1234567890, "89005924"), (2000000000, "69279037"), (20000000000, "65353130")])
def test_rfc6238_sha1_vectors(t, code):
    assert totp.hotp(b"12345678901234567890", totp.step_at(t), digits=8) == code


def test_the_secret_and_the_link_of_the_qr_code():
    secret = totp.new_secret()
    assert len(base64.b32decode(secret + "=" * (-len(secret) % 8))) == 20
    u = totp.uri(secret, "me@example.com")
    assert u.startswith("otpauth://totp/harness-pilot:me%40example.com?") or u.startswith("otpauth://totp/harness-pilot:me@example.com?")
    assert f"secret={secret}" in u and "issuer=harness-pilot" in u and "digits=6" in u and "period=30" in u


# ---- enrolment -----------------------------------------------------------------------------
def test_enrolment_needs_a_code_of_the_new_secret(mx):
    st = totp.begin("me")
    assert totp.status() == {"enabled": False, "recovery_left": 0, "pending": True, "enabled_at": None}
    with pytest.raises(totp.TotpError) as e:
        totp.confirm("000000" if totp.code_at(st["secret"], time.time()) != "000000" else "111111")
    assert e.value.error == "bad_code" and not totp.is_on()
    codes = totp.confirm(totp.code_at(st["secret"], time.time()))
    assert len(codes) == totp.RECOVERY_COUNT == len(set(codes))
    s = config.load_secrets()
    assert s["totp"]["secret"] == st["secret"] and "totp_pending" not in s
    assert not any(c in str(s) or c.replace("-", "") in str(s) for c in codes)      # only hashes are kept
    assert totp.status()["enabled"] and totp.status()["recovery_left"] == 10
    with pytest.raises(totp.TotpError) as e:
        totp.begin("me")
    assert e.value.error == "already_on"


def test_an_old_pending_secret_expires(mx, monkeypatch):
    st = totp.begin("me")
    code = totp.code_at(st["secret"], time.time())
    real = time.time
    monkeypatch.setattr(totp.time, "time", lambda: real() + totp.PENDING_TTL + 1)
    with pytest.raises(totp.TotpError) as e:
        totp.confirm(code, now=real())
    assert e.value.error == "expired" and not totp.is_on()


# ---- verification --------------------------------------------------------------------------
def test_time_window_is_one_step_either_way(mx):
    now = 1_800_000_015.0
    secret, _ = _on(now - 10 * totp.STEP)
    assert totp.verify(totp.code_at(secret, now - 2 * totp.STEP), now) is None      # too old
    assert totp.verify(totp.code_at(secret, now + 2 * totp.STEP), now) is None      # too far ahead
    assert totp.verify(totp.code_at(secret, now - totp.STEP), now) == "totp"        # drift accepted
    assert totp.verify(totp.code_at(secret, now + totp.STEP), now) == "totp"


def test_the_same_code_is_refused_the_second_time(mx):
    now = 1_800_000_015.0
    secret, _ = _on(now - 10 * totp.STEP)
    code = totp.code_at(secret, now)
    assert totp.verify(code, now) == "totp"
    assert totp.verify(code, now) is None                                           # replay, same 30 s
    assert totp.verify(code, now + 5) is None
    assert totp.verify(totp.code_at(secret, now - totp.STEP), now) is None          # an older step after a newer one
    assert totp.verify(totp.code_at(secret, now + totp.STEP), now + totp.STEP) == "totp"


def test_the_code_of_the_enrolment_cannot_sign_in(mx):
    now = 1_800_000_015.0
    st = totp.begin("me")
    code = totp.code_at(st["secret"], now)
    totp.confirm(code, now)
    assert totp.verify(code, now) is None


def test_recovery_codes_work_once(mx):
    _, codes = _on()
    assert totp.verify(codes[0]) == "recovery"
    assert totp.verify(codes[0]) is None
    assert totp.verify(codes[1].lower().replace("-", " ")) == "recovery"            # typed by hand
    assert totp.status()["recovery_left"] == 8
    assert totp.verify("AAAA-AAAA-AAAA-AAAA") is None and totp.verify("") is None and totp.verify("12345") is None


def test_nothing_verifies_while_off(mx):
    secret, codes = _on()
    totp.disable()
    assert not totp.is_on() and totp.verify(totp.code_at(secret, time.time() + totp.STEP)) is None
    assert totp.verify(codes[0]) is None and "totp" not in config.load_secrets()


# ---- sign-in -------------------------------------------------------------------------------
def _signed_out(client):
    client.cookies.clear()
    return client


def test_sign_in_with_the_app(client, mx):
    secret, _ = _on()
    c = _signed_out(client)
    r = c.post("/api/auth/login", json={"password": PASSWORD}).json()
    assert r["ok"] is False and r["two_factor"]["methods"] == ["totp"]
    assert security.COOKIE not in c.cookies
    ch = r["two_factor"]["challenge"]
    assert c.post("/api/auth/two-factor", json={"challenge": ch}).json()["status"] == "pending"
    bad = c.post("/api/auth/two-factor", json={"challenge": ch, "code": "abc"})
    assert bad.status_code == 400 and bad.json()["error"] == "bad_code"
    r = c.post("/api/auth/two-factor", json={"challenge": ch, "code": totp.code_at(secret, time.time() + totp.STEP)})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert c.cookies.get(security.COOKIE) and c.cookies.get(twofactor.DEVICE_COOKIE)
    assert c.get("/api/auth/state").json()["authenticated"]
    assert c.post("/api/auth/two-factor", json={"challenge": ch}).status_code == 410        # consumed
    # a trusted browser signs in with the password alone
    c.cookies.delete(security.COOKIE)
    assert c.post("/api/auth/login", json={"password": PASSWORD}).json() == {"ok": True}


def test_sign_in_refuses_a_replayed_code_and_takes_a_recovery_code(client, mx):
    secret, codes = _on()
    code = totp.code_at(secret, time.time() + totp.STEP)
    assert totp.verify(code) == "totp"                                               # used once already
    c = _signed_out(client)
    ch = c.post("/api/auth/login", json={"password": PASSWORD}).json()["two_factor"]["challenge"]
    r = c.post("/api/auth/two-factor", json={"challenge": ch, "code": code, "trust": False})
    assert r.status_code == 400 and r.json()["error"] == "bad_code"
    r = c.post("/api/auth/two-factor", json={"challenge": ch, "code": codes[3], "trust": False})
    assert r.json()["status"] == "approved" and not c.cookies.get(twofactor.DEVICE_COOKIE)
    assert totp.status()["recovery_left"] == 9
    c.cookies.clear()
    ch = c.post("/api/auth/login", json={"password": PASSWORD}).json()["two_factor"]["challenge"]
    assert c.post("/api/auth/two-factor", json={"challenge": ch, "code": codes[3]}).status_code == 400


def test_wrong_codes_end_the_request_then_pause_every_code(client, mx):
    _on()
    c = _signed_out(client)
    ch = c.post("/api/auth/login", json={"password": PASSWORD}).json()["two_factor"]["challenge"]
    for _ in range(twofactor.CODE_TRIES - 1):
        assert c.post("/api/auth/two-factor", json={"challenge": ch, "code": "000000"}).status_code in (400,)
    assert c.post("/api/auth/two-factor", json={"challenge": ch, "code": "000000"}).status_code == 410
    with twofactor._lock:                                                           # noqa: SLF001
        twofactor._bad[:] = [time.time()] * twofactor.BAD_MAX                       # noqa: SLF001
    twofactor._new.clear()                                                          # noqa: SLF001
    ch = c.post("/api/auth/login", json={"password": PASSWORD}).json()["two_factor"]["challenge"]
    r = c.post("/api/auth/two-factor", json={"challenge": ch, "code": "123456"})
    assert r.status_code == 429 and r.json()["error"] == "codes_paused"


# ---- settings ------------------------------------------------------------------------------
def test_turn_on_from_the_settings_needs_the_password_and_a_code(client, mx):
    assert client.get("/api/auth/totp").json()["enabled"] is False
    st = client.post("/api/auth/totp/setup").json()
    assert st["uri"].startswith("otpauth://totp/") and st["secret"]
    code = totp.code_at(st["secret"], time.time())
    r = client.post("/api/auth/totp/enable", json={"password": "wrong password!", "code": code})
    assert r.status_code == 401 and not totp.is_on()
    r = client.post("/api/auth/totp/enable", json={"password": PASSWORD, "code": "000000" if code != "000000" else "111111"})
    assert r.status_code == 400 and r.json()["error"] == "bad_code" and not totp.is_on()
    r = client.post("/api/auth/totp/enable", json={"password": PASSWORD, "code": code})
    assert r.status_code == 200 and len(r.json()["recovery_codes"]) == totp.RECOVERY_COUNT
    assert client.cookies.get(twofactor.DEVICE_COOKIE)                               # this browser stays trusted
    assert client.get("/api/auth/totp").json() == {**totp.status(), "enabled": True}
    assert client.post("/api/auth/totp/setup").status_code == 409


def test_turn_off_needs_the_password_and_a_code(client, mx):
    secret, codes = _on()
    r = client.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": "000000"})
    assert r.status_code == 400 and totp.is_on()
    r = client.post("/api/auth/totp/disable", json={"password": "wrong password!", "code": codes[0]})
    assert r.status_code == 401 and totp.is_on() and totp.status()["recovery_left"] == 10   # code not spent
    r = client.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": codes[0]})
    assert r.status_code == 200 and not totp.is_on()


def test_the_settings_routes_need_a_session(client, mx):
    c = _signed_out(client)
    assert c.get("/api/auth/totp").status_code == 401
    assert c.post("/api/auth/totp/setup").status_code == 401
    assert c.post("/api/auth/totp/enable", json={"password": PASSWORD, "code": "123456"}).status_code == 401
    assert c.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": "123456"}).status_code == 401


def test_re_authentication_is_throttled(client, mx):
    _on()
    for _ in range(security.FAIL_MAX):
        client.post("/api/auth/totp/disable", json={"password": "wrong password!", "code": "000000"})
    r = client.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": "000000"})
    assert r.status_code == 429 and totp.is_on()


def test_the_cli_way_out_turns_the_app_off_too(mx, capsys):
    from maxxing import cli
    _on()
    assert cli.main(["2fa", "status", "--json"]) == 0
    assert '"authenticator": true' in capsys.readouterr().out
    assert cli.main(["2fa", "off"]) == 0
    assert not totp.is_on()


def test_new_recovery_codes_replace_the_old_ones(mx):
    now = 1_800_000_015.0
    secret, old = _on(now - 10 * totp.STEP)
    with pytest.raises(totp.TotpError) as e:
        totp.regenerate("000000" if totp.code_at(secret, now) != "000000" else "111111", now)
    assert e.value.error == "bad_code" and totp.status()["recovery_left"] == 10
    new = totp.regenerate(totp.code_at(secret, now), now)
    assert len(new) == totp.RECOVERY_COUNT and not set(new) & set(old)
    assert totp.verify(old[1]) is None                                              # the old set is dead
    assert totp.verify(new[0]) == "recovery" and totp.status()["recovery_left"] == 9
    assert config.load_secrets()["totp"]["secret"] == secret                         # the app keeps working
    newer = totp.regenerate(new[1], now)                                             # a recovery code works too (spent)
    assert totp.verify(new[2]) is None and len(newer) == 10
    totp.disable()
    with pytest.raises(totp.TotpError) as e:
        totp.regenerate(newer[0], now)
    assert e.value.error == "not_on"


def test_new_recovery_codes_from_the_settings(client, mx):
    secret, old = _on()
    path = "/api/auth/totp/recovery-codes"
    assert client.post(path, json={"password": "wrong password!", "code": old[0]}).status_code == 401
    assert totp.status()["recovery_left"] == 10                                     # nothing spent on a wrong password
    assert client.post(path, json={"password": PASSWORD, "code": "000000"}).status_code == 400
    r = client.post(path, json={"password": PASSWORD, "code": totp.code_at(secret, time.time() + totp.STEP)})
    assert r.status_code == 200 and len(r.json()["recovery_codes"]) == 10
    assert totp.verify(old[0]) is None and totp.verify(r.json()["recovery_codes"][0]) == "recovery"
    c = _signed_out(client)
    assert c.post(path, json={"password": PASSWORD, "code": "123456"}).status_code == 401
    totp.disable()
    client.cookies.set(security.COOKIE, security.make_cookie())
    assert client.post(path, json={"password": PASSWORD, "code": "123456"}).status_code == 409
