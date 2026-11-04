"""Colour themes: structural validation (maxxing/themes.py, mirror of web/src/lib/theme) and the palette that follows
the user on every device (PUT /api/settings/look, `rev`, bus topic `look`)."""
from __future__ import annotations

import pytest

from maxxing import themes


def test_colors_only():
    for ok in ("#fff", "#11223344", "rgb(1, 2, 3)", "rgb(1 2 3 / 50%)", "hsl(210deg, 50%, 40%)", "oklch(0.5 0.1 250)", "oklch(50% 0.1 250 / 0.4)"):
        assert themes.is_color(ok), ok
    for bad in ("red", "url(x)", "var(--a)", "#fff;", "rgb(1,2,3);color:red", "expression(1)", "rgb(1,2)", "oklch(0.5 0.1 250) }", "", "#" + "f" * 80, 3):
        assert not themes.is_color(bad), bad


def test_clean_theme_drops_unknown_and_refuses_unsafe():
    t = themes.clean_theme({"schema": 1, "id": "Bad Id", "name": " Night <b>owl</b> ", "extra": 1, "base": "marine",
                            "accent": "#ABC", "buttons": "neutral", "tint": "odd",
                            "tokens": {"light": {"background": "#fafafa", "nope": "#000"}, "dark": {}, "other": {"x": 1}}})
    assert t == {"schema": 1, "id": "custom", "name": "Night bowl/b", "base": "marine", "accent": "#aabbcc", "buttons": "neutral",
                 "tint": "neutral", "tokens": {"light": {"background": "#fafafa"}, "dark": {}}}
    for bad in ({"tokens": {"dark": {"card": "url(evil)"}}}, {"schema": 2}, {"accent": "javascript:1"}, [], {"name": "x" * 20000}):
        with pytest.raises(themes.ThemeError):
            themes.clean_theme(bad)


def _palette(**kw):
    return {"schema": 1, "id": "custom", "name": "", "base": "graphite", "accent": "#2d6efd", "buttons": "neutral", "tint": "neutral",
            "tokens": {"light": {}, "dark": {}}, **kw}


def test_palette_follows_every_device(client, monkeypatch):
    from maxxing import bus
    topics: list[tuple] = []
    monkeypatch.setattr(bus, "invalidate", lambda *t: topics.append(t))
    r = client.put("/api/settings/look", json={"theme": "dark", "palette": _palette(), "accent": "blue"})
    look = r.json()["look"]
    assert look["rev"] == 1 and look["palette"]["base"] == "graphite" and look["accent"] == "blue" and topics == [("look",)]
    # a theme change alone keeps the palette and its revision, no bus event
    look = client.put("/api/settings/look", json={"theme": "light"}).json()["look"]
    assert look["theme"] == "light" and look["rev"] == 1 and look["palette"]["base"] == "graphite" and topics == [("look",)]
    # the same palette again: nothing changes
    assert client.put("/api/settings/look", json={"theme": "light", "palette": _palette()}).json()["look"]["rev"] == 1
    # a client from before palettes changes accent + tint: base and buttons kept, new revision
    look = client.put("/api/settings/look", json={"theme": "light", "accent": "green", "tint": "tinted"}).json()["look"]
    assert look["rev"] == 2 and {k: look["palette"][k] for k in ("base", "accent", "buttons", "tint")} == {
        "base": "graphite", "accent": "green", "buttons": "neutral", "tint": "tinted"}
    # unsafe palette: refused, nothing stored
    bad = client.put("/api/settings/look", json={"theme": "dark", "palette": _palette(tokens={"light": {"background": "url(x)"}})})
    assert bad.status_code == 422 and bad.json()["error"] == "invalid_theme"
    assert client.get("/api/auth/state").json()["look"]["rev"] == 2


# ---- saved themes ("My themes") ----------------------------------------------------------------------------------
def test_saved_themes_are_validated_deduplicated_and_capped(client, monkeypatch):
    from maxxing import bus
    topics: list[tuple] = []
    monkeypatch.setattr(bus, "invalidate", lambda *t: topics.append(t))
    assert client.get("/api/settings/themes").json() == {"themes": [], "max": themes.SAVED_MAX}
    r = client.post("/api/settings/themes", json={"theme": _palette(name="Ember", extra="x"), "source": "created"})
    e = r.json()
    assert r.status_code == 200 and e["id"].startswith("th_") and e["source"] == "created" and e["from"] == ""
    assert e["theme"]["name"] == "Ember" and "extra" not in e["theme"] and topics == [("themes",)]
    # the same colours again (another name): the entry already kept, nothing added
    again = client.post("/api/settings/themes", json={"theme": _palette(name="Other"), "source": "imported"}).json()
    assert again["id"] == e["id"] and len(client.get("/api/settings/themes").json()["themes"]) == 1
    # unsafe or unusable: refused, nothing stored
    for bad in (_palette(tokens={"dark": {"card": "url(x)"}}), _palette(schema=2), _palette(name="x" * 20000)):
        r = client.post("/api/settings/themes", json={"theme": bad})
        assert r.status_code == 422 and r.json()["error"] == "invalid_theme"
    assert client.post("/api/settings/themes", json={"theme": _palette(), "source": "nope"}).status_code == 422
    # rename (cleaned), unknown id, empty name
    assert client.patch(f"/api/settings/themes/{e['id']}", json={"name": " Braise <x> "}).json()["theme"]["name"] == "Braise x"
    assert client.patch("/api/settings/themes/th_0000000000", json={"name": "a"}).status_code == 404
    assert client.patch(f"/api/settings/themes/{e['id']}", json={"name": "  "}).status_code == 422
    # received from a contact: who sent it is kept (cleaned)
    got = client.post("/api/settings/themes", json={"theme": _palette(accent="#14b8a6"), "source": "received", "from": "Lea <b>"}).json()
    assert got["from"] == "Lea b" and client.get("/api/settings/themes").json()["themes"][0]["id"] == got["id"]   # newest first
    # count cap
    monkeypatch.setattr(themes, "SAVED_MAX", 2)
    r = client.post("/api/settings/themes", json={"theme": _palette(accent="#ff0000")})
    assert r.status_code == 409 and r.json()["error"] == "too_many_themes"
    # delete
    assert client.delete(f"/api/settings/themes/{got['id']}").json() == {"ok": True}
    assert client.delete(f"/api/settings/themes/{got['id']}").status_code == 404
    assert [x["id"] for x in client.get("/api/settings/themes").json()["themes"]] == [e["id"]]


def test_a_damaged_saved_entry_is_skipped(client):
    from maxxing import config
    config.write_json(themes._saved_path(), {"themes": [
        {"id": "th_0123456789", "theme": _palette(name="Good"), "source": "odd", "saved": "nan"},
        {"id": "../evil", "theme": _palette()},
        {"id": "th_aaaaaaaaaa", "theme": _palette(tokens={"light": {"background": "var(--x)"}})},
        "junk"]})
    out = client.get("/api/settings/themes").json()["themes"]
    assert [(x["id"], x["source"], x["saved"]) for x in out] == [("th_0123456789", "imported", 0.0)]


def test_saved_themes_need_a_sign_in(client):
    client.cookies.clear()
    assert client.get("/api/settings/themes").status_code == 401


# ---- the theme a session wrote (theme generator) -----------------------------------------------------------------
def test_theme_file_of_a_session(client, topic, mx):
    import json
    import os
    import time
    s = client.post("/api/sessions", json={"path": topic}).json()
    url = f"/api/settings/themes/session/{s['id']}"
    folder = mx["ws"] / topic
    assert client.get(url).json()["error"] == "no_theme"
    old = folder / "old.theme.json"
    old.write_text(json.dumps(_palette(name="Old")))
    os.utime(old, (s["created"] - 60, s["created"] - 60))        # written before the session: not its answer
    assert client.get(url).status_code == 404
    (folder / "themes").mkdir()
    (folder / "themes" / "ember.theme.json").write_text(json.dumps(_palette(name="Ember", base="marine", junk=1)))
    r = client.get(url).json()
    assert r["file"] == "ember.theme.json" and r["theme"]["name"] == "Ember" and "junk" not in r["theme"]
    # since: only what came after a refinement message
    assert client.get(url, params={"since": time.time() + 60}).status_code == 404
    # the newest wins; unsafe / not JSON / too big = 422 with the reason
    time.sleep(0.02)
    bad = folder / "bad.theme.json"
    bad.write_text(json.dumps(_palette(tokens={"light": {"background": "url(https://evil.example/x)"}})))
    r = client.get(url)
    assert r.status_code == 422 and r.json()["error"] == "invalid_theme" and "background" in r.json()["message"]
    bad.write_text("{not json")
    assert "not JSON" in client.get(url).json()["message"]
    bad.write_text(json.dumps(_palette(description="x" * 20000)))
    assert client.get(url).status_code == 422
    bad.unlink()
    # a symbolic link (to a file outside the topic) is never read
    outside = mx["ws"] / "secret.theme.json"
    outside.write_text(json.dumps(_palette(name="Outside")))
    time.sleep(0.02)
    (folder / "link.theme.json").symlink_to(outside)
    assert client.get(url).json()["theme"]["name"] == "Ember"
    assert client.get("/api/settings/themes/session/00000000-0000-4000-8000-000000000000").status_code == 404


# ---- the skill pilot-theme: its examples are valid, its checker mirrors the rules -----------------------------------
def _skill_checker():
    import importlib.util
    from maxxing import config
    spec = importlib.util.spec_from_file_location("check_theme", config.SKILLS_DIR / "pilot-theme" / "check_theme.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_skill_examples_are_valid_themes():
    import json
    import re
    from maxxing import config
    ct = _skill_checker()
    md = (config.SKILLS_DIR / "pilot-theme" / "SKILL.md").read_text()
    assert md.startswith("---\nname: pilot-theme\n")
    found = []
    for block in re.findall(r"```json\n(.*?)```", md, re.S):
        chunks = block.strip().splitlines() if block.lstrip().startswith('{ "schema"') else [block]
        for chunk in chunks:
            themes.clean_theme(json.loads(chunk))
            errors, fails, _ = ct.check(chunk)
            assert not errors and not fails, (chunk[:60], errors, fails)
            found.append(json.loads(chunk)["id"])
    assert {"zinc", "graphite", "marine", "sauge", "ember"} <= set(found)
    assert ct.TOKENS == themes.TOKENS and ct.LIMITS == themes.LIMITS and ct.BASES == themes.BASES and ct.ACCENTS == themes.ACCENTS


def test_skill_checker_refuses_what_the_app_refuses():
    import json
    ct = _skill_checker()
    for ok in ("#fff", "rgb(1 2 3 / 50%)", "hsl(210deg, 50%, 40%)", "oklch(50% 0.1 250 / 0.4)"):
        assert ct.parse(ok) and themes.is_color(ok)
    for bad in ("red", "url(x)", "var(--a)", "#fff;", "oklch(0.5 0.1 250) }", "#" + "f" * 80):
        assert ct.parse(bad) is None and not themes.is_color(bad)
    errors, fails, _ = ct.check(json.dumps(_palette(tokens={"dark": {"card": "url(x)", "background": "#000", "foreground": "#222"}})))
    assert any("card" in e for e in errors) and any("foreground on background" in f for f in fails)
    assert ct.check("{oops")[0] and ct.check("x" * 20000)[0]
    assert abs(ct.contrast("#ffffff", "#000000") - 21) < 0.01 and abs(ct.contrast("#777777", "#ffffff") - 4.48) < 0.01
