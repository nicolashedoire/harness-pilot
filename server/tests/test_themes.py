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
