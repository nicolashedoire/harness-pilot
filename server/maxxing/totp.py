"""Two-step sign-in with an authenticator app (TOTP, RFC 6238): Settings -> Security, `pilot 2fa`.

- Enrolment: `begin()` makes a pending secret (secrets.json `totp_pending`, PENDING_TTL s) shown as a QR code and as
  text; `confirm(code)` turns it on once the app gives a matching code, and returns RECOVERY_COUNT single-use
  recovery codes, shown once.
- Storage: secrets.json `totp` = {secret, last_step, recovery: [sha256 hex], enabled_at}. secrets.json is the
  existing vault (mode 600, like the password hash and the Telegram token); recovery codes are only kept hashed.
- `verify(code)`: HMAC-SHA1, 6 digits, 30 s steps, one step of clock drift either way. A code whose time step is
  not after the last accepted one is refused (the same code never signs in twice, even within its 30 s). A
  recovery code works once. Wrong codes are throttled by the callers (twofactor.check, the re-authentication of
  api/auth).
- Off: `disable()` (Settings, with password and code) or `pilot 2fa off` over SSH (the way out).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import struct
import time
from urllib.parse import quote, urlencode

from . import config

STEP = 30
DIGITS = 6
DRIFT = 1                      # steps accepted before / after the current one
PENDING_TTL = 600              # an enrolment not confirmed within 10 min starts again
RECOVERY_COUNT = 10
ISSUER = "harness-pilot"
_CODE_RE = re.compile(r"[0-9]{6}")
_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
_RECOVERY_RE = re.compile(r"[A-Z2-7]{16}")


class TotpError(Exception):
    def __init__(self, error: str, message: str):
        super().__init__(message)
        self.error = error
        self.message = message


# ---- RFC 4226 / 6238 -----------------------------------------------------------------------
def hotp(key: bytes, counter: int, digits: int = DIGITS) -> str:
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    value = struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF
    return str(value % 10 ** digits).zfill(digits)


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def step_at(t: float) -> int:
    return int(t // STEP)


def code_at(secret: str, t: float) -> str:
    return hotp(_key(secret), step_at(t))


def _match(secret: str, code: str, now: float) -> int | None:
    """The time step `code` belongs to (current one +- DRIFT), else None. Every candidate is compared."""
    key, found = _key(secret), None
    cur = step_at(now)
    for s in range(cur - DRIFT, cur + DRIFT + 1):
        if hmac.compare_digest(hotp(key, s).encode(), code.encode()):
            found = s
    return found


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")      # 160 bits, RFC 4226


def uri(secret: str, label: str) -> str:
    """otpauth:// link of the QR code (Google Authenticator key URI format)."""
    name = quote(f"{ISSUER}:{label}" if label else ISSUER, safe=":@")
    return f"otpauth://totp/{name}?" + urlencode({"secret": secret, "issuer": ISSUER, "algorithm": "SHA1",
                                                  "digits": DIGITS, "period": STEP})


# ---- recovery codes ------------------------------------------------------------------------
def _normal_recovery(code: str) -> str:
    """'abcd-efgh 2345-6701' -> 'ABCDEFGH23456701' with the look-alikes typed by hand (0 -> O, 1 -> I, 8 -> B)."""
    s = re.sub(r"[\s-]", "", code or "").upper()
    return s.translate(str.maketrans("018", "OIB"))


def _hash_recovery(code: str) -> str:
    return hashlib.sha256(("harness-pilot-recovery:" + code).encode()).hexdigest()


def _new_recovery() -> list[str]:
    codes = ["".join(secrets.choice(_B32) for _ in range(16)) for _ in range(RECOVERY_COUNT)]   # 80 bits each
    return ["-".join(c[i:i + 4] for i in range(0, 16, 4)) for c in codes]


# ---- state ---------------------------------------------------------------------------------
def _state() -> dict:
    v = config.load_secrets().get("totp")
    return v if isinstance(v, dict) and isinstance(v.get("secret"), str) and v["secret"] else {}


def _pending() -> dict:
    v = config.load_secrets().get("totp_pending")
    if not isinstance(v, dict) or not isinstance(v.get("secret"), str):
        return {}
    try:
        fresh = 0 <= time.time() - float(v.get("created") or 0) < PENDING_TTL
    except (TypeError, ValueError):
        fresh = False
    return v if fresh else {}


def is_on() -> bool:
    return bool(_state())


def status() -> dict:
    st = _state()
    rec = st.get("recovery") if isinstance(st.get("recovery"), list) else []
    return {"enabled": bool(st), "recovery_left": len(rec) if st else 0, "pending": not st and bool(_pending()),
            "enabled_at": st.get("enabled_at") if st else None}


def begin(label: str = "") -> dict:
    """A new pending secret (replaces an earlier pending one). Raises TotpError("already_on")."""
    with config._lock:                                            # noqa: SLF001 - same package
        if is_on():
            raise TotpError("already_on", "The authenticator app is already on - turn it off first")
        secret = new_secret()
        config.set_secret("totp_pending", {"secret": secret, "created": time.time()})
    return {"secret": secret, "uri": uri(secret, label), "expires_in": PENDING_TTL}


def confirm(code: str, now: float | None = None) -> list[str]:
    """Turn it on with a code of the pending secret -> the recovery codes (plain, shown once)."""
    now = time.time() if now is None else now
    given = (code or "").strip().replace(" ", "")
    with config._lock:                                            # noqa: SLF001
        if is_on():
            raise TotpError("already_on", "The authenticator app is already on")
        p = _pending()
        if not p:
            raise TotpError("expired", "The setup expired - start it again")
        step = _match(p["secret"], given, now) if _CODE_RE.fullmatch(given) else None
        if step is None:
            raise TotpError("bad_code", "Wrong code")
        codes = _new_recovery()
        config.set_secrets({"totp": {"secret": p["secret"], "last_step": step, "enabled_at": time.time(),
                                     "recovery": [_hash_recovery(_normal_recovery(c)) for c in codes]},
                            "totp_pending": None})
    return codes


def verify(code: str, now: float | None = None) -> str | None:
    """'totp' (a fresh code of the app), 'recovery' (a recovery code, now used up) or None. Atomic: two requests
    with the same code cannot both pass."""
    now = time.time() if now is None else now
    given = (code or "").strip().replace(" ", "")
    with config._lock:                                            # noqa: SLF001
        st = _state()
        if not st:
            return None
        if _CODE_RE.fullmatch(given):
            step = _match(st["secret"], given, now)
            try:
                last = int(st.get("last_step") or 0)
            except (TypeError, ValueError):
                last = 0
            if step is None or step <= last:                     # replay: this step (or an older one) was used
                return None
            config.set_secret("totp", {**st, "last_step": step})
            return "totp"
        rec = _normal_recovery(given)
        if not _RECOVERY_RE.fullmatch(rec):
            return None
        h = _hash_recovery(rec)
        hashes = [x for x in (st.get("recovery") or []) if isinstance(x, str)]
        hit = next((x for x in hashes if hmac.compare_digest(x.encode(), h.encode())), None)
        if hit is None:
            return None
        config.set_secret("totp", {**st, "recovery": [x for x in hashes if x != hit]})
        return "recovery"


def regenerate(code: str, now: float | None = None) -> list[str]:
    """A new set of recovery codes (plain, shown once) once `code` verifies - a code of the app, or a recovery code,
    which is spent. Every earlier recovery code stops working; the secret is unchanged."""
    with config._lock:                                            # noqa: SLF001
        if not is_on():
            raise TotpError("not_on", "The authenticator app is off")
        if verify(code, now) is None:
            raise TotpError("bad_code", "Wrong code")
        codes = _new_recovery()
        config.set_secret("totp", {**_state(), "recovery": [_hash_recovery(_normal_recovery(c)) for c in codes]})
    return codes


def disable(code: str | None = None, now: float | None = None) -> None:
    """Off. With `code` (Settings): only when it verifies - a code of the app or a recovery code - else
    TotpError("bad_code"). Without (`pilot 2fa off` over SSH): at once."""
    with config._lock:                                            # noqa: SLF001
        if code is not None and verify(code, now) is None:
            raise TotpError("bad_code", "Wrong code")
        config.set_secrets({"totp": None, "totp_pending": None})
