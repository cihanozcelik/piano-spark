"""Pinned Sparkle binary dependency; no framework or private key in Git."""
import hashlib
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPARKLE = ROOT/'build/sparkle'
VERSION = '2.10.1'
SHA256 = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27'


def prepare():
    SPARKLE.mkdir(parents=True, exist_ok=True)
    marker = SPARKLE/'verified-version'
    if marker.exists() and marker.read_text() == VERSION:
        return SPARKLE
    archive = SPARKLE/f'Sparkle-{VERSION}.tar.xz'
    try:
        if not archive.exists():
            urllib.request.urlretrieve(f'https://github.com/sparkle-project/Sparkle/releases/download/{VERSION}/{archive.name}', archive)
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
