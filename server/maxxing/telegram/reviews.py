"""Owner-only, fingerprint-bound companion review in Telegram. No code application or publication."""
from __future__ import annotations

import asyncio
import re

from .. import companions, config, feed
from ..sessions import service
from . import format as fmt
from .client import TelegramError

MAX_REVIEW = 12000  # complete text only; never offer approval of a truncated or binary patch
WORDS = {
    'en': {
        'review': 'Review proposal', 'discuss': 'Discuss with the companion',
        'approve': 'Approve proposal', 'reject': 'Reject',
        'missing': 'This proposal notification is no longer available.',
        'changed': 'The proposal changed or is still running. Review the latest version in the app.',
        'large': 'This proposal needs the full review in the app; it cannot be approved here.',
        'decided': 'A decision has already been recorded for this version.',
        'notice': 'Exact proposal {fingerprint}. Your decision records approval only; no code is applied or published.',
        'approved': 'Proposal approved. No code was applied or published.',
        'rejected': 'Proposal rejected. No code was applied or published.',
        'conversation': 'Write here to discuss this proposal with the companion. /status checks its state; /stop interrupts its work.',
        'opened': 'The companion conversation is ready in its own thread.',
        'unavailable': 'Could not open the companion thread. Use its conversation in the app.',
        'delivery': 'The full review could not be delivered. Try again or review it in the app.',
    },
    'fr': {
        'review': 'Voir la proposition', 'discuss': 'Discuter avec le compagnon',
        'approve': 'Approuver la proposition', 'reject': 'Refuser',
        'missing': 'Cette notification de proposition n’est plus disponible.',
        'changed': 'La proposition a changé ou le compagnon travaille encore. Consultez la dernière version dans l’application.',
        'large': 'Cette proposition demande une revue complète dans l’application ; elle ne peut pas être approuvée ici.',
        'decided': 'Une décision est déjà enregistrée pour cette version.',
        'notice': 'Proposition exacte {fingerprint}. Votre choix enregistre une décision : aucun code n’est appliqué ou publié.',
        'approved': 'Proposition approuvée. Aucun code n’a été appliqué ou publié.',
        'rejected': 'Proposition refusée. Aucun code n’a été appliqué ou publié.',
        'conversation': 'Écrivez ici pour discuter de cette proposition avec le compagnon. /status indique son état ; /stop interrompt son travail.',
        'opened': 'La conversation du compagnon est prête dans son propre fil.',
        'unavailable': 'Impossible d’ouvrir le fil du compagnon. Utilisez sa conversation dans l’application.',
        'delivery': 'La revue complète n’a pas pu être envoyée. Réessayez ou consultez-la dans l’application.',
    },
}


def _w(key: str, **params) -> str:
    words = WORDS.get(config.load_config().get('language'), WORDS['en'])
    return words[key].format(**params)


def _params(ev: dict) -> tuple[str, str] | None:
    p = ev.get('params') or {}
    sid, fingerprint = p.get('session_id'), p.get('fingerprint')
    if (ev.get('source') != 'system' or ev.get('kind') != 'companion.ready'
            or not isinstance(sid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', sid)
            or not isinstance(fingerprint, str) or not re.fullmatch(r'[a-f0-9]{64}', fingerprint)):
        return None
    return sid, fingerprint


def buttons(ev: dict, *, decision: bool = False) -> dict | None:
    if not _params(ev):
        return None
    ident = ev['id']
    row = [{'text': _w('approve'), 'callback_data': f'c:{ident}:a'},
           {'text': _w('reject'), 'callback_data': f'c:{ident}:r'}] if decision else [
               {'text': _w('review'), 'callback_data': f'c:{ident}:v'}]
    return {'inline_keyboard': [row, [{'text': _w('discuss'), 'callback_data': f'c:{ident}:d'}]]}


def _patch(result: dict) -> str | None:
    patch = result['patch']
    if 'GIT binary patch' in patch or 'Binary files ' in patch:
        return None
    for item in result['untracked']:
        if any(c in item['path'] for c in '\r\n'):
            return None
        mode = '100755' if item.get('executable') else '100644'
        patch += f"\n+++ new file: {item['path']} (mode {mode})\n" + item['content']
        if len(patch) > MAX_REVIEW:
            return None
    return patch if 0 < len(patch) <= MAX_REVIEW else None


async def handle(gw, msg: dict, value: str) -> str:
    """Called only after Gateway's linked-owner authorization. Callback contains no client-supplied fingerprint."""
    ident, _, action = value.partition(':')
    if not ident.isdecimal() or len(ident) > 16 or action not in ('v', 'a', 'r', 'd'):
        return _w('missing')
    ev = await asyncio.to_thread(feed.get, int(ident))
    params = _params(ev) if ev else None
    if not params:
        return _w('missing')
    sid, fingerprint = params
    try:
        result = await asyncio.to_thread(companions.review, sid)
        if result['fingerprint'] != fingerprint or result['session'].get('state') == 'running':
            return _w('changed')
        if action == 'd':
            tid = await gw.reopen_thread(sid, result['session'])
            if tid is None:
                return _w('unavailable')
            sent = await gw.send_html(msg['chat']['id'], tid, fmt.escape(_w('conversation')))
            return _w('opened' if sent else 'delivery')
        if (result.get('decision') or {}).get('fingerprint') == fingerprint:
            return _w('decided')
        patch = _patch(result)
        if patch is None:
            return _w('large')
        if action == 'v':
            from .gateway import _msg_thread
            tid = _msg_thread(msg)
            for part in fmt.code(patch):
                if not await gw.send_html(msg['chat']['id'], tid, part, silent=True):
                    return _w('delivery')
            sent = await gw.send_html(msg['chat']['id'], tid,
                                      fmt.escape(_w('notice', fingerprint=fingerprint[:12])),
                                      silent=True, markup=buttons(ev, decision=True))
            return '' if sent else _w('delivery')
        decision = 'approved' if action == 'a' else 'rejected'
        await asyncio.to_thread(companions.decide, sid, decision, fingerprint)
        text = _w(decision)
        await gw._edit(msg, fmt.escape(text))
        try:
            await gw.client.call('editMessageReplyMarkup', chat_id=msg['chat']['id'],
                                 message_id=msg.get('message_id'), reply_markup={'inline_keyboard': [
                                     [{'text': _w('discuss'), 'callback_data': f'c:{ident}:d'}]]})
        except TelegramError:
            pass  # the decision is already saved; a failed markup edit cannot undo it
        return text
    except service.SessionError:
        return _w('changed')
