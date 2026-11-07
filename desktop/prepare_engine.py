"""Prepare pinned first-release engine inputs on an Apple Silicon build machine.

This does not run inference or install anything system-wide. Subsequent releases
reuse the exact signed published engine through release.py --bootstrap-engine.
"""
import argparse
import base64
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = ROOT/'build/lesson-python'
RUNTIME = RUNTIME_ROOT/'cpython-3.12.12-macos-aarch64-none'
SEPARATION = ROOT/'transcription/separation'
PYTHON = SEPARATION/'.venv/bin/python'
MODELS = SEPARATION/'models'
RUBATO = ROOT/'transcription/rubato/models/rubato.ckpt'
WEIGHTS = {
    RUBATO: '131649ff95b80713bd327b63d37b2771e1175b3c1c9aa4242a783c67bf27b1fc',
    MODELS/'vocals_mel_band_roformer.ckpt': '87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e',
}
# Exact public metadata used by the existing working engine, stored compressed
# to avoid querying mutable main on first build. Source:
# https://raw.githubusercontent.com/TRvlvr/application_data/main/filelists/download_checks.json
CHECKS_SHA256 = 'd3622e1fa19c161d3cf704927711b453d593a3f1eb0f2e0838c3136907935151'
CHECKS_SNAPSHOT = (
    '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'
 )
# The configuration shipped with audio-separator 0.48.0's model-configs release.
# https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/vocals_mel_band_roformer.yaml
CONFIG_SHA256 = 'b958b29c8f7195f0d86bee6759a33980db675c4ecaf2fcaa80fa125828e6cd38'
CONFIG = 'audio:\r\n  chunk_size: 352800\r\n  dim_f: 1024\r\n  dim_t: 256\r\n  hop_length: 441\r\n  n_fft: 2048\r\n  num_channels: 2\r\n  sample_rate: 44100\r\n  min_mean_abs: 0.001\r\n\r\nmodel:\r\n  dim: 384\r\n  depth: 6\r\n  stereo: true\r\n  num_stems: 1\r\n  time_transformer_depth: 1\r\n  freq_transformer_depth: 1\r\n  num_bands: 60\r\n  dim_head: 64\r\n  heads: 8\r\n  attn_dropout: 0\r\n  ff_dropout: 0\r\n  flash_attn: True\r\n  dim_freqs_in: 1025\r\n  sample_rate: 44100  # needed for mel filter bank from librosa\r\n  stft_n_fft: 2048\r\n  stft_hop_length: 441\r\n  stft_win_length: 2048\r\n  stft_normalized: False\r\n  mask_estimator_depth: 2\r\n  multi_stft_resolution_loss_weight: 1.0\r\n  multi_stft_resolutions_window_sizes: !!python/tuple\r\n  - 4096\r\n  - 2048\r\n  - 1024\r\n  - 512\r\n  - 256\r\n  multi_stft_hop_size: 147\r\n  multi_stft_normalized: False\r\n\r\ntraining:\r\n  instruments:\r\n  - vocals\r\n  - other\r\n  target_instrument: vocals\r\n\r\ninference:\r\n  dim_t: 1101\r\n  num_overlap: 1\r\n  chunk_size: 352800'


def run(*args):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True)


def verify(path, expected):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError(f'Pinned engine checksum mismatch: {path.relative_to(ROOT)}')
    print(f'Verified {path.relative_to(ROOT)}', flush=True)


def clean_inputs():
    # Only CI staging is disposable; never delete a developer's environments.
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('--clean-inputs is restricted to disposable GitHub Actions runners')
    for path in [RUNTIME_ROOT, SEPARATION/'.venv', MODELS, RUBATO.parent, ROOT/'build/omr', ROOT/'build/engine-tools']:
        if path.exists():
            shutil.rmtree(path)


def prepare():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('The bundled engine requires an Apple Silicon macOS runner')
    # uv temporary caches go away after each command instead of duplicating GBs.
    os.environ['UV_NO_CACHE'] = '1'
    os.environ['PIP_NO_CACHE_DIR'] = '1'
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    run('uv', 'python', 'install', '3.12.12', '--no-bin', '--install-dir', RUNTIME_ROOT)
    run('uv', 'venv', '--python', RUNTIME/'bin/python3.12', SEPARATION/'.venv')
    run('uv', 'pip', 'sync', '--python', PYTHON, SEPARATION/'requirements.lock.txt')
    # Separator checks PATH even when only downloading. Reuse the pinned bundled
    # FFmpeg instead of introducing a system/Homebrew dependency on the runner.
    tools = ROOT/'build/engine-tools'
    tools.mkdir(parents=True, exist_ok=True)
    ffmpeg = subprocess.check_output([str(PYTHON), '-c',
        'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], text=True).strip()
    (tools/'ffmpeg').unlink(missing_ok=True)
    (tools/'ffmpeg').symlink_to(ffmpeg)
    os.environ['PATH'] = str(tools) + os.pathsep + os.environ['PATH']
    MODELS.mkdir(parents=True, exist_ok=True)
    checks = MODELS/'download_checks.json'
    checks.write_bytes(zlib.decompress(base64.b64decode(CHECKS_SNAPSHOT)))
    verify(checks, CHECKS_SHA256)
    config = MODELS/'vocals_mel_band_roformer.yaml'
    config.write_text(CONFIG)
    verify(config, CONFIG_SHA256)
    # Download via the pinned library's official mirrored model registry; do not
    # instantiate the model or run separation. The verified YAML already exists.
    run(PYTHON, '-c', 'from audio_separator.separator import Separator; '
        'import sys; Separator(model_file_dir=sys.argv[1]).download_model_files("vocals_mel_band_roformer.ckpt")', MODELS)
    verify(MODELS/'vocals_mel_band_roformer.ckpt', WEIGHTS[MODELS/'vocals_mel_band_roformer.ckpt'])
    verify(config, CONFIG_SHA256)
    RUBATO.parent.mkdir(parents=True, exist_ok=True)
    if not RUBATO.exists():
        partial = RUBATO.with_suffix('.partial')
        try:
            urllib.request.urlretrieve('https://github.com/nctamer/rubato-transcription/releases/download/v1/rubato.ckpt', partial)
            verify(partial, WEIGHTS[RUBATO])
            partial.replace(RUBATO)
        finally:
            partial.unlink(missing_ok=True)
    verify(RUBATO, WEIGHTS[RUBATO])
    run('python3', ROOT/'tools/prepare_omr.py')
    # OMR's own preparation pins ONNX archive hashes. The runtime only needs the
    # extracted files, not the download ZIPs or bytecode generated by preparation.
    shutil.rmtree(ROOT/'build/omr/downloads', ignore_errors=True)
    for tree in [SEPARATION/'.venv', ROOT/'build/omr/.venv', RUNTIME_ROOT]:
        for cache in tree.rglob('__pycache__'):
            shutil.rmtree(cache)
    print('Pinned engine inputs ready for desktop/build.py --app-only.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--clean-inputs', action='store_true', help='CI only: free staging inputs after the signed app has been built')
    args = parser.parse_args()
    if args.clean_inputs:
        clean_inputs()
    else:
        prepare()
