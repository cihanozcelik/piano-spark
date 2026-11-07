"""Browser development transport for the production Objective-C LessonService."""
import json
from pathlib import Path
import queue
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT/'build/browser'
ENGINE = BUILD/'Engine'
HOST = BUILD/'lesson-host'
SOURCES = [ROOT/'desktop'/name for name in ('LessonHost.m','LessonService.m','LessonService.h')]


def prepare():
    BUILD.mkdir(parents=True,exist_ok=True)
    if not HOST.exists() or any(path.stat().st_mtime_ns>HOST.stat().st_mtime_ns for path in SOURCES):
        pending = HOST.with_suffix('.pending')
        subprocess.run(['xcrun','clang','-arch','arm64','-fobjc-arc','-fblocks','-Wall','-Wextra','-Werror',
                        '-mmacosx-version-min=14.0',str(SOURCES[0]),str(SOURCES[1]),
                        '-framework','Foundation','-o',str(pending)],check=True)
        pending.replace(HOST)
    links = {
        'python': ROOT/'build/lesson-python/cpython-3.12.12-macos-aarch64-none',
        'site-packages': ROOT/'transcription/separation/.venv/lib/python3.12/site-packages',
        'worker.py': ROOT/'lesson-engine/worker.py',
        'notation.py': ROOT/'lesson-engine/notation.py',
        'score_writer.py': ROOT/'lesson-engine/score_writer.py',
        'score_import.py': ROOT/'lesson-engine/score_import.py',
        'pdf_recognizer.py': ROOT/'lesson-engine/pdf_recognizer.py',
        'omr-site-packages': ROOT/'build/omr/.venv/lib/python3.12/site-packages',
        'notation_source.py': ROOT/'lesson-engine/notation_source.py',
        'models/separation': ROOT/'transcription/separation/models',
        'models/rubato.ckpt': ROOT/'transcription/rubato/models/rubato.ckpt',
    }
    for name,target in links.items():
        path = ENGINE/name
        path.parent.mkdir(parents=True,exist_ok=True)
        if not path.is_symlink(): path.symlink_to(target,target_is_directory=target.is_dir())
        if not target.exists(): raise RuntimeError(f'Ders motoru eksik: {target}')


class LessonBridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.process = None
        self.closed = False
        self.phase = 'idle'
        self.replies = queue.Queue()
        self.support = Path.home()/'Library/Application Support/PianoManDevelopment'

    def _read(self,process,replies):
        try:
            for line in process.stdout:
                replies.put(json.loads(line))
        finally:
            replies.put({'error':'Ders servisi kapandı.'})

    def _stop(self):
        if self.process:
            try:
                self.process.stdin.close()  # EOF asks the owner to cancel and clean up.
            except BrokenPipeError:
                pass
            self.process.wait()
            self.process.stdout.close()
            self.process = None

    def call(self,request):
        with self.lock:
            if self.closed: raise RuntimeError('Servis kapanıyor')
            stale = self.process and any(path.stat().st_mtime_ns>HOST.stat().st_mtime_ns for path in SOURCES)
            if stale and self.phase in ('idle','complete','cancelled','error'): self._stop()
            if self.process is None or self.process.poll() is not None:
                self._stop(); prepare()
                self.replies = queue.Queue()
                self.process = subprocess.Popen([str(HOST),str(ENGINE),str(self.support)],
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
                threading.Thread(target=self._read,args=(self.process,self.replies),daemon=True).start()
            try:
                self.process.stdin.write(json.dumps(request)+'\n'); self.process.stdin.flush()
            except (OSError,ValueError) as error:
                raise RuntimeError('Ders servisine ulaşılamadı.') from error
            reply = self.replies.get()
            if 'error' in reply: raise RuntimeError(reply['error'])
            result = reply['result']
            if request['command']=='lesson-begin': self.phase = 'upload'
            elif request['command']=='lesson-start': self.phase = 'starting'
            elif request['command']=='lesson-cancel': self.phase = 'cancelling'
            elif request['command']=='lesson-state': self.phase = result['phase']
            return result

    def close(self):
        with self.lock:
            self.closed = True
            self._stop()
