"""Conversation blocks: the plugin list, enable / disable, network consent, dashboard pins and the sandboxed frames.
See docs/dev/API.md#conversation-blocks and maxxing/blocks.py.

`GET /ext/_blocks/app-frame` and `GET /ext/_blocks/{id}/frame` are documents of their own (under /ext/: the service
worker never touches them), sandboxed by their Content-Security-Policy as well as by the iframe: opaque origin, no
cookie, no app API, inline code only, and no network except the hosts a block extension declared and the user
allowed. The block's data never goes in the URL: the page receives it by postMessage (web/src/features/blocks).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from .. import blocks, bus, extensions
from ..security import require_auth
from .extensions import ui_kit_css

router = APIRouter(tags=["blocks"], dependencies=[Depends(require_auth)])
log = logging.getLogger("maxxing.blocks")


def _err(status: int, code: str, msg: str, **extra: Any) -> HTTPException:
    return HTTPException(status, detail={"error": code, "message": msg, **extra})


def _catalog() -> dict:
    ps = blocks.plugins()
    blocks.sync_agent_files()
    return {"plugins": ps, "agents": blocks.agents_summary()}


@router.get("/api/blocks")
async def list_blocks():
    return await asyncio.to_thread(_catalog)


class PatchIn(BaseModel):
    enabled: bool


def _patch(pid: str, enabled: bool) -> dict | None:
    if not blocks.set_enabled(pid, enabled):
        return None
    blocks.sync_agent_files()
    return blocks.get(pid)


@router.patch("/api/blocks/{pid}")
async def patch_block(pid: str, body: PatchIn):
    plugin = await asyncio.to_thread(_patch, pid, body.enabled)
    if plugin is None:
        raise _err(404, "not_found", f"no block plugin {pid}")
    bus.invalidate("extensions")
    return {"ok": True, "plugin": plugin}


class ConsentIn(BaseModel):
    decision: Literal["always", "once", "deny", "reset"]


@router.post("/api/blocks/{pid}/consent")
async def consent(pid: str, body: ConsentIn):
    try:
        out = await asyncio.to_thread(blocks.set_consent, pid, body.decision)
    except LookupError as e:
        raise _err(404, "not_found", str(e)) from None
    except ValueError as e:
        raise _err(400, "no_network", str(e)) from None
    if body.decision != "once":
        bus.invalidate("extensions")
    return {"ok": True, **out}


class PinIn(BaseModel):
    type: str
    data: dict
    title: Optional[str] = ""


@router.post("/api/blocks/pin")
async def pin(body: PinIn):
    if len(json.dumps(body.data)) > blocks.DATA_MAX:
        raise _err(413, "too_large", "block data over 512 kB")
    try:
        eid = await asyncio.to_thread(blocks.pin, body.type, body.data, body.title or "")
    except ValueError as e:
        raise _err(400, "not_pinnable", str(e)) from None
    bus.invalidate("extensions")
    return {"ok": True, "id": eid}


# ---- frames ------------------------------------------------------------------------------------------------------
# The bridge of a block frame: `maxxing.data` / onData(fn) (the block's JSON), theme + its CSS variables (the UI kit's
# `ui-*` classes work), resize, send(text) - the app asks the user before anything is sent to the conversation -
# and error(message). Messages are only taken from the parent window.
BRIDGE = r"""(function(){
var init={};try{init=JSON.parse(decodeURIComponent(location.hash.slice(1))||'{}')}catch(_){}
var root=document.documentElement,dcb=[],tcb=[],have=false,last=0;
root.setAttribute('data-mx-kit','');
function post(m){try{parent.postMessage(m,'*')}catch(_){}}
function apply(v){for(var k in v||{})root.style.setProperty(k,v[k]);root.dataset.theme=window.maxxing.theme;root.style.colorScheme=window.maxxing.theme}
function size(){var b=document.body,h=Math.ceil(Math.max(root.getBoundingClientRect().height,b?b.getBoundingClientRect().height:0));if(h!==last){last=h;post({mx:'resize',height:h})}}
window.maxxing={theme:init.theme||'dark',lang:init.lang||'en',type:init.type||'',data:null,
 onData:function(f){dcb.push(f);if(have)try{f(window.maxxing.data)}catch(e){window.maxxing.error(e&&e.message||String(e))}},
 onTheme:function(f){tcb.push(f)},
 resize:function(h){post({mx:'resize',height:Number(h)||0})},
 send:function(t){post({mx:'send',text:String(t==null?'':t).slice(0,4000)})},
 error:function(m){post({mx:'error',message:String(m==null?'':m).slice(0,500)})}};
addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data||{};
 if(m.mx==='data'){window.maxxing.data=m.data;have=true;dcb.forEach(function(f){try{f(m.data)}catch(x){window.maxxing.error(x&&x.message||String(x))}})}
 if(m.mx==='theme'){window.maxxing.theme=m.theme;apply(m.vars);tcb.forEach(function(f){try{f(m.theme)}catch(_){}})}});
addEventListener('error',function(e){window.maxxing.error(e.message||'script error')});
addEventListener('load',size);
try{var ro=new ResizeObserver(size);ro.observe(root);addEventListener('DOMContentLoaded',function(){document.body&&ro.observe(document.body)})}catch(_){setInterval(size,500)}
apply(init.vars);post({mx:'ready'});
})();"""
BASE_CSS = ("*,*::before,*::after{box-sizing:border-box}html,body{margin:0;background:transparent;"
            "color:var(--foreground);font:13px/1.45 Inter,system-ui,sans-serif}")

# The built-in `app` block: an empty page that waits for its HTML, then writes it over itself with the bridge in front
# (document.write keeps this document's sandbox and policy: inline code runs, nothing reaches the network).
APP_LOADER = r"""(function(){
var B=document.getElementById('mxb').textContent,K=document.getElementById('mxk').textContent;
addEventListener('message',function f(e){if(e.source!==parent)return;var m=e.data||{};
 if(m.mx!=='html'||typeof m.html!=='string')return;removeEventListener('message',f);
 var head='<!doctype html><meta charset="utf-8"><script>'+B+'<\/script><style>'+K+'<\/style>';
 document.open();document.write(head+m.html);document.close();});
parent.postMessage({mx:'loader'},'*');})();"""


def _frame(body: str, hosts: list[str]) -> HTMLResponse:
    return HTMLResponse(body, headers={"Cache-Control": "no-store", "Content-Security-Policy": blocks.frame_csp(hosts),
                                       "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"})


def _script(js: str, ident: str = "") -> str:
    return f"<script{' id=' + chr(34) + ident + chr(34) if ident else ''}>{js.replace('</', '<' + chr(92) + '/')}</script>"


@router.get("/ext/_blocks/app-frame", include_in_schema=False)
async def app_frame():
    if not await asyncio.to_thread(lambda: any(p["id"] == "app" and p["enabled"] for p in blocks.plugins())):
        raise _err(404, "block_disabled", "the app block is turned off")
    kit = await asyncio.to_thread(ui_kit_css)
    css = BASE_CSS + kit
    body = ('<!doctype html><meta charset="utf-8">'
            f'<script type="text/plain" id="mxb">{BRIDGE.replace("</", "<" + chr(92) + "/")}</script>'
            f'<script type="text/plain" id="mxk">{css.replace("</", "<" + chr(92) + "/")}</script>'
            + _script(APP_LOADER))
    return _frame(body, [])


@router.get("/ext/_blocks/{pid}/frame", include_in_schema=False)
async def plugin_frame(pid: str, grant: str = ""):
    def load() -> tuple[dict, str]:
        p = blocks.get(pid)
        if p is None or p["kind"] != "extension" or not p["enabled"] or p["error"]:
            raise _err(404, "not_found", f"no enabled block extension {pid}")
        ext = extensions.get(pid)
        entry = (ext.block or {}).get("entry", "block.html") if ext else "block.html"
        html = blocks._inside(ext.dir, entry, "entry").read_text("utf-8", "replace") if ext else ""
        return p, html
    try:
        p, html = await asyncio.to_thread(load)
    except ValueError as e:
        raise _err(404, "not_found", str(e)) from None
    kit = await asyncio.to_thread(ui_kit_css)
    body = ('<!doctype html><meta charset="utf-8">' + _script(BRIDGE) + f"<style>{BASE_CSS}{kit}</style>\n" + html)
    return _frame(body, blocks.allowed_hosts(p, grant))


async def startup() -> None:
    extensions.on_change(blocks.sync_agent_files)
    try:
        await asyncio.to_thread(blocks.sync_agent_files)
    except Exception:
        log.exception("conversation blocks: agent files not written")
