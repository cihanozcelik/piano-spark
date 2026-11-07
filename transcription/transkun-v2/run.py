"""Transcribe the source performance with the packaged Transkun V2 checkpoint."""
import argparse
from collections import Counter
import hashlib
from importlib import metadata
import json
import os
import subprocess
from pathlib import Path
import threading
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
os.environ.setdefault('MPLCONFIGDIR', str(HERE / '.cache/matplotlib'))
os.environ.setdefault('NUMBA_CACHE_DIR', str(HERE / '.cache/numba'))


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--output', type=Path, default=HERE)
    parser.add_argument('--name', default='peace')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    record = json.loads((ROOT / 'transcription-record.json').read_text())
    source = (args.source or Path(record['source']['path'])).resolve()
    compare_visual = source == Path(record['source']['path']).resolve()
    audio_path = output / 'source.wav'
    if args.source or not audio_path.exists():
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
                        '-i', str(source), '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le',
                        '-ar', '44100', str(audio_path)], check=True)
    import numpy as np
    import torch
    import moduleconf
    import transkun
    from scipy.io import wavfile
    from transkun.Data import writeMidi

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    package = Path(transkun.__file__).parent
    weight = package / 'pretrained/2.0.pt'
    config = package / 'pretrained/2.0.conf'
    conf = moduleconf.parseFromFile(str(config))['Model']
    print('Loading Transkun V2 on CPU; threads:', args.threads, flush=True)
    model = conf.module.TransKun(conf=conf.config)
    checkpoint = torch.load(weight, map_location='cpu', weights_only=False)
    model.load_state_dict(checkpoint.get('best_state_dict', checkpoint.get('state_dict')), strict=True)
    model.eval()
    sample_rate, pcm = wavfile.read(audio_path)
    if sample_rate != model.fs:
        raise ValueError(f'Extract audio at {model.fs} Hz before running')
    audio = torch.from_numpy(pcm.astype(np.float32) / 32768)
    started = time.monotonic()
    done = threading.Event()

    def progress():
        while not done.wait(30):
            print(f'Transcribing: {time.monotonic() - started:.0f} s elapsed', flush=True)

    heartbeat = threading.Thread(target=progress, daemon=True)
    heartbeat.start()
    print(f'Transcribing full {len(pcm) / sample_rate:.2f} s recording', flush=True)
    try:
        with torch.inference_mode():
            events = model.transcribe(audio, discardSecondHalf=False)
    finally:
        done.set()
        heartbeat.join()
    elapsed = time.monotonic() - started
    writeMidi(events).write(str(output / f'{args.name}-transkun-v2-source.mid'))
    notes = [dict(note=int(e.pitch), start=float(e.start), end=float(e.end), velocity=int(e.velocity))
             for e in events if e.pitch > 0]
    pedals = [dict(controller=int(-e.pitch), start=float(e.start), end=float(e.end), value=int(e.velocity))
              for e in events if e.pitch < 0]
    notes.sort(key=lambda n: (n['start'], n['note']))
    pedals.sort(key=lambda e: (e['start'], e['controller']))
    record = json.loads((ROOT / 'transcription-record.json').read_text())
    offset = record['result']['firstSourceNoteSeconds'] if compare_visual else 0.0
    # Keep the raw result intact and create a separate version using the player's time origin.
    import copy
    aligned = []
    for event in events:
        if event.end <= offset:
            continue
        item = copy.copy(event)
        item.start = max(0.0, item.start - offset)
        item.end -= offset
        aligned.append(item)
    writeMidi(aligned).write(str(output / f'{args.name}-transkun-v2.mid'))
    (output / 'events.json').write_text(json.dumps({
        'timeline': 'original video seconds', 'player_offset_seconds': offset,
        'notes': notes, 'pedals': pedals,
    }, ensure_ascii=False, indent=2) + '\n')
    video = json.loads((ROOT / 'transcription.json').read_text())
    reference = [note for track in video['tracks'] for note in track['notes']] if compare_visual else []
    # One-to-one nearest onset matching by pitch; a comparison to the visual extraction,
    # not a ground-truth accuracy score.
    candidates = sorted((abs(n['start'] - (r['time'] + offset)), i, j)
                        for i, r in enumerate(reference) for j, n in enumerate(notes)
                        if r['midi'] == n['note'] and abs(n['start'] - (r['time'] + offset)) <= .15)
    used_reference, used_audio, matches = set(), set(), []
    for difference, i, j in candidates:
        if i not in used_reference and j not in used_audio:
            used_reference.add(i)
            used_audio.add(j)
            matches.append(dict(reference_index=i, audio_index=j, onset_difference_seconds=difference))
    (output / 'visual-matches.json').write_text(json.dumps(matches, indent=2) + '\n') if compare_visual else None
    velocities = [n['velocity'] for n in notes]
    report = {
        'source': {'path': str(source), 'sha256': digest(source)}, 'audio_sha256': digest(audio_path),
        'model': 'Transkun V2 No Pedal Extension (packaged default)',
        'package_version': metadata.version('transkun'), 'torch_version': torch.__version__,
        'checkpoint_sha256': digest(weight), 'config': json.loads(config.read_text()),
        'device': 'cpu', 'threads': args.threads, 'elapsed_seconds': elapsed,
        'source_duration_seconds': len(pcm) / sample_rate,
        'notes': len(notes), 'velocity_min': min(velocities) if velocities else None,
        'velocity_max': max(velocities) if velocities else None,
        'velocity_median': float(np.median(velocities)) if velocities else None,
        'distinct_velocities': len(set(velocities)),
        'pedal_intervals_by_controller': dict(Counter(e['controller'] for e in pedals)),
        'visual_reference_available': compare_visual, 'visual_reference_notes': len(reference), 'matched_within_150_ms': len(matches),
        'unmatched_visual': len(reference)-len(matches), 'unmatched_audio': len(notes)-len(matches),
        'median_matched_onset_difference_seconds': float(np.median([m['onset_difference_seconds'] for m in matches])) if matches else None,
        'limits': ['Model estimates, not the original performance MIDI.',
                   'Pedals are switch intervals, not continuous half-pedal depth.',
                   'Visual extraction is not ground truth; agreement is a comparison only.',
                   'No changes to the player, Bluetooth connection, or existing transcription.'],
    }
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in ('config', 'source')}, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
