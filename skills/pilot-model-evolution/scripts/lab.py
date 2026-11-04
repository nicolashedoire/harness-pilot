#!/usr/bin/env python3
"""Model-agnostic experiment ledger. Framework execution belongs to an external adapter."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid


def read(path):
    def bad(value):
        raise ValueError('Non-finite JSON value: ' + value)
    return json.loads(Path(path).read_text(encoding='utf-8'), parse_constant=bad)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with open(temp, 'xb') as f:
            os.chmod(temp, 0o600)
            f.write(canonical(value))
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


@contextmanager
def locked(state):
    Path(state).mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(Path(state) / 'lab.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def folder(state, ident):
    if not re.fullmatch(r'[0-9a-f-]{36}', ident):
        raise ValueError('Invalid experiment id')
    path = Path(state) / 'jobs' / ident
    if not (path / 'job.json').is_file():
        raise ValueError('Experiment not found')
    return path


def update(state, ident, **values):
    with locked(state):
        path = folder(state, ident) / 'job.json'
        job = read(path)
        job.update(values)
        write(path, job)
        return job


def tree(path, limit):
    path = Path(path)
    if path.is_symlink() or not path.exists():
        raise ValueError('Artifact is missing or is a symlink')
    files = [path] if path.is_file() else sorted(path.rglob('*'))
    rows, size = [], 0
    for p in files:
        if p.is_symlink():
            raise ValueError('Artifact symlinks are not supported')
        if p.is_dir():
            continue
        if not p.is_file():
            raise ValueError('Only regular artifact files are supported')
        size += p.stat().st_size
        if size > limit or len(rows) >= 10000:
            raise ValueError('Artifact exceeds the storage or file-count budget')
        h = hashlib.sha256()
        with open(p, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(chunk)
        rows.append({'file': '.' if p == path else p.relative_to(path).as_posix(), 'bytes': p.stat().st_size, 'sha256': h.hexdigest()})
    if not rows:
        raise ValueError('Artifact is empty')
    return rows


def usage(path, limit):
    total, count = 0, 0
    for p in Path(path).rglob('*'):
        if p.is_symlink():
            raise ValueError('Output symlinks are not supported')
        if p.is_file():
            count += 1
            total += p.stat().st_size
            if total > limit or count > 10000:
                raise ValueError('Experiment output exceeds its storage budget')
    return total


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def spec_check(spec):
    if spec.get('version') != 1 or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', str(spec.get('model_id', ''))):
        raise ValueError('Expected protocol version 1 and a model_id')
    if spec.get('operation') not in ('evaluate', 'adapt', 'design') or not isinstance(spec.get('method'), str) or not spec['method']:
        raise ValueError('An operation and method are required')
    command = spec.get('command')
    if not isinstance(command, list) or not command or not all(isinstance(x, str) and x and '\0' not in x for x in command):
        raise ValueError('command must be an argv array')
    if not Path(command[0]).is_absolute() or not Path(command[0]).is_file():
        raise ValueError('Use an absolute path to the trusted local executable')
    baseline = spec.get('baseline')
    if baseline is not None and (not isinstance(baseline, str) or not Path(baseline).is_absolute()):
        raise ValueError('baseline must be an absolute path or null')
    if baseline is None and spec['operation'] != 'design':
        raise ValueError('A baseline is required for evaluation or adaptation')
    budget = spec.get('budget', {})
    if not isinstance(budget.get('seconds'), int) or isinstance(budget['seconds'], bool) or not 1 <= budget['seconds'] <= 86400:
        raise ValueError('Adapter time budget must be between 1 and 86400 seconds')
    if not isinstance(budget.get('bytes'), int) or isinstance(budget['bytes'], bool) or budget['bytes'] < 1024:
        raise ValueError('An explicit storage budget is required')
    criteria = spec.get('criteria')
    if not isinstance(criteria, list) or not criteria:
        raise ValueError('Predeclare at least one acceptance criterion')
    for rule in criteria:
        if not isinstance(rule, dict) or not isinstance(rule.get('metric'), str) or rule.get('goal') not in ('minimize', 'maximize'):
            raise ValueError('Invalid metric criterion')
        bounds = [key for key in ('min_gain', 'max_after', 'min_after') if key in rule]
        if not bounds or any(not number(rule[key]) for key in bounds) or ('min_gain' in rule and rule['min_gain'] < 0):
            raise ValueError('Each criterion requires finite acceptance bounds')
    checks = spec.get('required_checks')
    if not isinstance(checks, list) or not checks or not all(isinstance(x, str) and x for x in checks):
        raise ValueError('Predeclare required evaluation and regression checks')
    return spec


def start(state, spec_path):
    spec = spec_check(read(Path(spec_path).resolve()))
    ident = str(uuid.uuid4())
    root = Path(state).resolve() / 'jobs' / ident
    root.mkdir(parents=True, mode=0o700)
    write(root / 'spec.json', spec)
    write(root / 'job.json', {'id': ident, 'model_id': spec['model_id'], 'name': str(spec.get('name') or spec['model_id'])[:200],
                             'method': spec['method'], 'operation': spec['operation'], 'status': 'queued', 'created': time.time(), 'decision': None})
    with open(root / 'worker.log', 'ab') as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'worker', '--state', str(Path(state).resolve()), '--id', ident],
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    update(state, ident, worker_pid=process.pid)
    return get(state, ident)


def assess(spec, result):
    metrics = result.get('metrics')
    if not isinstance(metrics, list) or not metrics:
        raise ValueError('Adapter must report measured metrics')
    by_name = {}
    for metric in metrics:
        if (not isinstance(metric, dict) or not isinstance(metric.get('name'), str) or metric['name'] in by_name or
                not number(metric.get('after')) or metric.get('before') is not None and not number(metric['before']) or
                not isinstance(metric.get('split'), str) or not metric['split']):
            raise ValueError('Metric names must be unique, values finite, and evaluation splits declared')
        by_name[metric['name']] = metric
    if not isinstance(result.get('summary', ''), str) or len(result.get('summary', '')) > 8000:
        raise ValueError('Report a concise text summary')
    limits = result.get('limitations', [])
    if not isinstance(limits, list) or len(limits) > 50 or not all(isinstance(x, str) and len(x) <= 2000 for x in limits):
        raise ValueError('Report limitations as a list of short text items')
    reasons = []
    checks = result.get('checks', {})
    if not isinstance(checks, dict) or any(type(value) is not bool for value in checks.values()):
        raise ValueError('Adapter checks must be booleans')
    for name in spec['required_checks']:
        if checks.get(name) is not True:
            reasons.append('Required check failed: ' + name)
    for rule in spec['criteria']:
        metric = by_name.get(rule['metric'])
        if metric is None:
            reasons.append('Missing metric: ' + rule['metric'])
            continue
        after, before = metric['after'], metric.get('before')
        ok = ('max_after' not in rule or after <= rule['max_after']) and ('min_after' not in rule or after >= rule['min_after'])
        if 'min_gain' in rule:
            sign = 1 if rule['goal'] == 'minimize' else -1
            ok = ok and before is not None and before != 0 and sign * (before - after) / abs(before) >= rule['min_gain']
        if not ok:
            reasons.append('Metric criterion failed: ' + rule['metric'])
    training = result.get('training', {})
    if not isinstance(training, dict) or any(type(training.get(key)) is not int or training[key] < 0 for key in ('gradient_steps', 'optimizer_steps')):
        raise ValueError('Report nonnegative gradient and optimizer step counts')
    if spec['method'] == 'direct_edit' and any(training[key] != 0 for key in ('gradient_steps', 'optimizer_steps')):
        reasons.append('A direct edit must report zero gradient and optimizer steps')
    return reasons


def stop_process(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
    except ProcessLookupError:
        pass


def notify(job):
    if not os.environ.get('MAXXING_STATE'):
        return
    try:
        from maxxing import config, feed
        french = config.load_config().get('language') == 'fr'
        labels = {'awaiting_review': 'candidat à examiner', 'failed_checks': 'critères non atteints', 'error': 'erreur', 'stopped': 'arrêtée'} if french else {'awaiting_review': 'candidate ready for review', 'failed_checks': 'criteria not met', 'error': 'execution error', 'stopped': 'stopped'}
        feed.system('Expérience de modèle terminée' if french else 'Model experiment ready',
                    f"{job['name']}: {labels.get(job['status'], job['status'])}", 'warning', 'system',
                    '/x/model-lab?run=' + job['id'], dedupe='model-lab:' + job['id'])
    except Exception:
        pass  # Standalone use has no dependency on the host application.


def worker(state, ident):
    root = folder(state, ident)
    process = None
    try:
        spec = spec_check(read(root / 'spec.json'))
        limit = spec['budget']['bytes']
        baseline = Path(spec['baseline']).resolve() if spec.get('baseline') else None
        before = tree(baseline, limit) if baseline else []
        update(state, ident, status='preparing', heartbeat=time.time())
        copied = root / 'input' / 'model'
        if baseline:
            copied.parent.mkdir(mode=0o700)
            if baseline.is_dir():
                shutil.copytree(baseline, copied)
            else:
                shutil.copy2(baseline, copied)
            if tree(copied, limit) != before or tree(baseline, limit) != before:
                raise ValueError('Baseline changed while it was being copied')
        code = [{'path': arg, 'files': tree(Path(arg).resolve(), max(limit, 16 * 1024 * 1024))} for arg in spec['command'] if Path(arg).is_absolute() and Path(arg).is_file()]
        output = root / 'output'
        output.mkdir(mode=0o700)
        write(root / 'request.json', {'version': 1, 'spec': spec, 'baseline': str(copied) if baseline else None, 'output_dir': str(output)})
        update(state, ident, status='running', started=time.time(), baseline_hash=digest(before))
        t0 = time.monotonic()
        with open(root / 'adapter.log', 'wb') as log:
            process = subprocess.Popen([*spec['command'], str(root / 'request.json')], cwd=output,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            while process.poll() is None:
                update(state, ident, heartbeat=time.time())
                if (root / 'stop').exists():
                    raise InterruptedError('Stopped by the operator')
                if time.monotonic() - t0 > spec['budget']['seconds']:
                    raise TimeoutError('Adapter time budget exceeded')
                if (root / 'adapter.log').stat().st_size > 1024 * 1024:
                    raise ValueError('Adapter log budget exceeded')
                # Soft on-disk quota; checks all files, including nested and temporary artifacts.
                if output.exists() and any(output.iterdir()):
                    usage(output, max(0, limit - sum(x['bytes'] for x in before)))
                time.sleep(.25)
            if time.monotonic() - t0 > spec['budget']['seconds'] or (root / 'adapter.log').stat().st_size > 1024 * 1024:
                raise ValueError('Adapter time or log budget exceeded')
            if process.returncode:
                raise ValueError('Adapter failed; inspect the local adapter log')
        if (root / 'stop').exists():
            raise InterruptedError('Stopped by the operator')
        if (output / 'result.json').stat().st_size > 1024 * 1024:
            raise ValueError('Adapter report is too large')
        result = read(output / 'result.json')
        reasons = assess(spec, result)
        relative = result.get('candidate')
        if not isinstance(relative, str) or Path(relative).is_absolute():
            raise ValueError('Candidate must be a relative artifact path')
        candidate = (output / relative).resolve()
        if output.resolve() not in candidate.parents:
            raise ValueError('Candidate must be inside the experiment output directory')
        # Reject symlinks even when they point back inside output.
        for part in (output / relative).parents:
            if part == output:
                break
            if part.is_symlink():
                raise ValueError('Candidate path contains a symlink')
        if (output / relative).is_symlink():
            raise ValueError('Candidate must not be a symlink')
        after = tree(candidate, limit)
        usage(output, max(0, limit - sum(x['bytes'] for x in before)))
        if baseline and (tree(baseline, limit) != before or tree(copied, limit) != before):
            raise ValueError('The adapter modified a source or copied baseline')
        if any(tree(Path(item['path']).resolve(), max(limit, 16 * 1024 * 1024)) != item['files'] for item in code):
            raise ValueError('The adapter executable changed during the experiment')
        if baseline and before == after:
            reasons.append('Candidate artifacts are unchanged')
        proposal = {'spec': spec, 'result': result, 'source_files': before, 'candidate_files': after, 'adapter_files': code,
                    'candidate_path': str(candidate), 'eligible': not reasons, 'reasons': reasons}
        write(root / 'proposal.json', proposal)
        update(state, ident, status='awaiting_review' if not reasons else 'failed_checks', fingerprint=digest(proposal),
               finished=time.time(), seconds=time.monotonic() - t0, eligible=not reasons, reasons=reasons)
    except Exception as error:
        update(state, ident, status='stopped' if isinstance(error, InterruptedError) else 'error',
               error=str(error)[:1000], finished=time.time(), eligible=False)
    finally:
        if process is not None:
            stop_process(process)
        notify(get(state, ident))


def get(state, ident):
    root = folder(state, ident)
    job = read(root / 'job.json')
    if job['status'] in ('queued', 'preparing', 'running') and time.time() - job.get('heartbeat', job['created']) > 15:
        try:
            if job.get('worker_pid', 0) <= 0:
                raise ProcessLookupError()
            os.kill(job['worker_pid'], 0)
        except (ProcessLookupError, PermissionError):
            job = update(state, ident, status='interrupted', eligible=False, error='Worker is no longer running')
    if (root / 'proposal.json').is_file():
        job['proposal'] = read(root / 'proposal.json')
    return job


def all_jobs(state):
    jobs = Path(state) / 'jobs'
    return sorted((get(state, p.name) for p in jobs.iterdir() if (p / 'job.json').is_file()), key=lambda x: x['created'], reverse=True) if jobs.exists() else []


def verify(state, ident, fingerprint):
    root = folder(state, ident)
    job = get(state, ident)
    proposal = job.get('proposal')
    if not proposal or fingerprint != job.get('fingerprint') or digest(proposal) != fingerprint:
        raise ValueError('Proposal changed; review it again')
    limit = proposal['spec']['budget']['bytes']
    if tree(proposal['candidate_path'], limit) != proposal['candidate_files']:
        raise ValueError('Candidate files changed; run a new experiment')
    source = proposal['spec'].get('baseline')
    if source and tree(Path(source).resolve(), limit) != proposal['source_files']:
        raise ValueError('Source baseline changed; run a new experiment')
    return job


def decide(state, ident, fingerprint, decision):
    if decision not in ('approved', 'rejected'):
        raise ValueError('Choose approved or rejected')
    with locked(state):
        job = verify(state, ident, fingerprint)
        if decision == 'approved' and not job.get('eligible'):
            raise ValueError('A candidate that failed its checks cannot be approved')
        if decision == 'rejected':
            pointer = Path(state) / 'selection.json'
            selections = read(pointer) if pointer.exists() else {}
            if selections.get(job['model_id'], {}).get('run') == ident:
                selections.pop(job['model_id'])
                write(pointer, selections)
        job.pop('proposal', None)
        job['decision'] = {'value': decision, 'fingerprint': fingerprint, 'at': time.time(), 'actor': 'user-ui'}
        write(folder(state, ident) / 'job.json', job)
    return get(state, ident)


def select(state, ident, fingerprint):
    with locked(state):
        job = verify(state, ident, fingerprint)
        if ((job.get('decision') or {}).get('value') != 'approved' or
                job['decision'].get('fingerprint') != fingerprint or not job.get('eligible')):
            raise ValueError('Approve the candidate before selecting it')
        pointer = Path(state) / 'selection.json'
        selections = read(pointer) if pointer.exists() else {}
        selections[job['model_id']] = {'run': ident, 'fingerprint': fingerprint, 'candidate': job['proposal']['candidate_path'], 'at': time.time()}
        write(pointer, selections)
    return selections


def stop(state, ident):
    root = folder(state, ident)
    (root / 'stop').touch(mode=0o600)
    return {'ok': True}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['start', 'worker', 'list'])
    p.add_argument('--state', required=True)
    p.add_argument('--spec')
    p.add_argument('--id')
    args = p.parse_args()
    if args.action == 'worker':
        worker(str(Path(args.state).resolve()), args.id)
    else:
        result = start(args.state, args.spec) if args.action == 'start' else all_jobs(args.state)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
