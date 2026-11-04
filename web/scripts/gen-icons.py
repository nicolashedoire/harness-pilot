#!/usr/bin/env python3
"""Export the approved companion artwork into application and compatibility icons.

Run: uv run --with pillow python web/scripts/gen-icons.py
The original transparent artwork lives in docs/assets/pilot-companion-master.png.
Brand identity stays independent of the interface accent. No browser or network is used.
"""
import base64
import json
from pathlib import Path

from PIL import Image

WEB = Path(__file__).resolve().parent.parent
PUBLIC = WEB / 'public'
ICONS = PUBLIC / 'icons'
ACCENTS = ('blue', 'violet', 'clay', 'green', 'amber', 'rose')
PREFIX = 'pilot-companion-v2'


def main():
    master = Image.open(WEB.parent / 'docs/assets/pilot-companion-master.png').convert('RGBA')
    if master.getchannel('A').getextrema()[0] != 0:
        raise ValueError('The companion master must retain transparency.')
    ICONS.mkdir(exist_ok=True)
    for size, suffix in ((128, ''), (32, '-32'), (192, '-192'), (512, '-512')):
        master.resize((size, size), Image.Resampling.LANCZOS).save(ICONS / f'{PREFIX}{suffix}.png', optimize=True)
    for size, suffix, mark_size in ((180, '-apple', 148), (512, '-maskable', 320)):
        tile = Image.new('RGBA', (size, size), '#eef0ff')
        tile.alpha_composite(master.resize((mark_size, mark_size), Image.Resampling.LANCZOS),
                             ((size - mark_size) // 2, (size - mark_size) // 2))
        tile.convert('RGB').save(ICONS / f'{PREFIX}{suffix}.png', optimize=True)
    master.save(PUBLIC / 'favicon.ico', format='ICO', sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    encoded = base64.b64encode((ICONS / f'{PREFIX}.png').read_bytes()).decode('ascii')
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
           f'<image width="128" height="128" href="data:image/png;base64,{encoded}"/></svg>\n')
    (PUBLIC / 'favicon.svg').write_text(svg)
    # Keep old install/notification URLs usable with the same identity.
    for accent in ACCENTS:
        (ICONS / f'logo-{accent}.svg').write_text(svg)
        for size in (64, 128):
            master.resize((size, size), Image.Resampling.LANCZOS).save(ICONS / f'logo-{accent}-{size}.png', optimize=True)
        for size in (192, 512):
            (ICONS / f'icon-{accent}-{size}.png').write_bytes((ICONS / f'{PREFIX}-{size}.png').read_bytes())
        (ICONS / f'icon-maskable-{accent}-512.png').write_bytes((ICONS / f'{PREFIX}-maskable.png').read_bytes())
        (ICONS / f'apple-touch-icon-{accent}.png').write_bytes((ICONS / f'{PREFIX}-apple.png').read_bytes())
    aliases = {'harness-pilot.png': '.png', 'harness-pilot-192.png': '-192.png',
               'harness-pilot-512.png': '-512.png', 'icon-192.png': '-192.png', 'icon-512.png': '-512.png',
               'icon-maskable-512.png': '-maskable.png', 'apple-touch-icon.png': '-apple.png'}
    for alias, suffix in aliases.items():
        (ICONS / alias).write_bytes((ICONS / f'{PREFIX}{suffix}').read_bytes())
    for path in PUBLIC.glob('manifest*.webmanifest'):
        manifest = json.loads(path.read_text())
        manifest['icons'] = [
            {'src': f'/icons/{PREFIX}-{size}.png', 'sizes': f'{size}x{size}', 'type': 'image/png', 'purpose': 'any'}
            for size in (192, 512)] + [
            {'src': f'/icons/{PREFIX}-maskable.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}]
        for shortcut in manifest.get('shortcuts', []):
            shortcut['icons'] = [{'src': f'/icons/{PREFIX}-192.png', 'sizes': '192x192', 'type': 'image/png'}]
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
