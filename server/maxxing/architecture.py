"""Build a bounded, static source-import map for resident companions."""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

TS_IMPORT = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']''')


def build(repo: Path) -> dict:
    files = sorted([*repo.glob('server/maxxing/**/*.py'), *repo.glob('web/src/**/*.ts'), *repo.glob('web/src/**/*.tsx')])
    files = [p for p in files if p.is_file() and not p.is_symlink()][:3000]
    nodes = {p.relative_to(repo).as_posix(): p for p in files}
    python = {key.removeprefix('server/').removesuffix('.py').replace('/', '.').removesuffix('.__init__'): key
              for key in nodes if key.endswith('.py')}
    edges = set()
    for key, path in nodes.items():
        try:
            content = path.read_text(encoding='utf-8')
            if key.endswith('.py'):
                tree = ast.parse(content)
                package = key.removeprefix('server/').removesuffix('.py').replace('/', '.')
                package = package if path.name == '__init__.py' else package.rpartition('.')[0]
                for node in ast.walk(tree):
                    imports = []
                    if isinstance(node, ast.Import):
                        imports = [n.name for n in node.names]
                    elif isinstance(node, ast.ImportFrom):
                        base = package.split('.')
                        if node.level:
                            base = base[:max(0, len(base) - node.level + 1)]
                            prefix = '.'.join(base + ([node.module] if node.module else []))
                        else:
                            prefix = node.module or ''
                        imports = [prefix] + [f'{prefix}.{n.name}' for n in node.names]
                    for name in imports:
                        dest = python.get(name)
                        if dest and dest != key:
                            edges.add((key, dest))
            else:
                for spec in TS_IMPORT.findall(content):
                    if spec.startswith('@/'):
                        root = repo / 'web/src' / spec[2:]
                    elif spec.startswith('.'):
                        root = path.parent / spec
                    else:
                        continue
                    root = root.resolve()
                    for candidate in (root, Path(str(root) + '.ts'), Path(str(root) + '.tsx'), root / 'index.ts', root / 'index.tsx'):
                        try:
                            dest = candidate.relative_to(repo).as_posix()
                        except ValueError:
                            continue
                        if dest in nodes:
                            if dest != key:
                                edges.add((key, dest))
                            break
        except (OSError, UnicodeError, SyntaxError, ValueError):
            continue
    return {'version': 1, 'description': 'Static Python and TypeScript import links only; runtime and product relationships may be missing.',
            'nodes': list(nodes), 'edges': [{'from': a, 'to': b} for a, b in sorted(edges)][:20000]}


def write(repo: Path) -> Path:
    dest = repo.parent / 'architecture.json'
    dest.write_text(json.dumps(build(repo), ensure_ascii=False), encoding='utf-8')
    return dest
