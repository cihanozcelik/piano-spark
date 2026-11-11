"""Verify a built universal rach3 on an Intel Mac (or under Rosetta 2).

Release CI runs this on GitHub's Intel runner before anything is published:
the app must be universal and correctly signed, signed updates and deltas must
verify and apply, and the Intel lesson engine must create real lessons from
MIDI, PDF and audio (with vocal separation) using the Intel tool catalog,
downloaded exactly as a user's Mac downloads it.
"""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import struct
import subprocess
import sys
import tempfile
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'desktop'))


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def architectures(path):
    return set(run('xcrun', 'lipo', '-archs', path, capture_output=True, text=True).stdout.split())


def check_bundle(app):
    run('codesign', '--verify', '--deep', '--strict', app)
    engine = app/'Contents/Resources/Engine'
    for binary in [app/'Contents/MacOS/Rach3',
                   app/'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
                   app/'Contents/Frameworks/rach3 Helper (Renderer).app/Contents/MacOS/rach3 Helper (Renderer)',
                   app/'Contents/Resources/updates.node',
                   app/'Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle',
                   app/'Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate',
                   engine/'vendor/diffq/bitpack.cpython-312-darwin.so']:
        if not {'arm64', 'x86_64'} <= architectures(binary):
            raise RuntimeError(f'Not universal: {binary}')
    if architectures(engine/'python-x86_64/bin/python3.12') != {'x86_64'}:
        raise RuntimeError('The Intel runtime is not x86_64')
    for name in ('tools.json', 'tools-x86_64.json', 'torch_compat.py'):
        if not (engine/name).is_file(): raise RuntimeError(f'Missing engine file: {name}')
    print('Universal bundle, signatures and engine layout verified', flush=True)


def check_updates(dist, baseline=ROOT/'build/update-baseline/rach3.app'):
    from release import verify_archive, SPARKLE, prepare
    metadata = json.loads((dist/'update-signature.json').read_text())
    archive = dist/f'rach3-{metadata["version"]}.zip'
    verify_archive(archive, metadata['signature'])
    with tempfile.TemporaryDirectory(prefix='piano-intel-update-') as directory:
        folder = Path(directory)
        run('ditto', '-x', '-k', archive, folder)
        updated = folder/'rach3.app'
        run('codesign', '--verify', '--deep', '--strict', updated)
        for patch in metadata.get('deltas', []):
            path = dist/patch['file']
            verify_archive(path, patch['signature'])
            if not baseline.exists():
                raise RuntimeError('Fetch the update baseline before verifying deltas')
            prepare()
            patched = folder/'patched'/patch['file']/'rach3.app'
            patched.parent.mkdir(parents=True)
            run(SPARKLE/'bin/BinaryDelta', 'apply', baseline, patched, path)
            run('codesign', '--verify', '--deep', '--strict', patched)
            run('diff', '-rq', patched, updated)
            print(f'Delta {patch["file"]} applies on {platform.machine()}', flush=True)
    print(f'Signed update {archive.name} verified on {platform.machine()}', flush=True)


def piano_audio(path, seconds=12):
    """A small synthetic piano-like recording: decaying harmonic tones and chords."""
    rate = 44100
    events = []
    for i, note in enumerate([60, 62, 64, 65, 67, 69, 71, 72]):
        events.append((0.5 + i*0.5, note, 0.45))
    for i, chord in enumerate([(48, 55, 64), (53, 57, 65), (55, 59, 67), (48, 52, 60)]):
        for note in chord: events.append((5.0 + i*1.5, note, 1.3))
    samples = [0.0]*(rate*seconds)
    for start, note, length in events:
        frequency = 440*2**((note-69)/12)
        first = int(start*rate)
        for n in range(int(length*1.6*rate)):
            if first+n >= len(samples): break
            t = n/rate
            tone = sum(math.sin(2*math.pi*frequency*k*t)/k**1.6 for k in range(1, 6))
            samples[first+n] += 0.16*tone*math.exp(-3.2*t/length)*min(1, t*400)
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(2); output.setsampwidth(2); output.setframerate(rate)
        frames = bytearray()
        for value in samples:
            value = max(-32767, min(32767, int(value*32767)))
            frames += struct.pack('<hh', value, value)
        output.writeframes(bytes(frames))


def lesson(app, tools, library, name, source, kind, separate=False):
    """Run the lesson worker exactly as desktop/LessonService.m starts it."""
    engine = app/'Contents/Resources/Engine'
    with tempfile.TemporaryDirectory(prefix='piano-intel-job-') as directory:
        job = Path(directory)
        suffix = {'midi': 'mid', 'pdf': 'pdf'}.get(kind, 'wav')
        (job/f'input.{suffix}').write_bytes(source.read_bytes())
        (job/'request.json').write_text(json.dumps(dict(id=name, title=name, input=f'input.{suffix}', kind=kind,
                                                        sourceName=source.name, tempo=60, url='', separate=separate)))
        (job/'tmp').mkdir()
        runtime = engine/'python-x86_64'
        environment = dict(HOME=os.environ['HOME'], PATH='/usr/bin:/bin', PYTHONHOME=str(runtime),
                           PYTHONPATH=str(engine), PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1',
                           TMPDIR=str(job/'tmp'))
        started = time.monotonic()
        result = subprocess.run(['arch', '-x86_64', str(runtime/'bin/python3.12'), '-u', str(engine/'worker.py'),
                                 '--job', str(job), '--tools', str(tools), '--library', str(library)],
                                env=environment, cwd=job, capture_output=True, text=True)
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    final = events[-1] if events else {}
    if result.returncode or final.get('phase') != 'complete' or not final.get('noteCount'):
        print(result.stderr[-6000:], file=sys.stderr)
        raise RuntimeError(f'{name} lesson failed on Intel: {final.get("message")}')
    print(f'{name}: {final["noteCount"]} notes in {time.monotonic()-started:.0f}s', flush=True)
    return json.loads((library/f'{name}.json').read_text())


def check_engine(app, tools=None):
    with tempfile.TemporaryDirectory(prefix='piano-intel-engine-') as directory:
        folder = Path(directory)
        tools, library = tools or folder/'tools', folder/'library'
        lesson(app, tools, library, 'intel-midi', ROOT/'assets/example-lessons/bach-prelude/score.mid', 'midi')
        lesson(app, tools, library, 'intel-pdf', ROOT/'assets/example-lessons/bach-prelude/score.pdf', 'pdf')
        audio = folder/'piano.wav'
        piano_audio(audio)
        separated = lesson(app, tools, library, 'intel-audio', audio, 'video', separate=True)
        if not separated['provenance']['separation']:
            raise RuntimeError('Vocal separation did not run')
        pitches = {note['midi'] for track in separated['tracks'] for note in track['notes']}
        if not pitches & {60, 64, 67, 72}:
            raise RuntimeError(f'Audio lesson missed the test recording: {sorted(pitches)}')
    print('Intel lesson engine verified: MIDI, PDF and audio with vocal separation', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=ROOT/'dist/rach3.app')
    parser.add_argument('--dist', type=Path, default=ROOT/'dist', help='Folder with the signed update and its metadata')
    parser.add_argument('--baseline', type=Path, default=ROOT/'build/update-baseline/rach3.app',
                        help='Signed previous app that the update deltas start from')
    parser.add_argument('--skip-updates', action='store_true')
    parser.add_argument('--skip-engine', action='store_true')
    parser.add_argument('--tools', type=Path, help='Reuse a tool cache (default: a fresh download, as on a new Mac)')
    args = parser.parse_args()
    check_bundle(args.app.resolve())
    if not args.skip_updates: check_updates(args.dist.resolve(), args.baseline.resolve())
    if not args.skip_engine: check_engine(args.app.resolve(), args.tools)


if __name__ == '__main__':
    main()
