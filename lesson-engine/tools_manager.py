"""Pinned, cancellable first-use tools. Only a lesson worker writes this cache."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import site
import ssl
import subprocess
import sys
import time
import urllib.request
import zipfile

ENGINE = Path(__file__).resolve().parent
# Intel Macs need their own wheels; PyTorch stopped publishing them after 2.2.2.
CATALOG_NAME = 'tools-x86_64.json' if platform.machine() == 'x86_64' else 'tools.json'
CATALOG_BYTES = (ENGINE/CATALOG_NAME).read_bytes()
CATALOG = json.loads(CATALOG_BYTES)


def groups_for(request):
    groups = ['notation']
    if request.get('kind') == 'pdf':
        groups.append('pdf')
    elif request.get('kind') != 'midi':
        groups.append('transcription')
        if request.get('url'): groups.append('youtube')
        if request.get('separate', True): groups.append('separation')
    return groups


def artifact_path(cache, artifact):
    return cache/'artifacts'/artifact['sha256']


def ready(cache, artifact):
    marker = artifact_path(cache, artifact)/'.ready'
    return marker.is_file() and marker.read_text() == artifact['sha256']


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class Installer:
    def __init__(self, cache, ids, emit):
        self.cache, self.emit = cache, emit
        self.pending = [CATALOG['artifacts'][key] for key in ids
                        if not ready(cache, CATALOG['artifacts'][key])]
        self.total = sum(a['size'] for a in self.pending)
        self.done = 0
        self.last_tick = 0
        self.started = time.monotonic()
        self.transferred = 0
        self.ssl = ssl.create_default_context(cafile=str(ENGINE/'cacert.pem'))
        (cache/'downloads').mkdir(parents=True, exist_ok=True)

    def progress(self, phase, current, artifact, force=False):
        now = time.monotonic()
        if not force and now-self.last_tick < .15: return
        self.last_tick = now
        count = self.done + current
        message = {'tools-download':'Ders araçları indiriliyor…',
                   'tools-verify':'İndirme doğrulanıyor…',
                   'tools-install':'Ders araçları hazırlanıyor…'}[phase]
        self.emit(phase, message, count/self.total if self.total else 1,
                  toolDownload=dict(received=count,total=self.total,
                                    speed=self.transferred/max(.1,now-self.started),
                                    file=artifact['name'],stage=phase))

    def download(self, artifact):
        partial = self.cache/'downloads'/(artifact['sha256']+'.part')
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > artifact['size']:
            partial.unlink(); offset = 0
        self.progress('tools-download',offset,artifact,True)
        if offset < artifact['size']:
            headers = {'User-Agent':'PianoSpark/0.4', 'Accept-Encoding':'identity'}
            if offset: headers['Range'] = f'bytes={offset}-'
            request = urllib.request.Request(artifact['url'],headers=headers)
            with urllib.request.urlopen(request,context=self.ssl,timeout=30) as response:
                if response.status == 206:
                    expected = f'bytes {offset}-{artifact["size"]-1}/{artifact["size"]}'
                    if response.headers.get('Content-Range') != expected:
                        raise RuntimeError('İndirme sunucusu beklenmeyen bir dosya aralığı döndürdü. Yeniden dene.')
                elif response.status == 200:
                    offset = 0
                else:
                    raise RuntimeError(f'Download HTTP {response.status}')
                with partial.open('ab' if offset else 'wb') as output:
                    while chunk := response.read(256*1024):
                        output.write(chunk); offset += len(chunk); self.transferred += len(chunk)
                        if offset > artifact['size']:
                            raise RuntimeError('İndirilen dosyanın boyutu beklenenden farklı. Yeniden dene.')
                        self.progress('tools-download',offset,artifact)
        self.progress('tools-verify',offset,artifact,True)
        if offset != artifact['size'] or sha256(partial) != artifact['sha256']:
            partial.unlink(missing_ok=True)
            raise RuntimeError('İndirilen dosya doğrulanamadı. Yeniden dene.')
        return partial

    def install(self, artifact):
        payload = self.download(artifact)
        self.progress('tools-install',artifact['size'],artifact,True)
        destination = artifact_path(self.cache, artifact)
        stage = destination.with_name(destination.name+'.installing')
        if stage.exists(): shutil.rmtree(stage)
        stage.mkdir(parents=True)
        if artifact['kind'] == 'wheel':
            # pip handles wheel .data layouts and executable permissions. Never
            # resolve dependencies or contact a package index on a recipient Mac.
            wheel = stage/artifact['name']
            os.link(payload,wheel)
            subprocess.run([sys.executable,'-m','pip','--isolated','install',
                            '--no-index','--no-deps','--no-compile','--disable-pip-version-check',
                            '--no-warn-script-location','--target',str(stage/'site'),str(wheel)],
                           check=True,stdout=sys.stderr,stderr=sys.stderr)
            wheel.unlink()
        elif artifact['kind'] == 'model-zip':
            with zipfile.ZipFile(payload) as archive:
                with archive.open(artifact['member']) as src, (stage/'model').open('wb') as dst:
                    shutil.copyfileobj(src,dst)
        else:
            os.link(payload,stage/'model')
        (stage/'.ready').write_text(artifact['sha256'])
        if destination.exists(): shutil.rmtree(destination)
        stage.rename(destination)
        payload.unlink()
        self.done += artifact['size']


def prepare(request, cache, emit):
    cache.mkdir(parents=True,exist_ok=True)
    # A killed worker releases this lock automatically. A second process cannot
    # overwrite a partial download or a package being installed by the first.
    with (cache/'install.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Ders araçları başka bir pencerede hazırlanıyor. İşlem bitince yeniden dene.')
        groups = groups_for(request)
        ids = list(dict.fromkeys(key for group in groups for key in CATALOG['groups'][group]))
        installer = Installer(cache,ids,emit)
        try:
            for artifact in installer.pending: installer.install(artifact)
        except (OSError,subprocess.CalledProcessError) as error:
            print(f'Tool installation: {error}',file=sys.stderr)
            raise RuntimeError('Araçlar hazırlanamadı. İnternet bağlantısını ve boş disk alanını kontrol edip yeniden dene. İndirilen dosyalar saklandı.') from error

        # Profiles contain only small package copies and links into immutable,
        # verified artifacts. PDFs use their own Pillow version in a subprocess.
        profile = cache/'profiles'/hashlib.sha256((CATALOG_BYTES+','.join(groups).encode())).hexdigest()
        if not (profile/'.ready').exists():
            stage = profile.with_name(profile.name+'.installing')
            if stage.exists(): shutil.rmtree(stage)
            stage.mkdir(parents=True)
            for key in ids:
                artifact = CATALOG['artifacts'][key]
                if artifact['kind'] == 'wheel' and key.startswith(('homr-','rapidocr-')):
                    name = key.split('-')[0]
                    shutil.copytree(artifact_path(cache,artifact)/'site'/name,stage/name)
            for key in ids:
                artifact = CATALOG['artifacts'][key]
                if artifact['kind'].startswith('model'):
                    target = stage/artifact['target']; target.parent.mkdir(parents=True,exist_ok=True)
                    target.unlink(missing_ok=True)
                    target.symlink_to(artifact_path(cache,artifact)/'model')
            if 'separation' in groups:
                shutil.copytree(ENGINE/'model-config',stage/'models/separation',dirs_exist_ok=True)
            (stage/'.ready').write_text('1')
            if profile.exists(): shutil.rmtree(profile)
            stage.rename(profile)
        def paths(selected_groups):
            keys=dict.fromkeys(key for group in selected_groups for key in CATALOG['groups'][group])
            return [str(artifact_path(cache,CATALOG['artifacts'][key])/'site') for key in keys
                    if CATALOG['artifacts'][key]['kind']=='wheel']
        for path in [str(ENGINE/'vendor'),*paths([g for g in groups if g!='pdf'])]:
            site.addsitedir(path)
        if 'pdf' in groups:
            os.environ['PIANO_OMR_PATH'] = os.pathsep.join([str(profile),*paths(['pdf'])])
        emit('starting','Ders motoru başlatılıyor…',0)
        return profile/'models'
