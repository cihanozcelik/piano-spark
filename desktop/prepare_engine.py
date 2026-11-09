"""Prepare the small portable runtimes, one per architecture. Lesson tools are
downloaded at first use."""
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


ARCHITECTURES = ('aarch64', 'x86_64')


def local_mirror(environment, request):
    """Download uv's pinned CPython archive through the GitHub API into a
    file:// mirror. uv still verifies the archive against its own checksum.
    Returns None, keeping uv's normal download, when this is not possible."""
    listing = subprocess.run(['uv','python','list',request,'--show-urls','--only-downloads'],
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
    if platform.system() != 'Darwin':
        raise RuntimeError('Use a macOS build machine')
    environment = os.environ.copy()
    environment['UV_NO_CACHE'] = '1'
    target = Path(environment.get('RACH3_PYTHON_DIR') or ROOT/'build/lesson-python')
    for arch in ARCHITECTURES:
        request = f'cpython-{PYTHON}-macos-{arch}-none'
        install = dict(environment)
        if not (target/request).exists():
            mirror = local_mirror(install, request)
            if mirror: install['UV_PYTHON_INSTALL_MIRROR'] = mirror.as_uri()
        subprocess.run(['uv','python','install',request,'--no-bin','--install-dir',str(target)],check=True,env=install)
    print('Portable runtimes ready; no lesson packages or models downloaded.')


if __name__ == '__main__': main()
