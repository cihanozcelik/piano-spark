"""Prepare only the small portable runtime. Lesson tools are downloaded at first use."""
import os
from pathlib import Path
import platform
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'desktop'))
from sparkle import download_release_asset  # noqa: E402


PYTHON = '3.12.12'
MIRROR = ROOT/'build/python-mirror'
STANDALONE = 'https://github.com/astral-sh/python-build-standalone/releases/download/'


def local_mirror(environment):
    """Download uv's pinned CPython archive through the GitHub API into a
    file:// mirror. uv still verifies the archive against its own checksum.
    Returns None, keeping uv's normal download, when this is not possible."""
    listing = subprocess.run(['uv','python','list',PYTHON,'--show-urls','--only-downloads'],
                             env=environment,capture_output=True,text=True)
    urls = [part for line in listing.stdout.splitlines() for part in line.split() if part.startswith(STANDALONE)]
    if listing.returncode or len(urls) != 1:
        print('No single pinned CPython download found; using uv directly.')
        return None
    tag, name = urllib.parse.unquote(urls[0][len(STANDALONE):]).split('/',1)
    try:
        download_release_asset('astral-sh/python-build-standalone',tag,name,MIRROR/tag)
    except Exception as error:
        print(f'CPython mirror download failed; using uv directly: {error}')
        return None
    return MIRROR


def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('Use an Apple Silicon macOS build machine')
    environment = os.environ.copy()
    environment['UV_NO_CACHE'] = '1'
    target = Path(environment.get('PIANOMAN_PYTHON_DIR') or ROOT/'build/lesson-python')
    if not any(target.glob(f'cpython-{PYTHON}-*')):
        mirror = local_mirror(environment)
        if mirror: environment['UV_PYTHON_INSTALL_MIRROR'] = mirror.as_uri()
    subprocess.run(['uv','python','install',PYTHON,'--no-bin','--install-dir',str(target)],check=True,env=environment)
    print('Portable runtime ready; no lesson packages or models downloaded.')


if __name__ == '__main__': main()
