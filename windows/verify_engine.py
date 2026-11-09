"""Verify the Windows lesson engine on a real Windows machine (GitHub's runner).

Stages the engine as the Windows app ships it, then creates real lessons from
MIDI, PDF and audio (with vocal separation) through the worker contract in
windows/engine.py. Tools are downloaded from tools-win_amd64.json exactly as on
a new PC, into a folder whose name has spaces and Turkish letters.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'windows'), str(ROOT/'desktop')]
from engine import CREATION_FLAGS, prepare_runtime, stage_engine, worker_command, worker_environment  # noqa: E402
from verify_intel import piano_audio  # noqa: E402

TITLE = 'Şarkı ğüşıöç'
# The same test recording on an Apple Silicon Mac: (pitch, onset). Rubato runs
# on the CPU everywhere, so the raw-audio lesson must match exactly.
REFERENCE = {(48, 4.5), (55, 4.5), (53, 6.0), (57, 6.0), (55, 7.5), (59, 7.5), (48, 9.0), (52, 9.0),
             (60, 0.0), (62, 0.5), (64, 1.0), (65, 1.5), (67, 2.0), (69, 2.5), (71, 3.0), (72, 3.5),
             (64, 4.5), (65, 6.0), (67, 7.5), (60, 9.0)}


def notes(lesson):
    return {(note['midi'], round(note['time'], 2)) for track in lesson['tracks'] for note in track['notes']}


def lesson(engine, tools, library, name, source, kind, separate=False):
    with tempfile.TemporaryDirectory(prefix='piano-win-job-') as directory:
        job = Path(directory)
        suffix = {'midi': 'mid', 'pdf': 'pdf'}.get(kind, 'wav')
        (job/f'input.{suffix}').write_bytes(source.read_bytes())
        request = dict(id=name, title=f'{TITLE} {name}', input=f'input.{suffix}', kind=kind,
                       sourceName=source.name, tempo=60, url='', separate=separate)
        (job/'request.json').write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
        (job/'tmp').mkdir()
        started = time.monotonic()
        result = subprocess.run(worker_command(engine, job, tools, library, os.getpid()),
                                env=worker_environment(engine, job), cwd=job, capture_output=True,
                                creationflags=CREATION_FLAGS)
        stdout, stderr = result.stdout.decode('utf-8'), result.stderr.decode('utf-8', 'replace')
        if job.exists() and any(job.iterdir()):
            print(f'Note: worker left files in its job folder: {[p.name for p in job.iterdir()]}')
    events = [json.loads(line) for line in stdout.splitlines() if line.startswith('{')]
    final = events[-1] if events else {}
    if result.returncode or final.get('phase') != 'complete' or not final.get('noteCount'):
        print(stderr[-8000:], file=sys.stderr)
        raise RuntimeError(f'{name} lesson failed on Windows: {final.get("message")}')
    if final['title'] != request['title']:
        raise RuntimeError(f'Title changed on the way: {final["title"]!r}')
    print(f'{name}: {final["noteCount"]} notes in {time.monotonic()-started:.0f}s', flush=True)
    return json.loads((library/f'{name}.json').read_text(encoding='utf-8'))


def check_lock(engine, tools):
    """A second worker must refuse while the first holds the tool cache lock."""
    tools.mkdir(parents=True, exist_ok=True)
    first = subprocess.Popen([str(engine/'python/python.exe'), '-c',
                              'import sys,time,tools_manager as t;from pathlib import Path\n'
                              'l=open(Path(sys.argv[1])/"install.lock","a+");assert t.try_lock(l);print("held",flush=True);time.sleep(30)',
                              str(tools)], env=worker_environment(engine, tools), cwd=engine,
                             stdout=subprocess.PIPE, text=True)
    try:
        if first.stdout.readline().strip() != 'held': raise RuntimeError('Lock holder did not start')
        second = subprocess.run([str(engine/'python/python.exe'), '-c',
                                 'import sys,tools_manager as t;from pathlib import Path\n'
                                 'sys.exit(0 if not t.try_lock(open(Path(sys.argv[1])/"install.lock","a+")) else 3)',
                                 str(tools)], env=worker_environment(engine, tools), cwd=engine)
        if second.returncode: raise RuntimeError('A second process took the tool cache lock')
    finally:
        first.kill(); first.wait()
    print('Tool cache lock is exclusive across processes', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, default=Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir()))/'Rach3 Ğüş test')
    parser.add_argument('--tools', type=Path, help='Reuse a tool cache (default: fresh, as on a new PC)')
    args = parser.parse_args()
    if os.name != 'nt': raise RuntimeError('Run this on Windows')
    engine = stage_engine(args.work/'Engine', prepare_runtime())
    tools, library = args.tools or args.work/'Tools', args.work/'Library'
    check_lock(engine, tools)
    lessons = ROOT/'assets/example-lessons/bach-prelude'
    if lesson(engine, tools, library, 'win-midi', lessons/'score.mid', 'midi')['noteCount'] != 549:
        raise RuntimeError('The MIDI lesson differs from the Mac (549 notes)')
    pdf = lesson(engine, tools, library, 'win-pdf', lessons/'score.pdf', 'pdf')['noteCount']
    if not 590 <= pdf <= 625:  # Apple Silicon reads 608 notes, Intel 609.
        raise RuntimeError(f'The PDF lesson is far from the Mac result: {pdf} notes')
    audio = args.work/'piano.wav'
    piano_audio(audio)
    separated = lesson(engine, tools, library, 'win-audio', audio, 'video', separate=True)
    if not separated['provenance']['separation']:
        raise RuntimeError('Vocal separation did not run')
    if len(notes(separated) & REFERENCE) < len(REFERENCE)-2:
        raise RuntimeError(f'Separated audio lesson differs from the Mac: {sorted(notes(separated))}')
    raw = lesson(engine, tools, library, 'win-audio-raw', audio, 'video', separate=False)
    if notes(raw) != REFERENCE:
        raise RuntimeError(f'Raw audio lesson differs from the Mac: {sorted(notes(raw) ^ REFERENCE)}')
    summary = {name: json.loads((library/f'{name}.json').read_text(encoding='utf-8'))['noteCount']
               for name in ('win-midi', 'win-pdf', 'win-audio', 'win-audio-raw')}
    print('Windows lesson engine verified:', json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
