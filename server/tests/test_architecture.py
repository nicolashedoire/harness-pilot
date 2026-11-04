from maxxing import architecture


def test_static_import_map_resolves_local_links(tmp_path):
    py = tmp_path / 'server/maxxing'
    ts = tmp_path / 'web/src'
    py.mkdir(parents=True)
    ts.mkdir(parents=True)
    (py / '__init__.py').write_text('')
    (py / 'source.py').write_text('from . import target\n')
    (py / 'target.py').write_text('x = 1\n')
    (ts / 'one.ts').write_text("import {two} from '@/two'\n")
    (ts / 'two.ts').write_text('export const two = 2\n')
    g = architecture.build(tmp_path)
    links = {(e['from'], e['to']) for e in g['edges']}
    assert ('server/maxxing/source.py', 'server/maxxing/target.py') in links
    assert ('web/src/one.ts', 'web/src/two.ts') in links
