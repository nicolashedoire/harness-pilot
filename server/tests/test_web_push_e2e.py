"""Web Push end to end (docs/dev/API.md#web-push): a browser-like subscription made through the API, feed events
posted through the API or by a finished session, the server's feed watcher, then a real HTTPS request to a local
fake push service. The fake service does what a push service and a browser do between them: it checks the VAPID
token against the server's `applicationServerKey`, decrypts the `aes128gcm` body with the subscription's keys
(RFC 8291) and answers 201 - or 410 once the subscription is gone. Only the trusted CA (SSL_CERT_FILE) and the
watcher's period are test settings: no transport is replaced."""
from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import ipaddress
import json
import os
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from conftest import wait_for, wait_idle
from maxxing import push


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _tls_files(folder: Path) -> tuple[Path, Path, Path]:
    """A throwaway CA and a certificate for localhost signed by it -> (ca.pem, cert.pem, key.pem)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key, key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fake push service test CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
          .not_valid_after(now + datetime.timedelta(hours=1))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                       data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                       crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
            .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(hours=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"),
                                                        x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
                           critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    paths = folder / "ca.pem", folder / "cert.pem", folder / "key.pem"
    paths[0].write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    paths[1].write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    paths[2].write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return paths


class FakePushService:
    """An HTTPS push service on localhost. `browsers[path]` = (private key, auth secret) of the subscription whose
    endpoint is that path; `status[path]` overrides the 201 answer. Every request is checked, then kept in
    `received` as {path, headers, claims, data} (`data` = the decrypted JSON payload) or in `errors`."""

    def __init__(self, folder: Path):
        ca, cert, key = _tls_files(folder)
        self.ca_file = ca
        self.browsers: dict[str, tuple] = {}
        self.status: dict[str, int] = {}
        self.received: list[dict] = []
        self.errors: list[str] = []
        self.app_key: str | None = None
        service = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:                 # noqa: N802 - http.server API
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    service.received.append(service.check(self.path, dict(self.headers), body))
                except Exception as e:  # noqa: BLE001 - reported by the test
                    service.errors.append(f"{self.path}: {e!r}")
                    self.send_response(400)
                else:
                    self.send_response(service.status.get(self.path, 201))
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
        self.origin = f"https://localhost:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def subscription(self, name: str) -> dict:
        """What `PushSubscription.toJSON()` gives a page: a new key pair and auth secret for this endpoint."""
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        priv = ec.generate_private_key(ec.SECP256R1())
        pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        auth = os.urandom(16)
        self.browsers[f"/wpush/{name}"] = (priv, auth)
        return {"endpoint": f"{self.origin}/wpush/{name}", "expirationTime": None,
                "keys": {"p256dh": _b64(pub), "auth": _b64(auth)}}

    def check(self, path: str, headers: dict, body: bytes) -> dict:
        headers = {k.lower(): v for k, v in headers.items()}
        assert path in self.browsers, "unknown endpoint"
        assert headers.get("content-encoding") == "aes128gcm", headers
        assert headers.get("content-type") == "application/octet-stream", headers
        assert int(headers.get("ttl", "-1")) > 0, headers
        assert headers.get("urgency") in ("very-low", "low", "normal", "high"), headers
        claims = self.check_vapid(headers.get("authorization", ""))
        priv, auth = self.browsers[path]
        return {"path": path, "headers": headers, "claims": claims, "data": json.loads(self.decrypt(body, priv, auth))}

    def check_vapid(self, header: str) -> dict:
        """RFC 8292: `vapid t=<ES256 JWT>, k=<the applicationServerKey>`; aud = this origin, exp <= 24 h."""
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
        assert header.startswith("vapid "), header
        params = dict(p.strip().split("=", 1) for p in header[len("vapid "):].split(","))
        assert params["k"] == self.app_key, "k is not the key the browser subscribed with"
        head, claims, sig = params["t"].split(".")
        assert json.loads(_b64d(head)) == {"typ": "JWT", "alg": "ES256"}
        raw = _b64d(sig)
        assert len(raw) == 64
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _b64d(params["k"]))
        key.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                   f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
        c = json.loads(_b64d(claims))
        assert c["aud"] == self.origin, c
        assert time.time() < c["exp"] <= time.time() + 24 * 3600, c
        assert c["sub"].startswith(("mailto:", "https://")), c
        return c

    @staticmethod
    def decrypt(body: bytes, priv, auth: bytes) -> bytes:
        """What the browser does with the message (RFC 8291 / RFC 8188, one record)."""
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
        as_pub, record = body[21:21 + idlen], body[21 + idlen:]
        assert idlen == 65 and len(record) <= rs, (idlen, rs, len(record))
        ua_pub = priv.public_key().public_bytes(serialization.Encoding.X962,
                                                serialization.PublicFormat.UncompressedPoint)
        shared = priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
        h = lambda k, d: hmac.new(k, d, hashlib.sha256).digest()  # noqa: E731
        prk = h(salt, h(h(auth, shared), b"WebPush: info\x00" + ua_pub + as_pub + b"\x01"))
        plain = AESGCM(h(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]).decrypt(
            h(prk, b"Content-Encoding: nonce\x00\x01")[:12], record, None)
        assert plain.rstrip(b"\x00").endswith(b"\x02"), "not a last record"
        return plain.rstrip(b"\x00")[:-1]

    def pushes(self, path: str) -> list[dict]:
        return [r for r in self.received if r["path"] == path]


@pytest.fixture
def fast_watch(monkeypatch: pytest.MonkeyPatch) -> None:
    """The feed watcher looks for new rows every 0.1 s instead of 3 s (set before the app starts)."""
    from maxxing.api import feed as feed_api
    monkeypatch.setattr(feed_api, "WATCH_S", 0.1)


@pytest.fixture
def push_service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    service = FakePushService(tmp_path)
    monkeypatch.setenv("SSL_CERT_FILE", str(service.ca_file))      # the server's HTTPS client trusts this CA only
    monkeypatch.setattr(push, "http_transport", None)               # the real network path
    yield service
    service.close()


def test_feed_events_reach_a_push_service_encrypted_and_signed(fast_watch, push_service, client, topic):
    svc = push_service
    overview = client.get("/api/push").json()
    assert overview["available"] is True
    svc.app_key = overview["public_key"]                            # the page's applicationServerKey
    phone = svc.subscription("phone")
    sub = client.post("/api/push/subscriptions", json={**phone, "label": "Phone", "prefs": {
        "kinds": {"session.done": {"enabled": True, "sound": False}}}})
    assert sub.status_code == 200, sub.text
    sub = sub.json()

    # a script's error (default prefs: warnings and errors, with sound); a quiet one before it is never pushed
    assert client.post("/api/feed", json={"title": "Quiet error", "level": "error", "source": "billing",
                                          "quiet": True}).status_code == 200
    ev = client.post("/api/feed", json={"title": "Payment failed", "body": "Card declined", "level": "error",
                                        "source": "billing", "url": "/notifications",
                                        "params": {"amount": "12"}}).json()["event"]
    got = wait_for(lambda: svc.pushes("/wpush/phone"), timeout=15)
    assert not svc.errors, svc.errors
    first = got[0]
    assert first["headers"]["urgency"] == "high" and first["headers"]["ttl"] == str(push.TTL_S)
    data = first["data"]
    assert data["id"] == ev["id"] and data["title"] == "Payment failed" and data["body"] == "Card declined"
    assert data["level"] == "error" and data["source"] == "billing" and data["url"] == "/notifications"
    assert data["kind"] == "custom" and data["params"] == {"amount": "12"} and data["silent"] is False
    assert data["tag"] == f"feed-{ev['id']}" and data["count"] == 1

    # a session that finishes: its session.done row (level success) is pushed because this kind is enabled, silently
    s = client.post("/api/sessions", json={"path": topic, "message": "hello NOTOOL"}).json()
    wait_idle(client, s["id"])
    done = wait_for(lambda: [r["data"] for r in svc.pushes("/wpush/phone") if r["data"]["kind"] == "session.done"],
                    timeout=15)[0]
    assert done["silent"] is True and done["level"] == "success" and done["params"]["session_id"] == s["id"]
    assert f"session={s['id']}" in done["url"]
    assert [r["data"]["title"] for r in svc.pushes("/wpush/phone")].count("Quiet error") == 0
    stamped = client.get("/api/push").json()["subscriptions"][0]
    assert stamped["last_ok"] is not None and stamped["last_error"] is None

    # Settings -> Notifications -> Test
    assert client.post(f"/api/push/subscriptions/{sub['id']}/test").json() == {"ok": True, "status": 201}
    test = svc.pushes("/wpush/phone")[-1]["data"]
    assert test["kind"] == "push.test" and test["silent"] is False and test["tag"] == "push-test"

    # the browser unsubscribed: the push service answers 410 and the subscription is removed
    svc.status["/wpush/phone"] = 410
    n = len(svc.pushes("/wpush/phone"))
    client.post("/api/feed", json={"title": "Disk almost full", "level": "warning", "source": "infra"})
    wait_for(lambda: client.get("/api/push").json()["subscriptions"] == [], timeout=15)
    assert len(svc.pushes("/wpush/phone")) == n + 1
    assert client.post(f"/api/push/subscriptions/{sub['id']}/test").status_code == 404
    assert not svc.errors, svc.errors
