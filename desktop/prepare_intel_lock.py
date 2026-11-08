"""Create the Intel (x86_64) environments that desktop/lock_tools.py reads.

Catalog maintenance only: the app build and user Macs never run this. The Intel
environments start from the Apple Silicon lock files and change only what has no
Intel macOS wheel, plus the packages that must follow numpy back to 1.x.
Requires uv, Rosetta 2 on Apple Silicon, and `python3 desktop/prepare_engine.py`.
"""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT/'build/lesson-python/cpython-3.12.12-macos-x86_64-none/bin/python3.12'
LOCK = ROOT/'build/lock-x86_64'

# PyTorch 2.2.2 is the last release with Intel macOS wheels and needs numpy 1.x.
INTEL = {
    'torch': '2.2.2', 'torchvision': '0.17.2', 'numpy': '1.26.4',
    'numba': '0.62.1', 'llvmlite': '0.45.1', 'onnxruntime': '1.23.2',
    # Last releases that still support numpy 1.x.
    'scipy': '1.17.1', 'contourpy': '1.3.3', 'librosa': '0.11.0', 'ml-dtypes': '0.5.4',
}
# Their declared floors (numpy>=2 and torch>=2.3; onnxruntime>=1.24.1) have no
# Intel wheels. The Intel lesson checks show these exact versions work, so they
# are installed without resolving their own requirements.
AUDIO_UNRESOLVED = {'audio-separator'}
PDF_UNRESOLVED = {'homr'}
# The PDF recognizer runs in its own process and keeps numpy 2.
PDF_INTEL = {'onnxruntime': '1.23.2'}


def requirements(source, replacements, skip=()):
    lines = []
    for line in source.read_text().splitlines():
        name = line.split('==')[0].split(' @ ')[0].strip()
        if not line.strip() or name in skip: continue
        lines.append(f'{name}=={replacements[name]}' if name in replacements else line)
    return '\n'.join(lines)+'\n'


def environment(name, text, unresolved=()):
    folder = LOCK/name
    if folder.exists(): shutil.rmtree(folder)
    folder.mkdir(parents=True)
    (folder/'requirements.txt').write_text(text)
    venv = folder/'.venv'
    env = dict(os.environ, MACOSX_DEPLOYMENT_TARGET='14.0', UV_NO_CACHE='1')
    subprocess.run(['uv','venv','--python',str(PYTHON),str(venv)],check=True,env=env)
    python = str(venv/'bin/python')
    # diffq has no CPython 3.12 wheel; it is built here by the Intel interpreter.
    # Rubato is a pinned Git revision of pure Python. Everything else is a wheel.
    install = ['uv','pip','install','--python',python,'--only-binary',':all:',
               '--no-binary','diffq','--no-binary','rubato-transcription']
    subprocess.run([*install,'-r',str(folder/'requirements.txt')],check=True,env=env)
    if unresolved:
        subprocess.run([*install,'--no-deps',*unresolved],check=True,env=env)
    subprocess.run(['uv','pip','check','--python',python],env=env)


def main():
    if not PYTHON.exists():
        raise RuntimeError('Run python3 desktop/prepare_engine.py first')
    for name, lock, replacements, unresolved in [
            ('audio', ROOT/'transcription/separation/requirements.lock.txt', INTEL, AUDIO_UNRESOLVED),
            ('pdf', ROOT/'lesson-engine/omr-requirements.lock.txt', PDF_INTEL, PDF_UNRESOLVED)]:
        pinned = {line.split('==')[0]: line for line in lock.read_text().splitlines() if '==' in line}
        environment(name, requirements(lock, replacements, skip=unresolved),
                    [pinned[package] for package in sorted(unresolved)])
    print(f'Intel lock environments ready in {LOCK}')


if __name__ == '__main__': main()
