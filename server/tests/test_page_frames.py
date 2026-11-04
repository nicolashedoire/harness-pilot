"""Stage A: no browser session authority in a page frame; token authority stops at its own assets."""
import json
import re
from urllib.parse import urlsplit

import pytest

from _org_helpers import org, client  # noqa: F401
from maxxing import config, extensions, extcheck


def page(org, eid="isolated", api=2, **extra):
    root = org.ws / "extensions" / eid
    root.mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"id": eid, "type": "page", "api": api, "permissions": {}, **extra}))
    (root / "page.js").write_text('import {label} from "./lib/label.js"; export function mount(el,ctx){el.textContent=label;}')
    (root / "lib").mkdir()
    (root / "lib/label.js").write_text('export const label="Isolated";')
    return root


def base(response):
    assert response.status_code == 200, response.text
    return urlsplit(re.search(r'<base href="([^"]+)"', response.text).group(1)).path


def test_new_frame_contract_and_asset_scope(client, org):
    root = page(org)
    page(org, "other")
    response = client.get('/ext/isolated/page-frame')
    prefix = base(response)
    csp = response.headers['content-security-policy']
    assert 'allow-same-origin' not in csp and 'sandbox allow-scripts' in csp
    assert "connect-src 'self'" not in csp and 'connect-src http://testserver' + prefix in csp
    assert response.headers['cache-control'] == 'no-store'
    info = next(x for x in client.get('/api/extensions').json() if x['id'] == 'isolated')
    assert info['runtime'] == {'page': 'frame'}
    # Cookie-free asset requests still load modules, CSS and JSON, with CORS only on those assets.
    client.cookies.clear()
    asset = client.get(prefix + 'lib/label.js')
    assert asset.status_code == 200 and asset.headers['access-control-allow-origin'] == '*'
    assert client.get(prefix.replace('/isolated/', '/other/') + 'page.js').status_code == 404
    assert client.get(prefix + 'api.py').status_code == 404
    secret = org.tmp / 'secret.js'
    secret.write_text('private')
    (root / 'leak.js').symlink_to(secret)
    assert client.get(prefix + 'leak.js').status_code == 404
    assert client.get('/ext/isolated/page-frame').status_code == 401


def test_opaque_origin_cannot_read_or_write_even_with_cookie_and_csrf(client, org):
    assert client.get('/api/settings').status_code == 200
    before = config.load_config()
    assert client.get('/api/settings', headers={'Origin': 'null'}).status_code == 403
    blocked = client.put('/api/settings', json={'language': 'fr'}, headers={'Origin': 'null', 'X-Maxxing': '1'})
    assert blocked.status_code == 403 and blocked.json()['error'] == 'opaque_origin'
    assert config.load_config() == before


def test_legacy_migration_is_explicit_and_survives_scan(client, org):
    page(org, api=1)
    assert extensions.get('isolated').page_runtime == 'trusted'
    assert client.get('/ext/isolated/page-frame').status_code == 404
    assert client.patch('/api/extensions/isolated', json={'page_runtime': 'frame'}).status_code == 200
    extensions.scan()
    assert extensions.get('isolated').page_runtime == 'frame'
    prefix = base(client.get('/ext/isolated/page-frame'))
    assert client.patch('/api/extensions/isolated', json={'enabled': False}).status_code == 200
    assert client.get(prefix + 'page.js').status_code == 404
    assert client.get('/ext/isolated/page-frame').status_code == 404
    assert client.patch('/api/extensions/isolated', json={'enabled': True, 'page_runtime': 'trusted'}).status_code == 200
    assert client.get(prefix + 'page.js').status_code == 404
    assert client.get('/ext/isolated/page.js').status_code == 200


def test_frame_check_uses_token_module_routes_and_reports_incompatibilities(client, org):
    root = page(org)
    (root/'page.js').write_text("export function mount(el,ctx){localStorage.getItem('x'); fetch('/api/settings');}")
    result = extcheck.check('isolated')
    assert result['status'] == 'warn', result
    assert any('/f/' in s['detail'] for s in result['steps'] if s['step'] == 'served')
    assert any(s['step'] == 'isolation' for s in result['steps'])


@pytest.mark.parametrize('runtime', [{'page':'other'}, [], {'page':True}])
def test_invalid_mode_is_an_extension_error(client, org, runtime):
    page(org, runtime=runtime)
    assert extensions.get('isolated').error


def test_trusted_page_never_qualifies_for_automatic_activation():
    from maxxing import atelier
    rec = {'type':'page','permissions':{},'check':{'status':'ok'}}
    assert not atelier.qualifies_auto(rec)
    assert not atelier.qualifies_auto({**rec,'runtime':{'page':'trusted'}})
    assert atelier.qualifies_auto({**rec,'runtime':{'page':'frame'}})


def test_page_network_policy_tracks_owner_consent(client, org):
    page(org, permissions={'network':['api.example.com']})
    assert 'https://api.example.com' not in client.get('/ext/isolated/page-frame').headers['content-security-policy']
    assert client.post('/api/extensions/isolated/consent', json={'decision':'always'}).status_code == 200
    assert 'https://api.example.com' in client.get('/ext/isolated/page-frame').headers['content-security-policy']
    assert client.post('/api/extensions/isolated/consent', json={'decision':'deny'}).status_code == 200
    assert 'https://api.example.com' not in client.get('/ext/isolated/page-frame').headers['content-security-policy']


def test_browser_probe_fixture_is_servable_and_warns_about_its_deliberate_attacks(client, org):
    import shutil
    from pathlib import Path
    source = Path(__file__).with_name('fixtures') / 'isolation-check'
    shutil.copytree(source, org.ws / 'extensions/isolation-check')
    result = extcheck.check('isolation-check')
    assert result['status'] == 'warn', result
    assert not any(step['status'] == 'error' for step in result['steps'])
