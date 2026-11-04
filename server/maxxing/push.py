"""Web Push for the notifications feed: browsers subscribe (service worker + PushManager), the server sends them the
new feed events their preferences ask for. See docs/dev/API.md#web-push.

- VAPID (RFC 8292): one P-256 key pair, made on first use, in <state>/push-vapid.json (mode 600). The public key is
  the browser's `applicationServerKey`; each request carries `Authorization: vapid t=<ES256 JWT>, k=<public key>`.
- Payload encryption (RFC 8291, `Content-Encoding: aes128gcm`): ECDH with the subscription's `p256dh`, HKDF with its
  `auth` secret, AES-128-GCM, one record. Only ECDH / ECDSA / AES-GCM come from `cryptography`; HKDF is hmac.
- Subscriptions in <state>/push.json (mode 600): {subs: [{id, endpoint, keys: {p256dh, auth}, label, created, last_ok,
  last_error, prefs: {levels, sound, kinds: {<kind>: {enabled, sound}}}}]}. A push service answering 404 / 410 means
  the subscription is gone: removed. The payload says `silent` when the kind (or the default) has no sound. Quiet
  events (`maxxing feed post --quiet`) are never pushed.
- dispatch() is called by the server's feed watcher (api/feed.py, in a thread) after any change of feed.db: it sends
  the rows added since the last pass (any process may have written them: cron runs, `maxxing feed post`). Rows that
  were there when the server started are never sent (prime()).
Blocking module: call it through asyncio.to_thread from async code. Tests replace `http_transport`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets as _secrets
import struct
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import config, feed

log = logging.getLogger("maxxing.push")

TTL_S = 24 * 3600
TIMEOUT_S = 10.0
JWT_TTL_S = 12 * 3600
RECORD_SIZE = 4096
PAYLOAD_MAX = 3000                       # bytes of JSON before encryption (push services accept 4096 in total)
BODY_MAX = 500
SUBS_MAX = 50
LABEL_MAX = 80
PREF_KINDS_MAX = 200
DEFAULT_PREFS: dict = {"levels": ["warning", "error"], "sound": True, "kinds": {}}
DISPATCH_BATCH = 50
http_transport: Any = None               # tests: httpx.MockTransport

_lock = config.ProcessLock("push")       # read-modify-write of push.json / the key file
_cursor: dict = {"id": None}
_cursor_lock = threading.Lock()


class PushError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def available() -> bool:
    """The server can encrypt payloads (the `cryptography` package is installed)."""
    try:
        import cryptography.hazmat.primitives.asymmetric.ec  # noqa: F401
        import cryptography.hazmat.primitives.ciphers.aead  # noqa: F401
    except ImportError:
        return False
    return True


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    s = (s or "").strip().replace("+", "-").replace("/", "_")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _keys_path() -> Path:
    return config.STATE / "push-vapid.json"


def _subs_path() -> Path:
    return config.STATE / "push.json"


# ---- VAPID keys ----------------------------------------------------------------------------
def _private_key():
    """The VAPID private key, made (and saved, mode 600) on first use."""
    from cryptography.hazmat.primitives.asymmetric import ec
    d = config.read_json(_keys_path(), {})
    if isinstance(d, dict) and d.get("private"):
        try:
            return ec.derive_private_key(int.from_bytes(_b64d(d["private"]), "big"), ec.SECP256R1())
        except (ValueError, TypeError):
            log.warning("push: %s is damaged, making a new VAPID key (subscriptions must be renewed)", _keys_path())
    with _lock:
        d = config.read_json(_keys_path(), {})        # made by another thread / process meanwhile
        if isinstance(d, dict) and d.get("private"):
            try:
                return ec.derive_private_key(int.from_bytes(_b64d(d["private"]), "big"), ec.SECP256R1())
            except (ValueError, TypeError):
                pass
        key = ec.generate_private_key(ec.SECP256R1())
        raw = key.private_numbers().private_value.to_bytes(32, "big")
        config.state_dir()
        config.write_json(_keys_path(), {"private": _b64e(raw), "public": _public_b64(key), "created": time.time()},
                          mode=0o600)
        return key


def _public_b64(key) -> str:
    from cryptography.hazmat.primitives import serialization
    return _b64e(key.public_key().public_bytes(serialization.Encoding.X962,
                                               serialization.PublicFormat.UncompressedPoint))


def public_key() -> str | None:
    """The `applicationServerKey` (base64url, uncompressed P-256 point), or None when push is not available."""
    if not available():
        return None
    return _public_b64(_private_key())


def vapid_header(endpoint: str, now: float | None = None) -> str:
    """`Authorization` header for one push request (RFC 8292)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    key = _private_key()
    u = urlsplit(endpoint)
    claims = {"aud": f"{u.scheme}://{u.netloc}", "exp": int((now or time.time()) + JWT_TTL_S), "sub": _contact()}
    head = _b64e(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    body = _b64e(json.dumps(claims, separators=(",", ":")).encode())
    signing = f"{head}.{body}".encode()
    r, s = decode_dss_signature(key.sign(signing, ec.ECDSA(hashes.SHA256())))
    sig = _b64e(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={head}.{body}.{sig}, k={_public_b64(key)}"


def _contact() -> str:
    """The `sub` claim: who to contact about this sender (push services may refuse a token without one)."""
    cfg = config.load_config()
    c = str(cfg.get("push_contact") or "").strip()
    if c.startswith(("mailto:", "https://")):
        return c
    url = str(cfg.get("public_url") or "").strip().rstrip("/")
    return url if url.startswith("https://") else "mailto:admin@example.com"


# ---- encryption (RFC 8291) -----------------------------------------------------------------
def _hmac(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


def encrypt(plaintext: bytes, p256dh: str, auth: str, *, salt: bytes | None = None, private_key=None) -> bytes:
    """aes128gcm body for one subscription: header (salt, record size, sender key) + one encrypted record.
    `salt` / `private_key` are only given by tests (RFC 8291 appendix A)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    ua_public = _b64d(p256dh)
    secret = _b64d(auth)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    as_key = private_key or ec.generate_private_key(ec.SECP256R1())
    as_public = as_key.public_key().public_bytes(serialization.Encoding.X962,
                                                 serialization.PublicFormat.UncompressedPoint)
    shared = as_key.exchange(ec.ECDH(), ua_key)
    salt = salt or os.urandom(16)
    # HKDF(auth, ecdh, "WebPush: info" || 0 || ua_public || as_public, 32), then HKDF(salt, ikm, ...) for key / nonce
    prk_key = _hmac(secret, shared)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    record = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)    # 0x02: last (and only) record, no padding
    return salt + struct.pack("!IB", RECORD_SIZE, len(as_public)) + as_public + record


# ---- subscriptions -------------------------------------------------------------------------
def _load() -> list[dict]:
    d = config.read_json(_subs_path(), {})
    subs = d.get("subs") if isinstance(d, dict) else None
    return [s for s in subs if isinstance(s, dict) and s.get("id")] if isinstance(subs, list) else []


def _save(subs: list[dict]) -> None:
    config.state_dir()
    config.write_json(_subs_path(), {"subs": subs}, mode=0o600)


def _public(s: dict) -> dict:
    return {"id": s["id"], "endpoint": s.get("endpoint", ""), "label": s.get("label", ""),
            "created": s.get("created"), "last_ok": s.get("last_ok"), "last_error": s.get("last_error"),
            "prefs": _prefs(s.get("prefs"), strict=False)}


def _kind_pref(v: Any, sound: bool) -> dict:
    """{enabled, sound} of one kind; a bare boolean (older clients) = enabled, with the default sound."""
    if isinstance(v, bool):
        return {"enabled": v, "sound": sound}
    if not isinstance(v, dict) or not isinstance(v.get("enabled", True), bool) \
            or not isinstance(v.get("sound", sound), bool) or set(v) - {"enabled", "sound"}:
        raise ValueError("prefs.kinds: {<kind>: {enabled: bool, sound: bool}}")
    return {"enabled": v.get("enabled", True), "sound": v.get("sound", sound)}


def _prefs(p: Any, base: dict | None = None, strict: bool = True) -> dict:
    """{levels: [...], sound: bool, kinds: {kind: {enabled, sound}}}; fields left out keep `base`'s (DEFAULT_PREFS).
    `kinds` given replaces the whole map."""
    base = base or DEFAULT_PREFS
    if p is None:
        p = {}
    try:
        if not isinstance(p, dict):
            raise ValueError("prefs: {levels, sound, kinds}")
        levels = p.get("levels", base.get("levels", DEFAULT_PREFS["levels"]))
        sound = p.get("sound", base.get("sound", True))
        kinds = p.get("kinds", base.get("kinds") or {})
        if not isinstance(levels, list) or any(x not in feed.LEVELS for x in levels):
            raise ValueError(f"prefs.levels: some of {', '.join(feed.LEVELS)}")
        if not isinstance(sound, bool):
            raise ValueError("prefs.sound: true or false")
        if not isinstance(kinds, dict) or len(kinds) > PREF_KINDS_MAX \
                or any(not isinstance(k, str) or not feed.KIND_RE.match(k) for k in kinds):
            raise ValueError("prefs.kinds: {<kind>: {enabled: bool, sound: bool}}")
        kinds = {k: _kind_pref(v, sound) for k, v in kinds.items()}
    except ValueError as e:
        if strict:
            raise PushError(400, "bad_prefs", str(e)) from None
        return {"levels": list(DEFAULT_PREFS["levels"]), "sound": True, "kinds": {}}
    return {"levels": [x for x in feed.LEVELS if x in levels], "sound": sound, "kinds": kinds}


def _check_keys(endpoint: Any, keys: Any) -> tuple[str, dict]:
    if not isinstance(endpoint, str) or not endpoint.startswith("https://") or len(endpoint) > 2000 \
            or any(c.isspace() for c in endpoint) or not urlsplit(endpoint).netloc:
        raise PushError(400, "bad_subscription", "endpoint: the https:// URL of the push service")
    if not isinstance(keys, dict):
        raise PushError(400, "bad_subscription", "keys: {p256dh, auth}")
    try:
        p256dh, auth = _b64d(str(keys.get("p256dh") or "")), _b64d(str(keys.get("auth") or ""))
        from cryptography.hazmat.primitives.asymmetric import ec
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), p256dh)
        if len(p256dh) != 65 or len(auth) != 16:
            raise ValueError
    except (ValueError, TypeError):
        raise PushError(400, "bad_subscription", "keys.p256dh: a P-256 public key, keys.auth: 16 bytes (base64url)") \
            from None
    return endpoint, {"p256dh": _b64e(p256dh), "auth": _b64e(auth)}


def subscriptions() -> list[dict]:
    return [_public(s) for s in _load()]


def subscribe(endpoint: Any, keys: Any, label: str | None = None, prefs: Any = None) -> dict:
    """Add a browser's subscription, or update it (same endpoint: keys, label and prefs given)."""
    if not available():
        raise PushError(503, "unavailable", "Web Push is not available on this server (cryptography missing)")
    endpoint, keys = _check_keys(endpoint, keys)
    with _lock:
        subs = _load()
        s = next((x for x in subs if x.get("endpoint") == endpoint), None)
        if s is None:
            if len(subs) >= SUBS_MAX:
                subs.sort(key=lambda x: float(x.get("last_ok") or x.get("created") or 0))
                subs = subs[1:]                       # the least recently reached one makes room
            s = {"id": _secrets.token_hex(6), "endpoint": endpoint, "label": "", "created": time.time(),
                 "last_ok": None, "last_error": None, "prefs": _prefs(None)}
            subs.append(s)
        s["keys"] = keys
        if label is not None:
            s["label"] = " ".join(str(label).split())[:LABEL_MAX]
        if prefs is not None:
            s["prefs"] = _prefs(prefs, _prefs(s.get("prefs"), strict=False))
        _save(subs)
    _private_key()                                     # the key exists before the first event to send
    return _public(s)


def update(sid: str, label: str | None = None, prefs: Any = None) -> dict:
    with _lock:
        subs = _load()
        s = next((x for x in subs if x["id"] == sid), None)
        if s is None:
            raise PushError(404, "not_found", "Unknown subscription")
        if label is not None:
            s["label"] = " ".join(str(label).split())[:LABEL_MAX]
        if prefs is not None:
            s["prefs"] = _prefs(prefs, _prefs(s.get("prefs"), strict=False))
        _save(subs)
    return _public(s)


def remove(sid: str) -> None:
    with _lock:
        subs = _load()
        keep = [x for x in subs if x["id"] != sid]
        if len(keep) != len(subs):
            _save(keep)


# ---- sending -------------------------------------------------------------------------------
def wants(prefs: dict | None, ev: dict) -> bool:
    """Never a quiet event. A kind set in prefs.kinds decides (`enabled`); otherwise the event's level must be in
    prefs.levels."""
    if ev.get("quiet"):
        return False
    p = _prefs(prefs, strict=False)
    if ev.get("kind") in p["kinds"]:
        return p["kinds"][ev["kind"]]["enabled"]
    return ev.get("level") in p["levels"]


def sound(prefs: dict | None, ev: dict) -> bool:
    """Whether the notification rings: the kind's `sound`, else the subscription's default."""
    p = _prefs(prefs, strict=False)
    k = p["kinds"].get(ev.get("kind") or "")
    return k["sound"] if k else p["sound"]


def payload(ev: dict, silent: bool = False) -> bytes:
    """What the service worker receives (JSON, cut to fit a push message). `silent` -> showNotification({silent})."""
    data = {"id": ev.get("id"), "at": ev.get("at"), "kind": ev.get("kind") or "custom",
            "params": ev.get("params") or {}, "level": ev.get("level"), "category": ev.get("category"),
            "source": ev.get("source"), "title": ev.get("title", ""), "body": (ev.get("body") or "")[:BODY_MAX],
            "url": ev.get("url") or "", "count": ev.get("count", 1), "actions": ev.get("actions") or [],
            "tag": ev.get("tag") or f"feed-{ev.get('id')}", "silent": bool(silent)}
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    for drop in (("params", {}), ("actions", []), ("body", "")):
        if len(raw) <= PAYLOAD_MAX:
            break
        data[drop[0]] = drop[1]
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    if len(raw) > PAYLOAD_MAX:
        data["title"] = data["title"][:120]
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    return raw


def send(sub: dict, data: bytes, urgency: str = "normal", client=None) -> int:
    """POST one encrypted message to the subscription's push service -> HTTP status (0 = network error)."""
    import httpx
    body = encrypt(data, sub["keys"]["p256dh"], sub["keys"]["auth"])
    headers = {"TTL": str(TTL_S), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
               "Urgency": urgency, "Authorization": vapid_header(sub["endpoint"])}
    own = client is None
    c = client or httpx.Client(timeout=TIMEOUT_S, transport=http_transport, follow_redirects=False)
    try:
        return c.post(sub["endpoint"], content=body, headers=headers).status_code
    except httpx.HTTPError as e:
        log.info("push to %s failed: %s", urlsplit(sub["endpoint"]).netloc, e)
        return 0
    finally:
        if own:
            c.close()


def _record(results: dict[str, int]) -> None:
    """Results of a pass: remove the gone subscriptions (404 / 410), stamp the others."""
    if not results:
        return
    now = time.time()
    with _lock:
        subs = _load()
        keep = []
        for s in subs:
            st = results.get(s["id"])
            if st in (404, 410):
                log.info("push: subscription %s is gone (%s): removed", s["id"], st)
                continue
            if st is not None:
                if 200 <= st < 300:
                    s["last_ok"], s["last_error"] = now, None
                else:
                    s["last_error"] = f"HTTP {st}" if st else "unreachable"
            keep.append(s)
        _save(keep)


def prime() -> None:
    """Start after the rows already in the feed (called when the server starts)."""
    with _cursor_lock:
        _cursor["id"] = feed.max_id()


def dispatch() -> int:
    """Send the rows added since the last pass to the subscriptions that want them -> number of messages sent."""
    with _cursor_lock:
        if _cursor["id"] is None:
            _cursor["id"] = feed.max_id()
            return 0
    sent = 0
    while True:                                    # the watcher only calls again when the feed changes: drain it
        with _cursor_lock:
            rows = feed.new_since(_cursor["id"], DISPATCH_BATCH)
            if not rows:
                return sent
            _cursor["id"] = rows[-1]["id"]
        sent += _send_rows(rows)
        if len(rows) < DISPATCH_BATCH:
            return sent


def _send_rows(rows: list[dict]) -> int:
    subs = _load()
    if not subs or not available():
        return 0
    import httpx
    results: dict[str, int] = {}
    sent = 0
    with httpx.Client(timeout=TIMEOUT_S, transport=http_transport, follow_redirects=False) as client:
        for ev in rows:
            data: dict[bool, bytes] = {}
            for s in subs:
                if results.get(s["id"]) in (404, 410) or not wants(s.get("prefs"), ev):
                    continue
                silent = not sound(s.get("prefs"), ev)
                if silent not in data:
                    data[silent] = payload(ev, silent)
                try:
                    st = send(s, data[silent], "high" if ev.get("level") == "error" else "normal", client)
                except Exception:  # noqa: BLE001 - a damaged subscription never stops the others
                    log.exception("push: cannot send to %s", s["id"])
                    st = 0
                results[s["id"]] = st
                sent += 1 if 200 <= st < 300 else 0
    _record(results)
    return sent


def test(sid: str) -> dict:
    """A test notification to one subscription -> {ok, status}; PushError 502 push_failed otherwise."""
    if not available():
        raise PushError(503, "unavailable", "Web Push is not available on this server (cryptography missing)")
    s = next((x for x in _load() if x["id"] == sid), None)
    if s is None:
        raise PushError(404, "not_found", "Unknown subscription")
    ev = {"id": 0, "at": time.time(), "kind": "push.test", "params": {}, "level": "info", "category": "system",
          "source": "system", "title": "Test notification", "body": "Notifications reach this device.",
          "url": "/feed", "count": 1, "actions": [], "tag": "push-test"}
    st = send(s, payload(ev, silent=not _prefs(s.get("prefs"), strict=False)["sound"]), "normal")
    _record({sid: st})
    if not 200 <= st < 300:
        raise PushError(502, "push_failed", f"The push service answered {st or 'nothing'}", status=st)
    return {"ok": True, "status": st}
