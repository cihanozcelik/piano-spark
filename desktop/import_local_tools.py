"""Offline migration of the pre-app development tools into the app-owned cache.

Run with Python 3.12 on the development Mac. No network or package installation.
Models/archives must match the catalog hash. Installed wheels must match name,
version and wheel tags, and every recorded package file is hash-checked.
"""
import base64
import csv
import fcntl
import hashlib
import itertools
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path.home()/'Library/Application Support/Rach3/Tools/1'
SITES = [ROOT/'transcription/separation/.venv/lib/python3.12/site-packages',
         ROOT/'build/omr/.venv/lib/python3.12/site-packages',
         ROOT/'transcription/rubato/.venv/lib/python3.12/site-packages']


def digest(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).digest()


def import_wheel(artifact, stage):
    name, version, *_, python, abi, platform = artifact['name'][:-4].split('-')
    tags = {'-'.join(parts) for parts in itertools.product(
        python.split('.'), abi.split('.'), platform.split('.'))}
    for site in SITES:
        metadata = site/f'{name}-{version}.dist-info'
        if not (metadata/'WHEEL').is_file():
            continue
        installed_tags = {line[5:] for line in (metadata/'WHEEL').read_text().splitlines()
                          if line.startswith('Tag: ')}
        if tags != installed_tags:
            continue
        files = []
        with (metadata/'RECORD').open(newline='') as stream:
            for filename, signature, size in csv.reader(stream):
                relative = Path(filename)
                source = (site/relative).resolve()
                if '..' in relative.parts:
                    # Environment entry points are never used by the lesson worker.
                    continue
                if source.suffix == '.pyc':
                    continue
                if not source.is_relative_to(site.resolve()) or not source.is_file():
                    raise RuntimeError(f'Missing or external package file: {source}')
                if signature:
                    algorithm, expected = signature.split('=', 1)
                    actual = base64.urlsafe_b64encode(digest(source, algorithm)).rstrip(b'=').decode()
                    if actual != expected or (size and source.stat().st_size != int(size)):
                        raise RuntimeError(f'Installed package differs from RECORD: {source}')
                elif relative.name not in ('RECORD', 'INSTALLER', 'REQUESTED', 'direct_url.json'):
                    raise RuntimeError(f'Unverified package file: {source}')
                files.append((source, relative))
        for source, relative in files:
            target = stage/'site'/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        # RECORD describes the migrated layout, without environment entry points.
        with (stage/'site'/metadata.name/'RECORD').open('w', newline='') as stream:
            writer = csv.writer(stream)
            for _, relative in files:
                target = stage/'site'/relative
                if relative.name == 'RECORD':
                    writer.writerow([relative.as_posix(), '', ''])
                else:
                    encoded = base64.urlsafe_b64encode(digest(target)).rstrip(b'=').decode()
                    writer.writerow([relative.as_posix(), 'sha256='+encoded, target.stat().st_size])
        return dict(source=str(metadata), verification='installed-wheel-tags-and-RECORD')
    return None


def import_model(artifact, stage):
    candidates = [ROOT/'transcription/rubato/models'/artifact['name'],
                  ROOT/'transcription/separation/models'/artifact['name'],
                  ROOT/'build/omr/downloads'/artifact['name']]
    candidates.extend(site/artifact['target'] for site in SITES)
    for source in candidates:
        if not source.is_file() or source.stat().st_size != artifact['size']:
            continue
        if digest(source).hex() != artifact['sha256']:
            continue
        if artifact['kind'] == 'model-zip':
            with zipfile.ZipFile(source) as archive:
                with archive.open(artifact['member']) as src, (stage/'model').open('wb') as dst:
                    shutil.copyfileobj(src, dst)
        else:
            shutil.copy2(source, stage/'model')
        return dict(source=str(source), verification='catalog-sha256')
    return None


def main():
    catalog = json.loads((ROOT/'lesson-engine/tools.json').read_text())
    CACHE.mkdir(parents=True, exist_ok=True)
    with (CACHE/'install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for key, artifact in catalog['artifacts'].items():
            destination = CACHE/'artifacts'/artifact['sha256']
            marker = destination/'.ready'
            if marker.is_file() and marker.read_text() == artifact['sha256']:
                continue
            stage = destination.with_name(destination.name+'.installing')
            if stage.exists():
                shutil.rmtree(stage)
            stage.mkdir(parents=True)
            record = (import_wheel if artifact['kind'] == 'wheel' else import_model)(artifact, stage)
            if record is None:
                shutil.rmtree(stage)
                print('Not available locally:', key, flush=True)
                continue
            (stage/'local-import.json').write_text(json.dumps(record, indent=2)+'\n')
            (stage/'.ready').write_text(artifact['sha256'])
            if destination.exists():
                shutil.rmtree(destination)
            stage.rename(destination)
            print('Reused:', key, flush=True)


if __name__ == '__main__':
    main()
