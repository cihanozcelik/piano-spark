"""Prepare only the small portable runtime. Lesson tools are downloaded at first use."""
import os
from pathlib import Path
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('Use an Apple Silicon macOS build machine')
    environment = os.environ.copy()
    environment['UV_NO_CACHE'] = '1'
    subprocess.run(['uv','python','install','3.12.12','--no-bin','--install-dir',
                    str(ROOT/'build/lesson-python')],check=True,env=environment)
    print('Portable runtime ready; no lesson packages or models downloaded.')


if __name__ == '__main__': main()
