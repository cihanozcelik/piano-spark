"""Separate a local recording into vocal and accompaniment stems, with provenance."""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import time

HERE = Path(__file__).resolve().parent
os.environ.setdefault('NUMBA_CACHE_DIR', str(HERE/'.cache/numba'))
os.environ.setdefault('MPLCONFIGDIR', str(HERE/'.cache/matplotlib'))


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', type=Path, default=HERE.parent/'transkun-v2/pervane/source.wav')
    parser.add_argument('--output', type=Path, default=HERE/'pervane')
    parser.add_argument('--model', default='vocals_mel_band_roformer.ckpt')
    args = parser.parse_args()
    import torch
    import soundfile as sf
    from audio_separator.separator import Separator

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    if torch.backends.mps.is_available():
        torch.mps.set_per_process_memory_fraction(.20)
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    separator = Separator(model_file_dir=str(HERE/'models'), output_dir=str(args.output),
                          output_format='WAV', use_soundfile=True,
                          normalization_threshold=1.0,
                          mdxc_params={'batch_size':1, 'overlap':4})
    separator.load_model(model_filename=args.model)
    files = separator.separate(str(args.audio.resolve()),
                               {'Vocals':'vocals', 'Instrumental':'instrumental', 'Other':'instrumental'})
    outputs = []
    for name in files:
        path = Path(name)
        if not path.exists():
            path = args.output/name
        info = sf.info(path)
        outputs.append(dict(path=str(path.resolve()),sha256=sha256(path),
                            frames=info.frames,sample_rate=info.samplerate,
                            channels=info.channels,duration_seconds=info.duration))
    report = dict(package='audio-separator', version=metadata.version('audio-separator'),
                  torch_version=torch.__version__,device=str(separator.torch_device),
                  model=args.model,model_sha256=sha256(HERE/'models'/args.model),
                  audio=str(args.audio.resolve()),audio_sha256=sha256(args.audio),
                  cpu_threads=4,mps_memory_fraction=.20,overlap=4,batch_size=1,
                  normalization_ceiling=1.0,elapsed_seconds=time.monotonic()-started,
                  outputs=outputs,visual_data_used=False,
                  limits=['Accompaniment is not guaranteed to contain only piano.',
                          'Model separation may leave vocal residue or remove instrumental detail.'])
    (args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)


if __name__=='__main__':
    main()
