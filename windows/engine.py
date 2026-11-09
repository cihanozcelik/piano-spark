"""The Windows lesson engine: its layout and how the app starts a lesson worker.

The Windows app shell starts the worker exactly as `worker_command` and
`worker_environment` describe, so the CI checks run the real contract.
"""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PYTHON = '3.12.12'
RUNTIME_REQUEST = f'cpython-{PYTHON}-windows-x86_64-none'
RUNTIME = ROOT/'build/lesson-python'/RUNTIME_REQUEST
ENGINE_FILES = ['worker.py', 'notation.py', 'notation_source.py', 'score_writer.py', 'score_import.py',
                'pdf_recognizer.py', 'tools_manager.py', 'torch_compat.py', 'tools-win_amd64.json',
                'cacert.pem']
# The Windows tool set brings diffq as the diffq-fixed wheel; the vendored copy
# is a macOS build.
IGNORE = shutil.ignore_patterns('__pycache__', '*.pyc', 'tests', '.DS_Store', 'diffq', 'diffq-*')
# BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW: lessons never slow down playback.
CREATION_FLAGS = 0x00004000 | 0x08000000


def prepare_runtime():
    """Install the pinned portable CPython. uv verifies the archive checksum."""
    if (RUNTIME/'python.exe').exists(): return RUNTIME
    subprocess.run(['uv', 'python', 'install', RUNTIME_REQUEST, '--no-bin',
                    '--install-dir', str(RUNTIME.parent)], check=True,
                   env=dict(os.environ, UV_NO_CACHE='1'))
    return RUNTIME


def stage_engine(engine, runtime=RUNTIME):
    if engine.exists(): shutil.rmtree(engine)
    engine.mkdir(parents=True)
    shutil.copytree(runtime, engine/'python', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    source = ROOT/'lesson-engine'
    for name in ENGINE_FILES:
        shutil.copy2(source/name, engine/name)
    for name in ['vendor', 'model-config']:
        shutil.copytree(source/name, engine/name, ignore=IGNORE)
    return engine


def worker_command(engine, job, tools, library, parent):
    return [str(engine/'python/python.exe'), '-u', str(engine/'worker.py'), '--job', str(job),
            '--tools', str(tools), '--library', str(library), '--parent', str(parent)]


def worker_environment(engine, job, base=None):
    environment = dict(os.environ if base is None else base)
    system = environment.get('SystemRoot', r'C:\Windows')
    environment.update(PYTHONHOME=str(engine/'python'), PYTHONPATH=str(engine),
                       PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1',
                       # JSON events and lesson files are UTF-8, not the ANSI code page.
                       PYTHONUTF8='1', PYTHONIOENCODING='utf-8',
                       PATH=os.pathsep.join([str(Path(system)/'System32'), system]),
                       TEMP=str(job/'tmp'), TMP=str(job/'tmp'))
    return environment
