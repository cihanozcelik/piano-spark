"""Run released Rubato tasks on audio only, preserving raw predictions."""
import argparse
import hashlib
from importlib import metadata
import json
from pathlib import Path
import time

HERE = Path(__file__).resolve().parent


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', type=Path, default=HERE.parent/'transkun-v2/source.wav')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--mode', choices=('midi', 'score'), default='midi')
    parser.add_argument('--name', default='peace')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--slots', type=int, default=8)
    args = parser.parse_args()
    if args.output is None:
        args.output = HERE/('peace' if args.mode=='midi' else 'peace-score')
    import torch
    from rubato import Rubato
    from rubato.convert import midi_to_midi, read_performance, read_score, score_to_midi
    from rubato.convert.midi import score_notes

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoint = HERE/'models/rubato.ckpt'
    started = time.monotonic()
    print('Loading Rubato v1 on CPU', flush=True)
    model = Rubato.load(str(checkpoint), device='cpu')
    last_progress = 0.0

    def progress(stats, decoder):
        nonlocal last_progress
        now = time.monotonic()
        if now-last_progress >= 30:
            print(f'{now-started:.0f}s: encoded {stats["enc_chunks"]} windows; '
                  f'finished {stats["chunks"]}; tokens {decoder.tokens}', flush=True)
            last_progress = now

    with torch.inference_mode():
        results = list(model.transcribe([str(args.audio.resolve())], mode=args.mode,
                                       slots=args.slots, enc_batch=2,
                                       progress=progress, recover='off'))
    result = results[0]
    (args.output/f'source.{args.mode}.txt').write_text(result['text']+'\n')
    (args.output/'chunks.json').write_text(json.dumps(result, indent=2)+'\n')
    if args.mode=='midi':
        (args.output/f'{args.name}-rubato-source.mid').write_bytes(midi_to_midi(result['text']))
        parsed_notes, pedal_events = read_performance(result['text'])
        notes = [dict(note=n.pitch, start=n.onset, end=n.offset, velocity=n.velocity)
                 for n in parsed_notes]
        parsing = ('Official read_performance and midi_to_midi; no duration correction. '
                   'Official note parser drops notes without a release; raw text and MIDI retained.')
    else:
        score = read_score(result['text'])
        (args.output/f'{args.name}-rubato-source.mid').write_bytes(score_to_midi(score))
        notes = [dict(note=pitch, start=start, end=end, velocity=80, staff=staff)
                 for start,end,pitch,staff in score_notes(score)]
        pedal_events = []
        parsing = ('Official read_score and score_to_midi. Score note durations use predicted '
                   'notation and timestamps; velocity is the converter constant 80, not estimated. '
                   'No pedal prediction. Official parser repairs: '+json.dumps(score.repairs))
    pedals = []
    pedal_start = None
    for timestamp, down in pedal_events:
        if down and pedal_start is None:
            pedal_start = timestamp
        elif not down and pedal_start is not None:
            pedals.append(dict(controller=64, start=pedal_start, end=timestamp, value=127))
            pedal_start = None
    if pedal_start is not None:
        pedals.append(dict(controller=64, start=pedal_start, end=None, value=127))
    events = dict(timeline='original audio seconds', notes=notes, pedals=pedals,
                  pedal_events=[dict(controller=64, time=t, value=127 if down else 0)
                                for t, down in pedal_events])
    (args.output/'events.json').write_text(json.dumps(events, indent=2)+'\n')
    report = dict(model='Rubato v1 '+args.mode, package_version=metadata.version('rubato-transcription'),
                  repository_revision='325d90df334f7fe7e8e2c8c90a297c927e635dcc',
                  audio=str(args.audio.resolve()), audio_sha256=sha256(args.audio),
                  checkpoint_sha256=sha256(checkpoint), duration_seconds=result['duration'],
                  elapsed_seconds=time.monotonic()-started, device='cpu', threads=args.threads,
                  slots=args.slots, recover='off', notes=len(notes), pedals=len(pedals),
                  visual_data_used_for_inference=False,
                  parsing=parsing,
                  inference_stats=model.last_stats)
    (args.output/'report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    main()
