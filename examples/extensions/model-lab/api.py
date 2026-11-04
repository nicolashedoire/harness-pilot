"""Optional Model Lab page bridge. All model work is delegated to external adapters."""
import importlib.util
from pathlib import Path


def _engine(ctx):
    root = Path(ctx['workspace'])
    for path in (root / '.agents/skills/model-evolution/scripts/lab.py', root / '.claude/skills/model-evolution/scripts/lab.py'):
        if path.is_file():
            spec = importlib.util.spec_from_file_location('pilot_model_lab', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise ValueError('Install the model-evolution skill in this workspace before using Model Lab.')


def handle(ctx, method, path, query, body):
    lab = _engine(ctx)
    state = ctx['state_dir']
    body = body if isinstance(body, dict) else {}
    if method == 'GET' and path == 'overview':
        selection = Path(state) / 'selection.json'
        jobs = lab.all_jobs(state)[:100]
        for job in jobs:
            if 'proposal' in job:
                job['proposal'] = {'result': job['proposal']['result'], 'criteria': job['proposal']['spec']['criteria']}
        return {'runs': jobs, 'selection': lab.read(selection) if selection.exists() else {}}
    if method == 'POST' and path == 'runs':
        spec = body.get('spec_path')
        if not isinstance(spec, str) or not Path(spec).is_absolute():
            raise ValueError('Choose an absolute path to a trusted local experiment spec.')
        return lab.start(state, spec)
    parts = path.split('/')
    if len(parts) in (2, 3) and parts[0] == 'runs':
        ident = parts[1]
        if method == 'GET' and len(parts) == 2:
            return lab.get(state, ident)
        if method == 'POST' and len(parts) == 3:
            if parts[2] == 'stop':
                return lab.stop(state, ident)
            if parts[2] == 'decision':
                return lab.decide(state, ident, body.get('fingerprint'), body.get('decision'))
            if parts[2] == 'select':
                return lab.select(state, ident, body.get('fingerprint'))
    raise LookupError('Unknown Model Lab endpoint')
