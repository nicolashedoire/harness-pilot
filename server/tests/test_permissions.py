"""Extension permissions: the manifest's "permissions" (maxxing/permissions.py), listed and checked."""
import json

import pytest

from _org_helpers import client, org  # noqa: F401
from maxxing import extcheck, permissions


def _ext(org, eid, manifest, api=None, **files):
    d = org.ws / "extensions" / eid
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(json.dumps(manifest))
    if api is not None:
        (d / "api.py").write_text(api)
    for name, text in files.items():
        (d / name.replace("_", ".", 1)).write_text(text)
    return d


CARD = "def card(ctx):\n    return {'blocks': [{'type': 'stat', 'label': 'x', 'value': 1}]}\n"


def test_parse_normalises_and_dedupes():
    assert permissions.parse(None) is None
    assert permissions.parse({}) == {"network": [], "secrets": [], "read": []}
    got = permissions.parse({"network": ["API.example.com", "api.example.com", "*.cdn.example.com:8443"],
                             "secrets": ["SHOP_TOKEN", "SHOP_TOKEN", "B2"],
                             "read": ["projects/shop/", "./tasks.json", "projects//shop", ".", "a/./b"]})
    assert got == {"network": ["api.example.com", "*.cdn.example.com:8443"], "secrets": ["SHOP_TOKEN", "B2"],
                   "read": ["projects/shop", "tasks.json", ".", "a/b"]}
    assert permissions.view(got) == {**got, "declared": True}
    assert permissions.view(None) == {"network": [], "secrets": [], "read": [], "declared": False}
    assert permissions.summary(got) == ("network: api.example.com, *.cdn.example.com:8443 · keys: SHOP_TOKEN, B2 · "
                                        "reads: projects/shop, tasks.json, ., a/b")
    assert permissions.summary({"network": [], "secrets": [], "read": []}) == "nothing"
    assert permissions.summary(None) == "not declared"


@pytest.mark.parametrize("raw, words", [
    (["network"], "must be an object"),
    ({"net": []}, "unsupported key(s) net"),
    ({"network": "api.example.com"}, "permissions.network must list"),
    ({"network": ["https://api.example.com"]}, "no https://"),
    ({"network": ["api.example.com/v1"]}, "no https://"),
    ({"network": ["localhost"]}, "host name"),
    ({"network": [f"h{i}.example.com" for i in range(9)]}, "at most 8"),
    ({"secrets": ["shop_token"]}, "Settings -> Keys"),
    ({"secrets": [1]}, "Settings -> Keys"),
    ({"read": ["/etc/passwd"]}, "relative to the workspace"),
    ({"read": ["~/.ssh"]}, "relative to the workspace"),
    ({"read": ["projects/../../etc"]}, "no .."),
    ({"read": ["a\\b"]}, "relative to the workspace"),
    ({"read": [""]}, "path of the workspace"),
    ({"read": ["x" * 301]}, "path of the workspace"),
])
def test_parse_refuses(raw, words):
    with pytest.raises(ValueError) as e:
        permissions.parse(raw)
    assert words in str(e.value)


def test_listed_and_a_bad_declaration_is_the_extension_error(client, org):
    _ext(org, "shop", {"type": "widget", "permissions": {"secrets": ["SHOP_TOKEN"], "network": ["api.example.com"]}},
         CARD)
    _ext(org, "plain", {"type": "widget"}, CARD)
    _ext(org, "bad", {"type": "widget", "permissions": {"network": ["https://x.example.com"]}}, CARD)
    blk = org.ws / "extensions" / "map"
    blk.mkdir()
    (blk / "block.json").write_text(json.dumps({"type": "block", "renders": ["map"],
                                                "permissions": {"network": ["tiles.example.com"]}}))
    (blk / "block.html").write_text("<div></div>")
    lst = {e["id"]: e for e in client.get("/api/extensions").json()}
    assert lst["shop"]["permissions"] == {"network": ["api.example.com"], "secrets": ["SHOP_TOKEN"], "read": []}
    assert lst["shop"]["error"] is None
    assert lst["plain"]["permissions"] is None and lst["plain"]["error"] is None
    assert "no https://" in lst["bad"]["error"] and lst["bad"]["permissions"] is None
    assert lst["map"]["permissions"] == {"network": ["tiles.example.com"], "secrets": [], "read": []}


def test_ext_check_reports_the_declaration(org):
    _ext(org, "shop", {"type": "widget", "permissions": {"secrets": ["SHOP_TOKEN"], "read": ["projects"]}}, CARD)
    _ext(org, "plain", {"type": "widget"}, CARD)
    r = extcheck.check("shop")
    assert r["status"] == "ok" and r["permissions"]["secrets"] == ["SHOP_TOKEN"]
    assert {"step": "permissions", "status": "ok", "detail": "declares keys: SHOP_TOKEN · reads: projects"} in r["steps"]
    r = extcheck.check("plain")
    assert r["status"] == "warn" and r["permissions"] is None
    assert any(s["step"] == "permissions" and s["status"] == "warn" and "declares no" in s["detail"] for s in r["steps"])
