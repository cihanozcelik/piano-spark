"""Combine Rubato score timing with audio-only MIDI dynamics and sustain."""
import json
from pathlib import Path
import re
import sys
from rubato.convert import read_score
from rubato.convert._perf import perf_events

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
events = json.loads((HERE/'peace-score-overlap/events.json').read_text())
performance = perf_events((HERE/'peace/source.midi.txt').read_text())
attacks = [dict(note=pitch, time=tick/1000, velocity=velocity)
           for tick,kind,pitch,velocity in performance if kind=='on' and velocity>0]
candidates = sorted((abs(note['start']-attack['time']), i, j)
                    for i,note in enumerate(events['notes']) for j,attack in enumerate(attacks)
                    if note['note']==attack['note'] and abs(note['start']-attack['time'])<=.15)
matches, used_attacks = {}, set()
for difference, i, j in candidates:
    if i not in matches and j not in used_attacks:
        matches[i] = j
        used_attacks.add(j)
# An incomplete enrichment is a build failure, never silently a constant velocity.
if len(matches)!=len(events['notes']):
    raise RuntimeError(f"Velocity matched {len(matches)}/{len(events['notes'])} notes")
offset = min(note['start'] for note in events['notes'])
pedals = [dict(time=tick/1000-offset, value=1 if kind=='ped_on' else 0)
          for tick,kind,pitch,velocity in performance if kind in ('ped_on','ped_off')]
tracks = []
for hand, staff in enumerate(('PL', 'PR')):
    notes = []
    for index,note in enumerate(events['notes']):
        if note['staff'] != staff:
            continue
        start, end = note['start']-offset, note['end']-offset
        notes.append(dict(midi=note['note'], time=start, end=end, soundEnd=end,
                          velocity=attacks[matches[index]]['velocity']/127, hand=hand))
    tracks.append(dict(id=hand, name='Sol el' if hand==0 else 'Sağ el', notes=notes, pedals=pedals))
lesson = dict(id='peace-rubato-score-overlap', title='A Small Measure of Peace · Rubato',
              description='Sesten otomatik · Deneme · Şiddet ve pedal tahmini · Pedal çoğunlukla basılı tahmin edildi',
              midiFilename='a-small-measure-of-peace-rubato.mid',
              noteCount=len(events['notes']),
              duration=max([note['end']-offset for note in events['notes']]+[e['time'] for e in pedals]), tracks=tracks,
              provenance=dict(model='Rubato v1 score, full-window overlap',
                              events='transcription/rubato/peace-score-overlap/events.json',
                              sourceOffsetSeconds=offset,
                              handAssignment='Model score staff PL/PR',
                              velocity='Rubato MIDI note-on predictions, one-to-one pitch/onset matching within 150 ms',
                              performance='transcription/rubato/peace/source.midi.txt',
                              matchedVelocities=len(matches),
                              pedal='Rubato MIDI CC64 predictions; near-continuous sustain remains unverified',
                              pedalApplied=True, visualDataUsed=False,
                              durationCorrectionApplied=False))
sys.path.insert(0,str(ROOT/'lesson-engine'))
from notation import rhythm_window, build_notation
windows = json.loads((HERE/'peace-score-overlap/windows.json').read_text())
rhythm = [rhythm_window(read_score(item['result']['text']),item['start'],item['owns_until'],raw_text=item['result']['text']) for item in windows]
lesson['notation'] = build_notation(lesson,rhythm,offset)
tag = '<script id="rubato-song-data" type="application/json">'+json.dumps(lesson,ensure_ascii=False,separators=(',', ':')).replace('</','<\\/')+'</script>'
path = ROOT/'piano.html'
html = path.read_text()
pattern = r'<script id="rubato-song-data" type="application/json">.*?</script>'
if re.search(pattern,html,re.S):
    html = re.sub(pattern,lambda _:tag,html,flags=re.S)
else:
    html = html.replace('<script type="module" src="/player.js"></script>',
                        tag+'\n<script type="module" src="/player.js"></script>')
path.write_text(html)
print(f'Embedded {lesson["noteCount"]} model notes; removed {offset:.3f}s leading silence.')
