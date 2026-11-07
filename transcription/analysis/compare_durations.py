"""Compare audio-only outputs to visual observations; never rewrite predictions."""
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[2]
record = json.loads((ROOT/'transcription-record.json').read_text())
offset = record['result']['firstSourceNoteSeconds']
visual = [n for t in json.loads((ROOT/'transcription.json').read_text())['tracks'] for n in t['notes']]
sources = {
    'transkun_stock': ROOT/'transcription/transkun-v2/events.json',
    'transkun_merge_fix': ROOT/'transcription/transkun-v2/merge-offset/events.json',
    'bytedance': ROOT/'transcription/bytedance/peace/events.json',
    'rubato': ROOT/'transcription/rubato/peace/events.json',
    'rubato_overlap': ROOT/'transcription/rubato/peace-overlap/events.json',
    'rubato_score': ROOT/'transcription/rubato/peace-score/events.json',
    'rubato_score_overlap': ROOT/'transcription/rubato/peace-score-overlap/events.json',
}
reports = {}
for label, path in sources.items():
    if not path.exists():
        continue
    data = json.loads(path.read_text())
    audio = data['notes']
    candidates = sorted((abs(n['start']-(v['time']+offset)), i, j)
                        for i,v in enumerate(visual) for j,n in enumerate(audio)
                        if n['note']==v['midi'] and abs(n['start']-(v['time']+offset))<=.15)
    used_v, used_a, matches = set(), set(), []
    for onset_difference, i, j in candidates:
        if i in used_v or j in used_a:
            continue
        used_v.add(i); used_a.add(j)
        v, n = visual[i], audio[j]
        matches.append(dict(note=n['note'], visual_start=v['time']+offset,
                            audio_start=n['start'], visual_duration=v['end']-v['time'],
                            audio_duration=n['end']-n['start'],
                            onset_difference_seconds=onset_difference,
                            duration_difference_seconds=(n['end']-n['start'])-(v['end']-v['time']),
                            release_difference_seconds=n['end']-(v['end']+offset)))
    durations = [abs(m['duration_difference_seconds']) for m in matches]
    report = dict(notes=len(audio), matched_notes=len(matches),
                  missed_visual=len(visual)-len(matches), unmatched_audio=len(audio)-len(matches),
                  median_absolute_duration_difference_seconds=statistics.median(durations),
                  duration_differences_over_250ms=sum(d>.25 for d in durations),
                  duration_differences_within_100ms=sum(d<=.1 for d in durations),
                  median_absolute_release_difference_seconds=statistics.median(abs(m['release_difference_seconds']) for m in matches),
                  pedals=data['pedals'])
    reports[label]=report
    (Path(__file__).parent/f'{label}-comparison.json').write_text(json.dumps({'summary':report,'matches':matches},indent=2)+'\n')
report = {'reference':'First lesson visual extraction, confirmed correct by the user; not original performance MIDI.',
          'reference_accepted_by_user':True,
          'reference_note_count':len(visual), 'onset_match_tolerance_seconds':.15,
          'visual_used_only_for_comparison':True, 'results':reports}
(Path(__file__).parent/'duration-comparison.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
