"""Opaque-origin page documents. The token grants own-folder assets, never API access."""
from __future__ import annotations

import html
from pathlib import Path

BRIDGE = Path(__file__).with_name("assets") / "page-bridge.js"
SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"


def document(base: str, hosts: list[str], kit: str) -> tuple[str, str]:
    # No broad 'self': even credentialed fetches to the app API must be refused by connect-src.
    network = "".join(f" https://{h}" for h in hosts)
    csp = (f"sandbox {SANDBOX}; default-src 'none'; script-src 'unsafe-inline' {base}; "
           f"style-src 'unsafe-inline' {base}; img-src data: blob: {base}{network}; "
           f"media-src data: blob: {base}{network}; font-src data: {base}{network}; "
           f"connect-src {base}{network}; worker-src 'none'; form-action 'none'; frame-ancestors 'self'; "
           f"base-uri {base}")
    doc = (f'<!doctype html><html data-mx-kit><head><meta charset="utf-8"><base href="{html.escape(base, quote=True)}">'
           '<meta name="viewport" content="width=device-width,initial-scale=1">'
           f'<style>html,body{{margin:0;min-height:100%;background:var(--background);color:var(--foreground)}}{kit}</style>'
           f'<script>{BRIDGE.read_text()}</script></head><body><main id="page"></main></body></html>')
    return doc, csp
