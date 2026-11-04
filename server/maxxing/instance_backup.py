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
import struct
import tempfile
import time
import unicodedata
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from . import __version__, config, uploads

CHUNK = 1024 * 1024
# Encrypted file = header | AES-256-GCM ciphertext of the ZIP | 16-byte tag. The whole header is the GCM associated
# data: its magic, format version, KDF identifier, scrypt cost (log2 N, r, p), salt and nonce are all authenticated.
MAGIC = b'PILOTBK\n'
FORMAT_VERSION = 2
KDF_SCRYPT = 1
SCRYPT_DEFAULT = (15, 8, 1)               # log2(N), r, p used for new archives
_HEADER = struct.Struct('>8sBBBHH16s12s')  # magic, version, kdf, log2(N), r, p, salt, nonce
# Bounds read from an archive header, checked before any key derivation: a crafted archive cannot make the preview
# allocate or compute without limit (the defaults need 32 MiB and N·r·p = 2^18).
KDF_LOG_N, KDF_R, KDF_P = (14, 20), (1, 16), (1, 4)
KDF_MAX_MEMORY = 128 * CHUNK              # 128·N·r bytes
KDF_MAX_WORK = 1 << 21                    # N·r·p
MAX_ENTRIES = 100000
MANIFEST_MAX = 32 * CHUNK
PREVIEW_TTL = 60 * 60            # a verified preview holds decrypted data (credentials included): one hour at most
PURGE_EVERY = 10 * 60            # the server's purge pass runs at least this often, and right when a preview expires
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


def _check_kdf(log_n: int, r: int, p: int):
    if not (KDF_LOG_N[0] <= log_n <= KDF_LOG_N[1] and KDF_R[0] <= r <= KDF_R[1] and KDF_P[0] <= p <= KDF_P[1]
            and 128 * (1 << log_n) * r <= KDF_MAX_MEMORY and (1 << log_n) * r * p <= KDF_MAX_WORK):
        raise SnapshotError('kdf_params', 'The archive asks for key-derivation settings outside the accepted bounds.')


def _key(password: str, salt: bytes, log_n: int, r: int, p: int) -> bytes:
    # NFC on export and import: an accented letter typed precomposed or as letter + combining mark is one key.
    if isinstance(password, str):
        password = unicodedata.normalize('NFC', password)
    if not isinstance(password, str) or not 12 <= len(password) <= 1024:
        raise SnapshotError('passphrase', 'Use a backup passphrase between 12 and 1024 characters.')
    _check_kdf(log_n, r, p)
    try:
        return hashlib.scrypt(password.encode('utf-8'), salt=salt, n=1 << log_n, r=r, p=p,
                              maxmem=2 * KDF_MAX_MEMORY, dklen=32)
    except UnicodeError:
        raise SnapshotError('passphrase', 'The passphrase contains an invalid character.') from None


def _read_header(incoming) -> tuple[bytes, tuple[int, int, int], bytes, bytes]:
    header = incoming.read(_HEADER.size)
    if len(header) != _HEADER.size or not header.startswith(MAGIC):
        raise SnapshotError('format', 'This is not a supported encrypted instance backup.')
    _, version, kdf, log_n, r, p, salt, nonce = _HEADER.unpack(header)
    if version != FORMAT_VERSION or kdf != KDF_SCRYPT:
        raise SnapshotError('format', 'This archive format version is not supported by this application version.')
    _check_kdf(log_n, r, p)
    return header, (log_n, r, p), salt, nonce


def _crypt(source: Path, destination: Path, password: str | None, *, decrypt: bool = False,
           sealed: tuple[bytes, tuple[int, int, int], bytes] | None = None):
    """Authenticate the whole stream before a decrypted ZIP is admitted for inspection. `sealed` = (salt, cost, key)
    of a schedule: the key was derived from the passphrase with that salt and cost, which the header records."""
    try:
        with source.open('rb') as incoming, destination.open('xb') as outgoing:
            os.chmod(destination, 0o600)
            if decrypt:
                header, cost, salt, nonce = _read_header(incoming)
                remaining = source.stat().st_size - len(header) - 16
                if remaining < 0:
                    raise SnapshotError('format', 'The backup is truncated.')
                incoming.seek(-16, os.SEEK_END)
                tag = incoming.read(16)
                incoming.seek(len(header))
                operation = Cipher(algorithms.AES(_key(password, salt, *cost)), modes.GCM(nonce, tag)).decryptor()
            else:
                if sealed:
                    salt, cost, key = sealed
                else:
                    salt, cost = os.urandom(16), SCRYPT_DEFAULT
                    key = _key(password, salt, *cost)
                nonce = os.urandom(12)
                header = _HEADER.pack(MAGIC, FORMAT_VERSION, KDF_SCRYPT, *cost, salt, nonce)
                outgoing.write(header)
                remaining = source.stat().st_size
                operation = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
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


_ROOT_LABEL = {'state': 'application data folder', 'workspace': 'workspace folder', 'files': 'Files page folder'}


def _broad(path: Path) -> bool:
    """The filesystem root, the home folder or one of its ancestors (/home, /Users): never archived whole."""
    home = Path.home().resolve()
    return path == Path(path.anchor) or path == home or path in home.parents


def _included(roots: dict) -> dict[str, dict]:
    return {name: root for name, root in roots.items() if root.get('archive')}


def _roots() -> dict[str, dict]:
    """The data roots. A broad state or workspace root is refused. A broad files root (the Files page scope: the home
    folder on default installs) is recorded as not included (`archive: None`) and never read: the application's own
    data - settings, credentials, conversations, attachments (<topic>/attachments), projects - lives in the other two."""
    cfg = config.load_config()
    paths = {'state': config.STATE, 'workspace': Path(cfg['workspace']), 'files': config.files_root()}
    result, known = {}, {}
    for name, path in paths.items():
        real = path.resolve()
        if _broad(real):
            if name == 'files':
                result[name] = {'source': str(real), 'archive': None, 'excluded': 'broad_root'}
                continue
            raise SnapshotError('broad_root', f'The {_ROOT_LABEL[name]} is the filesystem root, your home folder or a '
                                'folder containing it. Move it to a dedicated folder to create a complete backup.')
        if not real.is_dir():
            raise SnapshotError('missing_root', f'The {name} data directory is unavailable.')
        alias = known.setdefault(real, name)
        result[name] = {'source': str(real), 'archive': alias}
    return result


def _relative_target(path: Path, roots: dict) -> str | None:
    for root in sorted(_included(roots).values(), key=lambda r: len(r['source']), reverse=True):
        try:
            relative = path.relative_to(root['source'])
        except ValueError:
            continue
        return (PurePosixPath(root['archive']) / relative.as_posix()).as_posix()
    return None


def _inventory(roots: dict) -> tuple[list[dict], dict[str, Path]]:
    entries, sources, total = [], {}, 0
    visited = set()
    roots = _included(roots)                      # an excluded (broad) root is never walked
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


def _valid_root(name: str, root, roots: dict) -> bool:
    if not isinstance(root, dict) or not isinstance(root.get('source'), str) or not Path(root['source']).is_absolute():
        return False
    if root.get('archive') is None:                # only a broad Files page root can be left out
        return name == 'files' and root.get('excluded') == 'broad_root'
    alias = roots.get(root['archive']) if isinstance(root['archive'], str) else None
    return (isinstance(alias, dict) and alias.get('archive') == root['archive']
            and Path(root['source']) != Path(Path(root['source']).anchor))


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
            'includes': ['settings_and_credentials', 'sessions', 'attachments', 'workspace',
                         *(['files'] if manifest['roots']['files'].get('archive') else []), 'space_labels'],
            'excludes': ['application_and_provider_binaries', 'temporary_runtime_files', 'external_symlink_targets'],
            'excluded_roots': {name: {'source': root['source'], 'reason': root['excluded']}
                               for name, root in manifest['roots'].items() if not root.get('archive')}}


def export(password: str | None, *, sealed: tuple | None = None, keep: int | None = None) -> dict:
    """`sealed` + `keep`: a scheduled export (see export_scheduled), marked `scheduled`; the older scheduled exports
    beyond the newest `keep` are deleted before the lock is released."""
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
            _crypt(archive, destination, password, sealed=sealed)
        result = {'id': ident, 'sha256': _digest(destination), 'archive_bytes': destination.stat().st_size,
                  'scheduled': keep is not None, **_description(manifest)}
        config.write_json(exports / f'{ident}.json', result)
        if keep is not None:
            for stale in [entry for entry in list_exports() if entry['scheduled']][keep:]:
                delete_export(stale['id'])
        return result


def exported(ident: str) -> Path:
    """An encrypted export of this instance, by id only: the request never names a path (no traversal) and a link
    planted in the exports folder is neither served nor followed."""
    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        raise SnapshotError('not_found', 'Backup not found.', 404)
    folder = _base() / 'exports'
    path = folder / f'{ident}.pilotbackup'
    if path.is_symlink() or not path.is_file() or path.resolve().parent != folder.resolve():
        raise SnapshotError('not_found', 'Backup not found.', 404)
    return path


def list_exports() -> list[dict]:
    """The encrypted exports kept on this server, newest first."""
    folder, result = _base() / 'exports', []
    for path in folder.glob('*.pilotbackup'):
        if not _ID.fullmatch(path.stem) or path.is_symlink() or not path.is_file():
            continue
        meta = config.read_json(folder / f'{path.stem}.json', {})
        meta = meta if isinstance(meta, dict) else {}
        info = path.stat()
        created = meta.get('created')
        result.append({'id': path.stem, 'archive_bytes': info.st_size,
                       'created': created if isinstance(created, (int, float)) else info.st_mtime,
                       'scheduled': meta.get('scheduled') is True,
                       'copy': meta.get('copy') if isinstance(meta.get('copy'), dict) else None,
                       **{k: meta.get(k) for k in ('sha256', 'version', 'files', 'bytes')}})
    return sorted(result, key=lambda entry: entry['created'], reverse=True)


def delete_export(ident: str) -> dict:
    path = exported(ident)
    path.unlink()
    path.with_suffix('.json').unlink(missing_ok=True)
    return {'ok': True, 'id': ident}


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
            if (not isinstance(roots, dict) or set(roots) != {'state', 'workspace', 'files'}
                    or any(not _valid_root(name, r, roots) for name, r in roots.items())
                    or roots['state']['archive'] != 'state' or roots['workspace']['archive'] is None
                    or not isinstance(entries, list) or len(entries) > MAX_ENTRIES):
                raise SnapshotError('manifest', 'The snapshot roots are invalid.')
            aliases = {r['archive'] for r in roots.values() if r['archive']}
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
                if name.split('/', 1)[0] not in aliases:
                    raise SnapshotError('manifest', 'An entry is outside the archived roots.')
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
            for alias in {r['archive'] for r in manifest['roots'].values() if r['archive']}:
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
    # Paths into a root that was not archived (a broad Files page root) stay as they were: historical references.
    replacements = [(r['source'], str(destination / r['archive'])) for r in _included(roots).values()]
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
                               files_root=str(destination / (roots['files']['archive'] or roots['workspace']['archive'])),
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


def purge_expired() -> float:
    """Remove expired previews (and interrupted export staging) unless an operation holds the lock; returns the seconds
    until the next preview expires, at most PURGE_EVERY. Run at startup, then by the server's purge pass, and when
    Settings -> Backup is opened. Never creates the backup folder."""
    imports = config.STATE / 'instance-backups' / 'imports'
    if not imports.parent.is_dir():
        return PURGE_EVERY
    with contextlib.suppress(SnapshotError):
        with _lock():
            _purge_previews()
    now, delay = time.time(), PURGE_EVERY
    for directory in imports.glob('*') if imports.is_dir() else ():
        with contextlib.suppress(OSError):
            delay = min(delay, PREVIEW_TTL - (now - directory.stat().st_mtime))
    return max(1.0, delay)


def status() -> dict:
    purge_expired()                                    # opening Settings -> Backup also clears expired plaintext
    try:
        roots, error = _roots(), None
    except SnapshotError as problem:
        roots, error = {}, str(problem)
    return {'max_bytes': _limit(), 'restore_hold': bool(config.load_config().get('restore_hold')),
            'integrations_paused': config.integrations_paused(),
            'roots': roots, 'export_error': error, 'requires_idle_sessions': True, 'schedule': schedule_status(),
            'copy': copy_status()}


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


# ---- scheduled archives ------------------------------------------------------------------------------------------
# The passphrase is never stored. Enabling a schedule derives the archive key once, exactly as an export would (scrypt,
# default cost, a fresh salt), and keeps that key in secrets.json - not in the Keys vault, whose entries can be exposed
# to agents. Scheduled archives write that salt in their header, so the passphrase alone opens them as usual.
FREQUENCIES = {'daily': 1, 'weekly': 7}          # days between scheduled archives
KEEP = (1, 30)
SCHEDULE_KEY = 'instance_backup_schedule_key'    # secrets.json
SCHEDULE_GROUP = 'instance-backup-schedule'      # feed group of the failure notice
SCHEDULE_POLL = 10 * 60                          # the scheduler looks again at least this often
SCHEDULE_RETRY = 30 * 60                         # a run blocked by activity is retried this soon...
SCHEDULE_NOTIFY_AFTER = 6 * 3600                 # ...and notified once blocked this long
_BLOCKED = {'sessions_active', 'crons_active', 'busy', 'snapshot_busy', 'source_changed'}


def _schedule_file() -> Path:
    return config.STATE / 'instance-backups' / 'schedule.json'     # read without creating the folder


def _schedule() -> tuple[dict, tuple[bytes, tuple[int, int, int], bytes]] | None:
    """(settings, sealed key) of an enabled schedule, else None."""
    settings, stored = config.load_config().get('instance_backup_schedule'), config.load_secrets().get(SCHEDULE_KEY)
    if not isinstance(settings, dict) or settings.get('frequency') not in FREQUENCIES or not isinstance(stored, dict):
        return None
    try:
        sealed = (bytes.fromhex(stored['salt']), tuple(int(v) for v in stored['kdf']), bytes.fromhex(stored['key']))
        hour, keep, since = int(settings['hour']), int(settings['keep']), float(settings['since'])
    except (KeyError, TypeError, ValueError):
        return None
    if len(sealed[0]) != 16 or len(sealed[1]) != 3 or len(sealed[2]) != 32 or not 0 <= hour <= 23:
        return None
    return {'frequency': settings['frequency'], 'hour': hour, 'keep': max(KEEP[0], min(keep, KEEP[1])),
            'since': since}, sealed


def _slot(hour: int, after: float) -> float:
    """The first `hour`:00 (config timezone) after `after`."""
    from . import crons
    return next(crons.iter_runs(f'0 {hour} * * *', after=after))


def _next_run(settings: dict, state: dict) -> float:
    last = state.get('last_success')
    earliest = (last + FREQUENCIES[settings['frequency']] * 86400 - 12 * 3600) if last else settings['since']
    return max(_slot(settings['hour'], earliest), state.get('retry_at') or 0)


def _paused() -> bool:
    return bool(config.load_config().get('restore_hold')) or config.integrations_paused()


def schedule_status() -> dict:
    current = _schedule()
    settings = config.load_config().get('instance_backup_schedule')
    settings = settings if isinstance(settings, dict) else {}
    state = config.read_json(_schedule_file(), {})
    state = state if isinstance(state, dict) else {}
    return {'enabled': current is not None,
            'frequency': current[0]['frequency'] if current else 'off',
            'hour': current[0]['hour'] if current else settings.get('hour', 3),
            'keep': current[0]['keep'] if current else settings.get('keep', 7),
            'next_run': _next_run(current[0], state) if current and not _paused() else None,
            'paused': _paused(), 'last_success': state.get('last_success'), 'last_id': state.get('last_id'),
            'error': state.get('error') if current else None}


def set_schedule(frequency: str, hour: int, keep: int, passphrase: str | None = None, store_key: bool = False) -> dict:
    """Enable or change the schedule. A passphrase (first time, or to change it) needs `store_key`: the owner agreed
    that a key derived from it stays on this server."""
    if frequency not in FREQUENCIES or not isinstance(hour, int) or not 0 <= hour <= 23 \
            or not isinstance(keep, int) or not KEEP[0] <= keep <= KEEP[1]:
        raise SnapshotError('schedule', 'Choose daily or weekly, an hour from 0 to 23 and 1 to 30 archives to keep.')
    current = _schedule()
    if passphrase:
        if not store_key:
            raise SnapshotError('consent_required', 'Agree to keep a key derived from the passphrase on this server.')
        salt = os.urandom(16)
        key = _key(passphrase, salt, *SCRYPT_DEFAULT)
        config.set_secret(SCHEDULE_KEY, {'salt': salt.hex(), 'kdf': list(SCRYPT_DEFAULT), 'key': key.hex()})
    elif current is None:
        raise SnapshotError('passphrase_required', 'Enter the backup passphrase to enable scheduled archives.')
    config.update_config(instance_backup_schedule={'frequency': frequency, 'hour': hour, 'keep': keep,
                                                   'since': current[0]['since'] if current else time.time()})
    return schedule_status()


def disable_schedule() -> dict:
    """Off: the stored key goes; archives already made stay until deleted."""
    config.set_secret(SCHEDULE_KEY, None)
    config.update_config(instance_backup_schedule={'frequency': 'off'})
    return schedule_status()


def schedule_delay() -> float | None:
    """Seconds until the next scheduled archive (<= 0: due); None when there is no schedule or it is paused."""
    current = _schedule()
    if current is None or _paused():
        return None
    state = config.read_json(_schedule_file(), {})
    return _next_run(current[0], state if isinstance(state, dict) else {}) - time.time()


def export_scheduled() -> dict:
    current = _schedule()
    if current is None:
        raise SnapshotError('schedule_off', 'Scheduled archives are not enabled.', 409)
    return export(None, sealed=current[1], keep=current[0]['keep'])


def record_scheduled(result: dict | None = None, code: str = '', message: str = '') -> dict:
    """The outcome of a scheduled run: its state, the next try and the failure notice (once per series of failures;
    a run blocked by activity is retried soon and notified only once blocked for SCHEDULE_NOTIFY_AFTER)."""
    from . import feed
    now, current = time.time(), _schedule()
    state = config.read_json(_schedule_file(), {})
    state = state if isinstance(state, dict) else {}
    if result is not None:
        state = {'last_success': now, 'last_id': result.get('id')}
        feed.system_resolve('system', SCHEDULE_GROUP)
    else:
        blocked = code in _BLOCKED
        state.update(error={'code': code, 'message': message, 'at': now}, failing_since=state.get('failing_since') or now,
                     retry_at=now + SCHEDULE_RETRY if blocked or current is None else _slot(current[0]['hour'], now + 12 * 3600))
        if not state.get('notified') and (not blocked or now - state['failing_since'] >= SCHEDULE_NOTIFY_AFTER):
            state['notified'] = True
            feed.system('The scheduled instance archive failed', message, 'error', group=SCHEDULE_GROUP,
                        kind='instance_backup.failed', params={'code': code, 'message': message[:300]},
                        actions=[feed.link('open', 'Open', '/settings/backup')])
    _base()
    config.write_json(_schedule_file(), state)
    return state


# ---- copy folder ---------------------------------------------------------------------------------------------------
# Each archive, already encrypted, is also copied to a folder the owner chose (an external drive, a folder a sync client
# uploads). No cloud service is called. The folder is never created: an unplugged drive fails instead of filling the
# disk its mount point lives on.
COPY_GROUP = 'instance-backup-copy'


def _copy_folder() -> Path | None:
    settings = config.load_config().get('instance_backup_copy')
    folder = settings.get('folder') if isinstance(settings, dict) else None
    return Path(folder) if isinstance(folder, str) and folder else None


def set_copy_folder(folder: str) -> dict:
    if not isinstance(folder, str) or not folder.strip() or '\0' in folder or len(folder) > 4096:
        raise SnapshotError('copy_folder', 'Choose a folder for the copies.')
    path = Path(folder.strip()).expanduser()
    if not path.is_absolute():
        raise SnapshotError('copy_folder', 'Use the full path of the folder (it starts with /).')
    if not path.is_dir():
        raise SnapshotError('copy_folder', 'This folder does not exist. Connect the drive or create the folder first.')
    real = path.resolve()
    sources = [config.STATE.resolve()]
    try:
        sources += [Path(root['source']) for root in _included(_roots()).values()]
    except SnapshotError:
        pass
    if any(real == source or source in real.parents for source in sources):
        raise SnapshotError('copy_folder', 'Choose a folder outside the data the archive contains, ideally on another '
                            'drive or in a synced folder.')
    try:
        with tempfile.NamedTemporaryFile(dir=real, prefix='.pilot-check-'):
            pass
    except OSError:
        raise SnapshotError('copy_folder', 'The application cannot write in this folder.') from None
    config.update_config(instance_backup_copy={'folder': str(path)})
    return copy_status()


def disable_copy() -> dict:
    config.update_config(instance_backup_copy={'folder': ''})
    return copy_status()


def copy_status() -> dict:
    folder = _copy_folder()
    last = next((entry['copy'] for entry in list_exports() if entry.get('copy')), None) \
        if (config.STATE / 'instance-backups' / 'exports').is_dir() else None
    return {'folder': str(folder) if folder else None, 'last': last}


def copy_export(ident: str) -> dict:
    """Copy one encrypted export to the copy folder and check the copy (size and SHA-256 read back) before it gets its
    final name. Returns the record kept in the export's metadata; a failure is a record with `ok: false`."""
    from . import feed
    folder = _copy_folder()
    if folder is None:
        raise SnapshotError('copy_off', 'No copy folder is set.', 409)
    source = exported(ident)
    meta_file = source.with_suffix('.json')
    meta = config.read_json(meta_file, {})
    meta = meta if isinstance(meta, dict) else {}
    created = meta.get('created') if isinstance(meta.get('created'), (int, float)) else source.stat().st_mtime
    name = f"pilot-{time.strftime('%Y%m%d-%H%M%S', time.localtime(created))}-{ident[:12]}.pilotbackup"
    partial = folder / f'.{name}.partial'
    try:
        size = source.stat().st_size
        expected = meta.get('sha256') if isinstance(meta.get('sha256'), str) else _digest(source)
        if not folder.is_dir():
            raise SnapshotError('copy_folder_missing', f'The copy folder {folder} is not available (is the drive connected?).')
        if shutil.disk_usage(folder).free < size:
            raise SnapshotError('copy_no_space', f'Not enough free space in {folder} for this archive.')
        with source.open('rb') as incoming, partial.open('xb') as outgoing:
            os.chmod(partial, 0o600)
            shutil.copyfileobj(incoming, outgoing, CHUNK)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        if partial.stat().st_size != size or _digest(partial) != expected:
            raise SnapshotError('copy_mismatch', 'The copy does not match the archive (size or SHA-256).')
        target = folder / name
        os.replace(partial, target)
        record = {'ok': True, 'at': time.time(), 'path': str(target), 'bytes': size, 'sha256': expected}
    except (SnapshotError, OSError) as error:
        with contextlib.suppress(OSError):
            partial.unlink(missing_ok=True)
        code = error.code if isinstance(error, SnapshotError) else 'copy_io'
        message = str(error) if isinstance(error, SnapshotError) else f'Could not write the copy in {folder}.'
        record = {'ok': False, 'at': time.time(), 'code': code, 'error': message}
    if source.exists():                              # not deleted meanwhile: keep the record with the archive
        config.write_json(meta_file, {**meta, 'copy': record})
    if record['ok']:
        feed.system_resolve('system', COPY_GROUP)
    else:
        feed.system('An instance archive could not be copied', record['error'], 'error', group=COPY_GROUP,
                    kind='instance_backup.copy_failed',
                    params={'code': record['code'], 'message': record['error'][:300], 'folder': str(folder)[:300]},
                    actions=[feed.link('open', 'Open', '/settings/backup')])
    return record
