"""Publish an explicitly approved companion proposal as a GitHub draft PR."""
from __future__ import annotations

import datetime
import fcntl
import hashlib
import os
import re
import subprocess
import tempfile
from pathlib import Path

from . import companions, config
from .sessions import service, store


def _gh(*args: str) -> str:
    try:
        p = subprocess.run(['gh', *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=90, text=True, env={**os.environ, 'GH_PROMPT_DISABLED': '1'})
    except (OSError, subprocess.TimeoutExpired):
        raise service.SessionError(502, 'github_unavailable', 'GitHub CLI is unavailable or timed out.') from None
    if p.returncode:
        raise service.SessionError(502, 'github_failed', 'GitHub operation failed; check CLI authentication and repository access.')
    return p.stdout.strip()


def _export(proposal: dict, fingerprint: str) -> tuple[bytes, list[tuple[str, bytes, bool]]]:
    # Recompute on the exact UTF-8 bytes that will be staged; refuse lossy/non-text proposals.
    patch = proposal['patch'].encode('utf-8')
    additions = [(item['path'], item['content'].encode('utf-8'), item['executable']) for item in proposal['untracked']]
    digest = hashlib.sha256(patch)
    for name, data, executable in additions:
        digest.update(name.encode() + b'\0' + data + b'\0' + (b'x' if executable else b'-'))
    if digest.hexdigest() != fingerprint:
        raise service.SessionError(409, 'changed', 'The proposal cannot be exported exactly; review it again.')
    return patch, additions


def publish(sid: str, fingerprint: str, title: str, body: str) -> dict:
    if not store.is_valid_id(sid) or not re.fullmatch(r'[0-9a-f]{64}', fingerprint):
        raise service.SessionError(400, 'bad_request', 'Invalid proposal.')
    title, body = title.strip(), body.strip()
    if not title or len(title) > 180 or len(body) > 12000 or '\n' in title or '\r' in title:
        raise service.SessionError(400, 'bad_request', 'Invalid pull request title or description.')
    lock_path = config.state_dir('companions', 'pr-locks') / f'{sid}.lock'
    with open(lock_path, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        proposal = companions.review(sid)
        decision = proposal.get('decision') or {}
        if (proposal['session']['state'] == 'running' or not proposal['has_changes'] or
                proposal['fingerprint'] != fingerprint or decision.get('value') != 'approved' or
                decision.get('fingerprint') != fingerprint):
            raise service.SessionError(409, 'not_approved', 'Approve the current finished proposal before creating a pull request.')
        target = proposal.get('target')
        if not target:
            raise service.SessionError(400, 'no_github_origin', 'The platform checkout needs a GitHub origin.')
        patch, additions = _export(proposal, fingerprint)
        meta = store.read(sid) or {}
        base = (meta.get('companion') or {}).get('base', '')
        stamp = datetime.datetime.fromtimestamp(float(decision['at']), datetime.timezone.utc).isoformat()
        branch = f'pilot/companion-{sid}-{fingerprint[:12]}'
        repo_url = f'https://github.com/{target}.git'
        with tempfile.TemporaryDirectory(prefix='pilot-pr-', dir=config.state_dir('companions')) as temp:
            repo = Path(temp) / 'repo'
            companions._git(config.CODE, 'clone', '--quiet', '--no-local', '--', config.CODE.resolve().as_uri(), str(repo), limit=1000)
            companions._git(repo, 'checkout', '--quiet', '--detach', base, limit=1000)
            if patch:
                patch_path = Path(temp) / 'proposal.patch'
                patch_path.write_bytes(patch)
                companions._git(repo, 'apply', '--index', '--binary', str(patch_path), limit=1000)
                actual = companions._git(repo, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', base, '--')
                if actual != patch:
                    raise service.SessionError(409, 'changed', 'The proposal could not be reproduced exactly.')
            for name, data, executable in additions:
                dest = (repo / name).resolve()
                if repo.resolve() not in dest.parents:
                    raise service.SessionError(400, 'bad_path', 'The proposal contains an unsafe path.')
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                dest.chmod(0o755 if executable else 0o644)
            if companions._git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--'):
                raise service.SessionError(409, 'changed', 'The proposal contains unexpected changes.')
            companions._git(repo, 'checkout', '-b', branch, limit=1000)
            companions._git(repo, 'add', '-A', '--', '.', limit=1000)
            companions._git(repo, '-c', 'user.name=Harness Pilot', '-c', 'user.email=harness-pilot@users.noreply.github.com',
                            'commit', '--quiet', '-m', 'Prepare reviewed companion proposal', limit=1000,
                            extra_env={'GIT_AUTHOR_DATE': stamp, 'GIT_COMMITTER_DATE': stamp})
            default = _gh('repo', 'view', target, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name')
            if not re.fullmatch(r'[A-Za-z0-9._/-]+', default) or '..' in default:
                raise service.SessionError(400, 'bad_branch', 'The repository default branch is invalid.')
            # The approved base must be on the default branch: no unrelated feature commits in the PR.
            credentials = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
            companions._git(repo, *credentials, 'fetch', '--quiet', repo_url, f'refs/heads/{default}:refs/remotes/pilot-base', limit=1000)
            try:
                companions._git(repo, 'merge-base', '--is-ancestor', base, 'refs/remotes/pilot-base', limit=1000)
            except service.SessionError:
                raise service.SessionError(409, 'base_not_default', 'The experiment base is not on the repository default branch.') from None
            companions._git(repo, *credentials, 'push', '--quiet', repo_url, f'{branch}:refs/heads/{branch}', limit=1000)
            url = _gh('pr', 'list', '--repo', target, '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""')
            if not url:
                url = _gh('pr', 'create', '--repo', target, '--head', branch, '--base', default,
                          '--title', title, '--body', body, '--draft')
        expected = f'https://github.com/{target}/pull/'
        if not url.startswith(expected) or not url[len(expected):].isdigit():
            raise service.SessionError(502, 'github_failed', 'GitHub returned an unexpected pull request URL.')
        with store.edit(sid) as item:
            item['companion']['pull_request'] = {'url': url, 'fingerprint': fingerprint}
        return {'url': url, 'target': target}
