"""Audio-only inference with Kong/ByteDance's released note-and-pedal model."""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import threading
import time

HERE = Path(__file__).resolve().parent
os.environ.setdefault('NUMBA_CACHE_DIR', str(HERE / '.cache/numba'))
os.environ.setdefault('MPLCONFIGDIR', str(HERE / '.cache/matplotlib'))


def sha256(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', type=Path, default=HERE.parent/'transkun-v2/source.wav')
    parser.add_argument('--output', type=Path, default=HERE/'peace')
    args = parser.parse_args()
    import librosa
    import torch
    from piano_transcription_inference import PianoTranscription, sample_rate

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint = HERE/'models/note-pedal.pth'
    audio, fs = librosa.load(args.audio, sr=sample_rate, mono=True)
    print(f'Input: {len(audio)/fs:.3f} s, {fs} Hz, mono', flush=True)
    model = PianoTranscription(checkpoint_path=str(checkpoint), device='cpu')
    done = threading.Event()
    started = time.monotonic()
    def progress():
        while not done.wait(30):
            print(f'Transcribing: {time.monotonic()-started:.0f} s elapsed', flush=True)
    thread = threading.Thread(target=progress, daemon=True)
    thread.start()
    try:
        with torch.inference_mode():
            result = model.transcribe(audio, str(args.output/'peace-bytedance-source.mid'))
    finally:
        done.set()
        thread.join()
    notes = [dict(note=int(e['midi_note']), start=float(e['onset_time']),
                  end=float(e['offset_time']), velocity=int(e['velocity'])) for e in result['est_note_events']]
    pedals = [dict(controller=64, start=float(e['onset_time']), end=float(e['offset_time']), value=127)
              for e in result['est_pedal_events']]
    notes.sort(key=lambda n: (n['start'], n['note']))
    (args.output/'events.json').write_text(json.dumps({'timeline':'original audio seconds',
                                                     'notes':notes,'pedals':pedals},indent=2)+'\n')
    report = dict(model='Kong/ByteDance high-resolution piano transcription, Note_pedal',
                  package_version=metadata.version('piano-transcription-inference'),
                  audio=str(args.audio.resolve()), audio_sha256=sha256(args.audio),
                  checkpoint_sha256=sha256(checkpoint), duration_seconds=len(audio)/fs,
                  elapsed_seconds=time.monotonic()-started, device='cpu', threads=4,
                  notes=len(notes), pedals=len(pedals),
                  visual_data_used_for_inference=False)
    (args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)


if __name__ == '__main__':
    main()
