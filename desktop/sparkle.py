"""Pinned Sparkle binary dependency; no framework or private key in Git."""
import hashlib
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPARKLE = ROOT/'build/sparkle'
VERSION = '2.10.1'
SHA256 = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27'


def download_release_asset(repository, tag, name, directory):
    """Fetch a public release asset into `directory`, preferring the REST API.

    github.com/<repo>/releases/download can fail for hours (HTTP 504) while the
    API asset endpoint used by `gh release download` keeps working. The direct
    URL remains the fallback for machines without an authenticated gh.
    Callers verify every asset against a pinned checksum."""
    target = Path(directory)/name
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repository, '--pattern', name,
                        '--dir', str(target.parent), '--clobber'], check=True)
        if target.is_file():
            return target
    except (OSError, subprocess.CalledProcessError) as error:
        print(f'gh release download failed for {name}; using the direct URL: {error}')
    url = f'https://github.com/{repository}/releases/download/{tag}/' + urllib.parse.quote(name)
    urllib.request.urlretrieve(url, target)
    return target


def prepare():
    SPARKLE.mkdir(parents=True, exist_ok=True)
    marker = SPARKLE/'verified-version'
    if marker.exists() and marker.read_text() == VERSION:
        return SPARKLE
    archive = SPARKLE/f'Sparkle-{VERSION}.tar.xz'
    try:
        if not archive.exists():
            download_release_asset('sparkle-project/Sparkle', VERSION, archive.name, SPARKLE)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
            raise RuntimeError('Sparkle download checksum does not match the pinned release')
        subprocess.run(['tar', '-xJf', str(archive), '-C', str(SPARKLE)], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(SPARKLE/'Sparkle.framework')], check=True)
        marker.write_text(VERSION)
    finally:
        archive.unlink(missing_ok=True)
    return SPARKLE


if __name__ == '__main__':
    print(prepare())
