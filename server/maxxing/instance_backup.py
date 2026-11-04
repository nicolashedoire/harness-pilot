"""Encrypted, portable instance data snapshots; restores always create a separate instance."""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import shlex
import stat
import tempfile
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from . import __version__, config, uploads

MAGIC = b'PILOTBK1\n'
CHUNK = 1024 * 1024
MAX_ENTRIES = 100000
MANIFEST_MAX = 32 * CHUNK
PREVIEW_TTL = 24 * 60 * 60
_ID = re.compile(r'^[a-f0-9]{32}$')
_STATE_RUNTIME = {'instance-backups', 'instance-restores', 'tools', 'node', 'nodejs',
                  'search.db', 'search.db-wal', 'search.db-shm'}


class SnapshotError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


def _base() -> Path:
    root = config.state_dir('instance-backups')
    root.chmod(0o700)
    return root


def _limit() -> int:
    return max(1, min(int(config.load_config().get('instance_backup_max_mb') or 2048), 1024 * 1024)) * CHUNK


def _archive_limit() -> int:
    # Incompressible data still needs ZIP headers, a manifest and an authentication header.
    return _limit() + MANIFEST_MAX + MAX_ENTRIES * 1024 + CHUNK


def _purge_previews():
    """Called with the operation lock held: expired previews go, and so does the plaintext staging of an export that
    was interrupted (server stopped mid-export) - no export can be running while the lock is held."""
    for directory in (_base() / 'imports').glob('*'):
        if directory.is_dir() and time.time() - directory.stat().st_mtime > PREVIEW_TTL:
            shutil.rmtree(directory)
    for directory in _base().glob('export-*'):
        if directory.is_dir() and not directory.is_symlink():
            shutil.rmtree(directory)


@contextlib.contextmanager
def _lock():
    with (_base() / 'operation.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SnapshotError('busy', 'Another instance backup operation is in progress.', 409) from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _key(password: str, salt: bytes) -> bytes:
    if not isinstance(password, str) or not 12 <= len(password) <= 1024:
        raise SnapshotError('passphrase', 'Use a backup passphrase between 12 and 1024 characters.')
    try:
        return hashlib.scrypt(password.encode('utf-8'), salt=salt, n=32768, r=8, p=1,
                              maxmem=128 * CHUNK, dklen=32)
    except UnicodeError:
        raise SnapshotError('passphrase', 'The passphrase contains an invalid character.') from None


def _crypt(source: Path, destination: Path, password: str, *, decrypt: bool = False):
    """Authenticate the whole stream before a decrypted ZIP is admitted for inspection."""
    try:
        with source.open('rb') as incoming, destination.open('xb') as outgoing:
            os.chmod(destination, 0o600)
            if decrypt:
                header = incoming.read(len(MAGIC) + 28)
                if len(header) != len(MAGIC) + 28 or not header.startswith(MAGIC):
                    raise SnapshotError('format', 'This is not a supported encrypted instance backup.')
                salt, nonce = header[len(MAGIC):len(MAGIC) + 16], header[-12:]
                remaining = source.stat().st_size - len(header) - 16
                if remaining < 0:
                    raise SnapshotError('format', 'The backup is truncated.')
                incoming.seek(-16, os.SEEK_END)
                tag = incoming.read(16)
                incoming.seek(len(header))
                operation = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce, tag)).decryptor()
            else:
                salt, nonce = os.urandom(16), os.urandom(12)
                header = MAGIC + salt + nonce
                outgoing.write(header)
                remaining = source.stat().st_size
                operation = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce)).encryptor()
            operation.authenticate_additional_data(header)
            while remaining:
                block = incoming.read(min(CHUNK, remaining))
                if not block:
                    raise SnapshotError('format', 'The backup is truncated.')
                outgoing.write(operation.update(block))
                remaining -= len(block)
            outgoing.write(operation.finalize())
            if not decrypt:
                outgoing.write(operation.tag)
            outgoing.flush()
            os.fsync(outgoing.fileno())
    except InvalidTag:
        destination.unlink(missing_ok=True)
        raise SnapshotError('decrypt_failed', 'The passphrase is incorrect or the backup has been modified.') from None
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def _idle():
    for path in (config.STATE / 'sessions').glob('*.json'):
        session = config.read_json(path, {})
        if session.get('state') == 'running' or session.get('queue'):
            raise SnapshotError('sessions_active', 'Finish or stop active and queued sessions before a full snapshot.', 409)
    for path in (config.STATE / 'crons' / 'locks').glob('*.lock'):
        with path.open() as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SnapshotError('crons_active', 'Wait for running scheduled tasks before a full snapshot.', 409) from None
            fcntl.flock(handle, fcntl.LOCK_UN)


def _roots() -> dict[str, dict]:
    cfg = config.load_config()
    paths = {'state': config.STATE, 'workspace': Path(cfg['workspace']), 'files': config.files_root()}
    result, known = {}, {}
    for name, path in paths.items():
        real = path.resolve()
        if real == Path(real.anchor) or real == Path.home():
            raise SnapshotError('broad_root', f'The {name} root must be a dedicated application data directory.')
        if not real.is_dir():
            raise SnapshotError('missing_root', f'The {name} data directory is unavailable.')
        alias = known.setdefault(real, name)
        result[name] = {'source': str(real), 'archive': alias}
    return result


def _relative_target(path: Path, roots: dict) -> str | None:
    for root in sorted(roots.values(), key=lambda r: len(r['source']), reverse=True):
        try:
            relative = path.relative_to(root['source'])
        except ValueError:
            continue
        return (PurePosixPath(root['archive']) / relative.as_posix()).as_posix()
    return None


def _inventory(roots: dict) -> tuple[list[dict], dict[str, Path]]:
    entries, sources, total = [], {}, 0
    visited = set()
    for root in roots.values():
        source, alias = Path(root['source']), root['archive']
        if source in visited:
            continue
        visited.add(source)
        nested = {Path(other['source']) for other in roots.values()
                  if source != Path(other['source']) and source in Path(other['source']).parents}
        for folder, directories, files in os.walk(source, followlinks=False, onerror=lambda error: (_ for _ in ()).throw(error)):
            parent = Path(folder)
            for name in sorted([*directories, *files]):
                item = parent / name
                relative = item.relative_to(source)
                if item in nested or (alias == roots['state']['archive'] and
                                      (relative.parts[0] in _STATE_RUNTIME or name.endswith(('.lock', '.pid', '.run', '.tmp')))):
                    if name in directories:
                        directories.remove(name)
                    continue
                archive_path = (PurePosixPath(alias) / relative.as_posix()).as_posix()
                _safe_name(archive_path)
                info = item.lstat()
                record = {'path': archive_path, 'mode': stat.S_IMODE(info.st_mode) & 0o777,
                          'mtime_ns': info.st_mtime_ns,
                          'stamp': [info.st_ino, info.st_size, info.st_mtime_ns]}
                if stat.S_ISLNK(info.st_mode):
                    target = item.resolve()
                    record.update(kind='symlink', link_to=_relative_target(target, roots), external=str(target))
                elif stat.S_ISDIR(info.st_mode):
                    record.update(kind='directory')
                    record.pop('stamp')  # creating a transient lock need not invalidate a directory
                elif stat.S_ISREG(info.st_mode):
                    record.update(kind='file', size=info.st_size)
                    total += info.st_size
                else:
                    raise SnapshotError('unsupported_file', f'A special file cannot be included: {archive_path}')
                entries.append(record)
                sources[archive_path] = item
                if len(entries) > MAX_ENTRIES or total > _limit():
                    raise SnapshotError('too_large', 'The snapshot exceeds instance_backup_max_mb or its entry limit.', 413)
    available = set(sources) | {r['archive'] for r in roots.values()}
    for entry in entries:
        if entry['kind'] == 'symlink' and entry.get('link_to') not in available:
            entry['link_to'] = None  # excluded runtime dependencies must be reinstalled too
    return sorted(entries, key=lambda r: r['path']), sources


def _safe_name(name: str) -> PurePosixPath:
    if not isinstance(name, str):
        raise SnapshotError('unsafe_path', 'The archive contains an unsafe data path.')
    path = PurePosixPath(name)
    if (not isinstance(name, str) or '\\' in name or '\x00' in name or path.is_absolute()
            or name != path.as_posix() or '..' in path.parts or not path.parts
            or path.parts[0] not in ('state', 'workspace', 'files')):
        raise SnapshotError('unsafe_path', 'The archive contains an unsafe data path.')
    try:
        name.encode('utf-8')
    except UnicodeError:
        raise SnapshotError('unsafe_path', 'A filename cannot be represented in a portable archive.') from None
    return path


def _digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _description(manifest: dict) -> dict:
    entries = manifest['entries']
    return {'version': manifest['version'], 'created': manifest['created'],
            'files': sum(e['kind'] == 'file' for e in entries),
            'bytes': sum(e.get('size', 0) for e in entries),
            'external_links': [e['path'] for e in entries if e['kind'] == 'symlink' and not e.get('link_to')],
            'includes': ['settings_and_credentials', 'sessions', 'attachments', 'workspace', 'files', 'space_labels'],
            'excludes': ['application_and_provider_binaries', 'temporary_runtime_files', 'external_symlink_targets']}


def export(password: str) -> dict:
    with _lock():
        _purge_previews()
        _idle()
        roots = _roots()
        before, sources = _inventory(roots)
        from .api.space_labels import list_labels
        labels = list_labels()
        ident = uuid.uuid4().hex
        exports = _base() / 'exports'
        exports.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='export-', dir=_base()) as temporary:
            archive = Path(temporary) / 'snapshot.zip'
            entries = []
            with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=3) as bundle:
                for original in before:
                    record = {k: v for k, v in original.items() if k != 'stamp'}
                    if record['kind'] == 'file':
                        uploads.check_room(archive.parent, record['size'])
                        digest, count = hashlib.sha256(), 0
                        with sources[record['path']].open('rb') as src, bundle.open('data/' + record['path'], 'w') as dest:
                            while block := src.read(CHUNK):
                                dest.write(block)
                                digest.update(block)
                                count += len(block)
                                if count > record['size']:
                                    raise SnapshotError('source_changed', 'Data changed during the snapshot; retry when idle.', 409)
                        if count != record['size']:
                            raise SnapshotError('source_changed', 'Data changed during the snapshot; retry when idle.', 409)
                        record['sha256'] = digest.hexdigest()
                    entries.append(record)
                after, _ = _inventory(roots)
                _idle()
                if after != before:
                    raise SnapshotError('source_changed', 'Data changed during the snapshot; no backup was published.', 409)
                manifest = {'format': 'pilot-instance', 'schema': 1, 'version': __version__, 'created': time.time(),
                            'roots': roots, 'entries': entries,
                            'space_labels': {_relative_target(Path(path), roots): label for path, label in labels.items()
                                             if _relative_target(Path(path), roots)}}
                bundle.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
            if archive.stat().st_size > _archive_limit():
                raise SnapshotError('too_large', 'The archive exceeds the portable backup limit.', 413)
            destination = exports / f'{ident}.pilotbackup'
            uploads.check_room(destination.parent, archive.stat().st_size)
            _crypt(archive, destination, password)
        result = {'id': ident, 'sha256': _digest(destination), 'archive_bytes': destination.stat().st_size,
                  **_description(manifest)}
        config.write_json(exports / f'{ident}.json', result)
        return result


def exported(ident: str) -> Path:
    if not _ID.fullmatch(ident):
        raise SnapshotError('not_found', 'Backup not found.', 404)
    path = _base() / 'exports' / f'{ident}.pilotbackup'
    if not path.is_file():
        raise SnapshotError('not_found', 'Backup not found.', 404)
    return path


def _validate(path: Path) -> dict:
    try:
        with zipfile.ZipFile(path) as bundle:
            infos = bundle.infolist()
            names = [i.filename for i in infos]
            if len(infos) > MAX_ENTRIES + 1 or len(set(names)) != len(names) or 'manifest.json' not in names:
                raise SnapshotError('manifest', 'The snapshot inventory is invalid.')
            if bundle.getinfo('manifest.json').file_size > MANIFEST_MAX:
                raise SnapshotError('manifest', 'The snapshot manifest is too large.')
            manifest = json.loads(bundle.read('manifest.json'))
            if (not isinstance(manifest, dict) or manifest.get('format') != 'pilot-instance'
                    or manifest.get('schema') != 1):
                raise SnapshotError('format', 'The snapshot schema is not supported.')
            if (not isinstance(manifest.get('version'), str) or len(manifest['version']) > 128
                    or not isinstance(manifest.get('created'), (float, int))):
                raise SnapshotError('manifest', 'The snapshot metadata is invalid.')
            roots, entries = manifest['roots'], manifest['entries']
            if (set(roots) != {'state', 'workspace', 'files'} or roots['state']['archive'] != 'state'
                    or any(not isinstance(r, dict) or r.get('archive') not in roots
                           or not isinstance(r.get('source'), str) or not Path(r['source']).is_absolute()
                           or Path(r['source']) == Path(Path(r['source']).anchor) for r in roots.values())
                    or not isinstance(entries, list) or len(entries) > MAX_ENTRIES):
                raise SnapshotError('manifest', 'The snapshot roots are invalid.')
            expected, seen, total = {'manifest.json'}, set(), 0
            labels = manifest.get('space_labels', {})
            if not isinstance(labels, dict) or len(labels) > MAX_ENTRIES:
                raise SnapshotError('manifest', 'The snapshot labels are invalid.')
            for name, label in labels.items():
                _safe_name(name)
                if label not in ('personal', 'agents', 'shared'):
                    raise SnapshotError('manifest', 'A snapshot label is invalid.')
            for entry in entries:
                name = _safe_name(entry['path']).as_posix()
                if name in seen:
                    raise SnapshotError('manifest', 'The snapshot contains duplicate entries.')
                seen.add(name)
                if entry['kind'] == 'file':
                    member = 'data/' + name
                    expected.add(member)
                    info = bundle.getinfo(member)
                    if not isinstance(entry['size'], int) or entry['size'] < 0 or info.file_size != entry['size']:
                        raise SnapshotError('manifest', 'An archived file has an invalid size.')
                    total += info.file_size
                    if total > _limit():
                        raise SnapshotError('too_large', 'The restored data exceeds instance_backup_max_mb.', 413)
                    with bundle.open(member) as src:
                        digest = hashlib.file_digest(src, 'sha256').hexdigest()
                    if digest != entry['sha256']:
                        raise SnapshotError('integrity', 'An archived file does not match its snapshot fingerprint.')
                elif entry['kind'] == 'symlink':
                    if entry.get('link_to'):
                        _safe_name(entry['link_to'])
                elif entry['kind'] != 'directory':
                    raise SnapshotError('manifest', 'An entry type is unsupported.')
                if not isinstance(entry.get('mode'), int) or not 0 <= entry['mode'] <= 0o777:
                    raise SnapshotError('manifest', 'An entry has unsafe permissions.')
                if 'mtime_ns' in entry and (not isinstance(entry['mtime_ns'], int)
                                           or not -(2**63) <= entry['mtime_ns'] < 2**63):
                    raise SnapshotError('manifest', 'An entry has an invalid timestamp.')
            if set(names) != expected:
                raise SnapshotError('manifest', 'The snapshot contains unlisted data.')
            if ('data/state/config.json' not in expected
                    or bundle.getinfo('data/state/config.json').file_size > 8 * CHUNK
                    or not isinstance(json.loads(bundle.read('data/state/config.json')), dict)):
                raise SnapshotError('manifest', 'The snapshot has no valid application configuration.')
            # A file or symlink must never be an ancestor of another entry.
            terminal = {e['path'] for e in entries if e['kind'] != 'directory'}
            if any(any(parent.as_posix() in terminal for parent in PurePosixPath(name).parents) for name in seen):
                raise SnapshotError('unsafe_path', 'The snapshot contains a conflicting path hierarchy.')
            return manifest
    except SnapshotError:
        raise
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError):
        raise SnapshotError('manifest', 'The snapshot is invalid or incomplete.') from None


def inspect(source: Path, password: str) -> dict:
    with _lock():
        _purge_previews()
        if source.stat().st_size > _archive_limit():
            raise SnapshotError('too_large', 'The archive exceeds instance_backup_max_mb.', 413)
        ident = uuid.uuid4().hex
        root = _base() / 'imports' / ident
        root.mkdir(parents=True, mode=0o700)
        try:
            archive = root / 'snapshot.zip'
            _crypt(source, archive, password, decrypt=True)
            manifest = _validate(archive)
            result = {'id': ident, 'sha256': _digest(archive), **_description(manifest)}
            config.write_json(root / 'preview.json', result, mode=0o600)
            return result
        except Exception:
            shutil.rmtree(root)
            raise


def restore(ident: str, fingerprint: str) -> dict:
    if not _ID.fullmatch(ident) or not re.fullmatch(r'[a-f0-9]{64}', fingerprint):
        raise SnapshotError('preview_required', 'Inspect the archive before restoring it.')
    with _lock():
        _purge_previews()
        root = _base() / 'imports' / ident
        archive = root / 'snapshot.zip'
        preview = config.read_json(root / 'preview.json', {})
        if not preview or preview.get('sha256') != fingerprint or not archive.is_file() or _digest(archive) != fingerprint:
            raise SnapshotError('changed', 'The archive changed or its preview expired. Inspect it again.', 409)
        manifest = _validate(archive)
        uploads.check_room(config.STATE.parent, preview['bytes'])
        destination = config.STATE.parent / f'pilot-restored-{uuid.uuid4().hex[:12]}'
        destination.mkdir(mode=0o700)  # never overwrite an existing instance
        try:
            for alias in {r['archive'] for r in manifest['roots'].values()}:
                (destination / alias).mkdir(mode=0o700)
            with zipfile.ZipFile(archive) as bundle:
                for entry in manifest['entries']:
                    path = destination / entry['path']
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if entry['kind'] == 'directory':
                        path.mkdir(exist_ok=True)
                    elif entry['kind'] == 'file':
                        with bundle.open('data/' + entry['path']) as src, path.open('xb') as dest:
                            shutil.copyfileobj(src, dest, CHUNK)
            for entry in manifest['entries']:
                if entry['kind'] == 'symlink' and entry.get('link_to'):
                    path, target = destination / entry['path'], destination / entry['link_to']
                    path.symlink_to(os.path.relpath(target, path.parent))
            _retarget(destination, manifest)
            for entry in reversed(manifest['entries']):
                path = destination / entry['path']
                if path.is_symlink() or path.exists():
                    if not path.is_symlink():
                        path.chmod(0o600 if entry['path'] in ('state/config.json', 'state/secrets.json') else entry['mode'])
                    if isinstance(entry.get('mtime_ns'), int):
                        os.utime(path, ns=(entry['mtime_ns'], entry['mtime_ns']), follow_symlinks=False)
            result = {'destination': str(destination), 'state': str(destination / manifest['roots']['state']['archive']),
                      'background_services_paused': True, 'integrations_paused': True, **preview}
            # Its own crontab file: a review copy never writes the system crontab nor the current instance's jobs.
            result['launch_command'] = (f"MAXXING_STATE={shlex.quote(result['state'])} "
                f"MAXXING_CRONTAB_FILE={shlex.quote(str(destination / 'crontab'))} uv run --directory "
                f"{shlex.quote(str(config.CODE / 'server'))} python -m uvicorn maxxing.app:create_app "
                '--factory --host 127.0.0.1 --port 8790')
            config.write_json(destination / 'restore-report.json', result, mode=0o600)
            archive.unlink()  # plaintext credentials are no longer needed in the import staging area
            return result
        except Exception:
            shutil.rmtree(destination)
            raise


def _retarget(destination: Path, manifest: dict):
    roots = manifest['roots']
    replacements = [(r['source'], str(destination / r['archive'])) for r in roots.values()]
    replacements.sort(key=lambda pair: len(pair[0]), reverse=True)
    path_keys = {'path', 'cwd', 'file', 'workspace', 'files_root', 'root', 'repo', 'attachments', 'voice'}

    def rewrite(value, key=''):
        if isinstance(value, dict):
            return {k: rewrite(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [rewrite(v, key) for v in value]
        if isinstance(value, str) and key in path_keys and '\n' not in value:
            for before, after in replacements:
                if value == before or value.startswith(before + '/'):
                    return after + value[len(before):]
        return value

    state = destination / roots['state']['archive']
    for path in state.rglob('*.json'):
        if path.is_symlink():
            continue
        try:
            original = json.loads(path.read_text())
            changed = rewrite(original)
            if path.parent == state / 'sessions' and isinstance(changed, dict):
                changed.update(state='idle', pid=None, unit=None, fresh=True)
                changed.pop('codex_thread_id', None)
            if path == state / 'config.json':
                changed.update(workspace=str(destination / roots['workspace']['archive']),
                               files_root=str(destination / roots['files']['archive']),
                               restored_path_aliases=[{'source': a, 'target': b} for a, b in replacements],
                               restore_hold=True, integrations_paused=True, bind='127.0.0.1', public_url='')
            if changed != original:
                config.write_json(path, changed, mode=0o600)
        except (OSError, ValueError, UnicodeError):
            if path == state / 'config.json':
                raise SnapshotError('restore_config', 'The restored configuration could not be prepared safely.') from None
            continue  # opaque plugin JSON is preserved byte-for-byte
    labels = {}
    for name, label in manifest.get('space_labels', {}).items():
        path = destination / name
        try:
            info = path.stat()
            labels[str(path)] = {'label': label, 'identity': [info.st_dev, info.st_ino]}
        except OSError:
            continue
    config.write_json(state / 'space-labels' / 'labels.json', labels, mode=0o600)


def status() -> dict:
    with contextlib.suppress(SnapshotError):          # opening Settings -> Backup also clears expired plaintext
        with _lock():
            _purge_previews()
    try:
        roots, error = _roots(), None
    except SnapshotError as problem:
        roots, error = {}, str(problem)
    return {'max_bytes': _limit(), 'restore_hold': bool(config.load_config().get('restore_hold')),
            'integrations_paused': config.integrations_paused(),
            'roots': roots, 'export_error': error, 'requires_idle_sessions': True}


def resume_integrations() -> dict:
    """The owner stopped the original instance: scheduled jobs go back into this copy's crontab and the GitHub
    memory backup may push again. The caller restarts the Telegram poller (an async service)."""
    if config.load_config().get('restore_hold'):
        raise SnapshotError('restore_hold', 'Enable this instance’s services before resuming its integrations.', 409)
    config.update_config(integrations_paused=False)
    from . import bus, crons
    crons.sync_crontab()
    bus.invalidate('crons', 'backup', 'telegram')
    return {'ok': True, 'scheduled_jobs': len(crons.managed_lines(crons._load_raw()))}
