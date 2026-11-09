"""Create the Windows package folders that desktop/lock_tools.py reads.

Catalog maintenance only, run on the Mac: uv installs the Windows x64 wheels of
the same pinned versions into plain folders, for their metadata. Nothing in them
runs here. Rubato comes from lesson-engine/vendor (pure Python). On Windows
audio-separator depends on the diffq-fixed wheel instead of the vendored diffq.
Then: transcription/separation/.venv/bin/python desktop/lock_tools.py win_amd64
"""
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT/'build/lock-win'
VENDORED = ('diffq', 'rubato-transcription')


def main():
    for name, lock in [('audio', ROOT/'transcription/separation/requirements.lock.txt'),
                       ('pdf', ROOT/'lesson-engine/omr-requirements.lock.txt')]:
        folder = LOCK/name
        if folder.exists(): shutil.rmtree(folder)
        folder.mkdir(parents=True)
        lines = [line for line in lock.read_text().splitlines()
                 if line.strip() and not line.startswith(VENDORED)]
        (folder/'requirements.txt').write_text('\n'.join(lines)+'\n')
        subprocess.run(['uv', 'pip', 'install', '--target', str(folder/'site'),
                        '--python-platform', 'x86_64-pc-windows-msvc', '--python-version', '3.12',
                        '--only-binary', ':all:', '-r', str(folder/'requirements.txt')],
                       check=True, env=dict(os.environ, UV_NO_CACHE='1'))
    print(f'Windows lock folders ready in {LOCK}')


if __name__ == '__main__': main()
