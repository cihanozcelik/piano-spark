"""Decode full 40-second windows; each window owns onsets in its first 20 seconds.

Releases come from the same decoded window as their onset. No duration is copied
from visual data, clipped at the ownership boundary, or invented for open notes.
"""
import argparse
from importlib import metadata
import json
from pathlib import Path
import time

from run import HERE, sha256


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', type=Path, default=HERE.parent/'transkun-v2/source.wav')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--mode', choices=('midi', 'score'), default='midi')
    parser.add_argument('--name', default='peace')
    args = parser.parse_args()
    if args.output is None:
        args.output = HERE/('peace-overlap' if args.mode=='midi' else 'peace-score-overlap')
    import torch
    from rubato import Rubato, protocol
    from rubato.audio import load_audio
    from rubato.convert import midi_to_midi, read_performance, read_score, score_to_midi
    from rubato.convert.midi import write_smf, score_notes

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    args.output.mkdir(parents=True, exist_ok=True)
    audio = load_audio(args.audio)
    duration = len(audio)/16000
    starts = list(range(0, len(audio), 20*16000))
    if len(starts)>1 and len(audio)-starts[-1]<10*16000:
        starts.pop()
    inputs = [(str(i), audio[start:start+40*16000]) for i,start in enumerate(starts)]
    # Each input is an independent <=40-second piece, decoded through its end.
    # This changes only the current Python process's inference configuration.
    protocol.W40H20 = dict(chunk_size=40.0, hop_size=40.0,
                          max_generation_timestamp=40.0, merge_start_offset=0.0)
    checkpoint = HERE/'models/rubato.ckpt'
    started = time.monotonic()
    model = Rubato.load(str(checkpoint), device='cpu')
    last_progress = 0.0

    def progress(stats, decoder):
        nonlocal last_progress
        now = time.monotonic()
        if now-last_progress>=30:
            print(f'{now-started:.0f}s: decoded {stats["chunks"]}/{len(starts)} windows; '
                  f'tokens {decoder.tokens}', flush=True)
            last_progress = now

    notes, pedal_events, windows = [], [], []
    with torch.inference_mode():
        for result in model.transcribe(inputs, mode=args.mode, slots=8, enc_batch=2,
                                       progress=progress, recover='off'):
            i = int(result['key'])
            start = starts[i]/16000
            owns_until = starts[i+1]/16000 if i+1<len(starts) else duration
            (args.output/f'window-{i:02d}.{args.mode}.txt').write_text(result['text']+'\n')
            if args.mode=='midi':
                (args.output/f'window-{i:02d}.mid').write_bytes(midi_to_midi(result['text']))
                parsed_notes, parsed_pedals = read_performance(result['text'])
                selected = [dict(note=n.pitch, start=start+n.onset, end=start+n.offset,
                                 velocity=n.velocity, source_window=i)
                            for n in parsed_notes if start+n.onset<owns_until]
            else:
                score = read_score(result['text'])
                (args.output/f'window-{i:02d}.mid').write_bytes(score_to_midi(score))
                selected = [dict(note=pitch, start=start+onset, end=start+offset,
                                 velocity=80, staff=staff, source_window=i)
                            for onset,offset,pitch,staff in score_notes(score)
                            if start+onset<owns_until]
                parsed_pedals = []
                result['parser_repairs'] = score.repairs
            notes.extend(selected)
            pedal_events.extend(dict(controller=64, time=start+t, value=127 if down else 0,
                                     source_window=i)
                                for t,down in parsed_pedals if start+t<owns_until)
            windows.append(dict(index=i, start=start, owns_until=owns_until,
                                selected_notes=len(selected), result=result))
            print(f'Window {i}: {len(selected)} owned notes', flush=True)

    notes.sort(key=lambda n:(n['start'],n['note']))
    pedal_events.sort(key=lambda e:e['time'])
    pedals, pedal_start = [], None
    for event in pedal_events:
        if event['value'] and pedal_start is None:
            pedal_start = event['time']
        elif not event['value'] and pedal_start is not None:
            pedals.append(dict(controller=64, start=pedal_start, end=event['time'], value=127))
            pedal_start = None
    if pedal_start is not None:
        pedals.append(dict(controller=64, start=pedal_start, end=None, value=127))
    midi_events = []
    for n in notes:
        midi_events.append((round(n['start']*1000), 2, bytes([0x90,n['note'],n['velocity']])))
        midi_events.append((round(n['end']*1000), 0, bytes([0x80,n['note'],0])))
    midi_events.extend((round(e['time']*1000),1,bytes([0xB0,64,e['value']])) for e in pedal_events)
    tempo = [(0,0,b'\xff\x51\x03\x0f\x42\x40')]
    (args.output/f'{args.name}-rubato-overlap-source.mid').write_bytes(write_smf([tempo,midi_events]))
    (args.output/'windows.json').write_text(json.dumps(windows,indent=2)+'\n')
    (args.output/'events.json').write_text(json.dumps(dict(timeline='original audio seconds',
        notes=notes,pedals=pedals,pedal_events=pedal_events),indent=2)+'\n')
    report = dict(model='Rubato v1 '+args.mode+', full-window overlap experiment',
                  package_version=metadata.version('rubato-transcription'),
                  audio=str(args.audio.resolve()),audio_sha256=sha256(args.audio),
                  checkpoint_sha256=sha256(checkpoint),duration_seconds=duration,
                  elapsed_seconds=time.monotonic()-started,device='cpu',threads=4,slots=8,
                  chunk_seconds=40,onset_ownership_seconds=20,recover='off',
                  notes=len(notes),pedals=len(pedals),visual_data_used_for_inference=False,
                  limits=['No manual duration changes. Official converters are used.',
                          'Notes whose release lies outside their 40-second window may be missing.',
                          'MIDI mode: pedal events use onset-ownership windows, without synthesized resets.',
                          'Score mode: constant velocity 80, no pedal; parser repairs in windows.json.'],
                  inference_stats=model.last_stats)
    (args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)


if __name__=='__main__':
    main()
