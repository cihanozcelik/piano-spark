"""Pinned, cancellable first-use tools. Only a lesson worker writes this cache."""
import hashlib
import http.client
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
import urllib.error
import urllib.request
import zipfile

ENGINE = Path(__file__).resolve().parent
WINDOWS = os.name == 'nt'
# Intel Macs need their own wheels; PyTorch stopped publishing them after 2.2.2.
if WINDOWS: CATALOG_NAME = 'tools-win_amd64.json'
elif platform.machine() == 'x86_64': CATALOG_NAME = 'tools-x86_64.json'
else: CATALOG_NAME = 'tools.json'
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


def short(digest):
    # Windows paths stay under MAX_PATH (260): torch alone has 126-character
    # file names below its package folder. 24 hex digits are still unique.
    return digest[:24] if WINDOWS else digest


def artifact_path(cache, artifact):
    return cache/('a' if WINDOWS else 'artifacts')/short(artifact['sha256'])


def link_file(source, target):
    """Link an immutable cached file. Windows symbolic links need developer
    mode, so Windows uses a hard link (the cache and jobs share one volume)."""
    if WINDOWS:
        try: os.link(source, target)
        except OSError: shutil.copy2(source, target)
    else:
        target.symlink_to(source)


def try_lock(stream):
    """Exclusive, non-blocking and released by the OS if the process dies."""
    if WINDOWS:
        import msvcrt
        stream.seek(0)
        try: msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError: return False
        return True
    import fcntl
    try: fcntl.flock(stream, fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: return False
    return True


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
        """Resumes after brief server or network failures; the partial file is kept.
        Equivalent mirrors are tried when the main address fails; the SHA-256 decides."""
        sources = [artifact['url'], *artifact.get('mirrors', [])]
        for attempt in range(4):
            transient = False
            for url in sources:
                try:
                    return self.fetch(artifact, url)
                except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError) as error:
                    code = getattr(error, 'code', None)
                    transient = transient or code is None or code == 429 or code >= 500
                    failure = error
            if attempt == 3 or not transient: raise failure
            time.sleep((2, 6, 15)[attempt])

    def fetch(self, artifact, url):
        partial = self.cache/'downloads'/(artifact['sha256']+'.part')
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > artifact['size']:
            partial.unlink(); offset = 0
        self.progress('tools-download',offset,artifact,True)
        if offset < artifact['size']:
            headers = {'User-Agent':'Rach3/0.4', 'Accept-Encoding':'identity'}
            if offset: headers['Range'] = f'bytes={offset}-'
            if url.startswith('https://api.github.com/'): headers['Accept'] = 'application/octet-stream'
            request = urllib.request.Request(url,headers=headers)
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
                if offset < artifact['size']:
                    # The connection ended early; keep the partial file and resume it.
                    raise ConnectionError('Download ended before the whole file arrived')
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
    with (cache/'install.lock').open('a+') as lock:
        if not try_lock(lock):
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
        profile = cache/'profiles'/short(hashlib.sha256((CATALOG_BYTES+','.join(groups).encode())).hexdigest())
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
                    link_file(artifact_path(cache,artifact)/'model',target)
            if 'separation' in groups:
                shutil.copytree(ENGINE/'model-config',stage/'models/separation',dirs_exist_ok=True)
            (stage/'.ready').write_text('1')
            if profile.exists(): shutil.rmtree(profile)
            stage.rename(profile)
        def paths(selected_groups):
            keys=dict.fromkeys(key for group in selected_groups for key in CATALOG['groups'][group])
            return [str(artifact_path(cache,CATALOG['artifacts'][key])/'site') for key in keys
                    if CATALOG['artifacts'][key]['kind']=='wheel']
        # Vendored sources last: on Windows audio-separator's own diffq-fixed
        # wheel provides the diffq package instead of the macOS build.
        for path in [*paths([g for g in groups if g!='pdf']),str(ENGINE/'vendor')]:
            site.addsitedir(path)
        if 'pdf' in groups:
            os.environ['PIANO_OMR_PATH'] = os.pathsep.join([str(profile),*paths(['pdf'])])
        emit('starting','Ders motoru başlatılıyor…',0)
        return profile/'models'
