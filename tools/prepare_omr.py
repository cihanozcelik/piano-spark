"""Prepare the project-local, Java-free PDF engine before packaging the app."""
import hashlib
from pathlib import Path
import subprocess
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[1]
BUILD=ROOT/'build/omr'
MODELS={
    'segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f':
        ('segmentation','1d4277354a8397a6830ef1279232e6d989c2d254b7451525e53ff3d3754b1f70'),
    'encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903':
        ('transformer','9d9bc44da68c1180c85173d739edb2d703d90c0dbbdfadc9ebf6636685a5489b'),
    'decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903':
        ('transformer','0a2f023e1ecf41f5f969f2ed4ef80c050ce29a4996c6655056cf36c6104677e8'),
}


def main():
    python=BUILD/'.venv/bin/python'
    if not python.exists():
        subprocess.run(['uv','venv','--python',str(ROOT/'transcription/separation/.venv/bin/python'),
                        str(BUILD/'.venv')],check=True)
    subprocess.run(['uv','pip','sync','--python',str(python),
                    str(ROOT/'lesson-engine/omr-requirements.lock.txt')],check=True)
    site=BUILD/'.venv/lib/python3.12/site-packages/homr'
    downloads=BUILD/'downloads';downloads.mkdir(exist_ok=True)
    for name,(folder,digest) in MODELS.items():
        archive=downloads/(name+'.zip')
        if not archive.exists():
            partial=archive.with_suffix('.partial')
            urllib.request.urlretrieve(
                'https://github.com/liebharc/homr/releases/download/onnx_checkpoints/'+archive.name,
                partial)
            partial.replace(archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest()!=digest:
            raise RuntimeError(f'Model download checksum mismatch: {archive}')
        with zipfile.ZipFile(archive) as bundle:
            (site/folder/(name+'.onnx')).write_bytes(bundle.read(name+'.onnx'))
    # RapidOCR's model resources must be present before the app becomes offline.
    subprocess.run([str(python),'-c',
        'from homr.title_detection import download_ocr_weights; download_ocr_weights()'],check=True)
    print('PDF engine ready in build/omr; no system-wide installation.')


if __name__=='__main__':main()
