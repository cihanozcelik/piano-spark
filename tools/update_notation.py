"""Rebuild notation for existing lessons using saved Rubato rhythm windows."""
import argparse
import json
from pathlib import Path
import re
import sys
from rubato.convert import read_score

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'lesson-engine'))
from notation import rhythm_window, build_notation


def windows(folder):
    data=json.loads((folder/'windows.json').read_text())
    return [rhythm_window(read_score(item['result']['text']),item['start'],item['owns_until'],raw_text=item['result']['text']) for item in data]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-directory',type=Path,
                        help='Write candidate lesson JSONs here without publishing them.')
    options=parser.parse_args()
    if options.output_directory:
        options.output_directory.mkdir(parents=True,exist_ok=True)
    peace=windows(ROOT/'transcription/rubato/peace-score-overlap')
    pervane=windows(ROOT/'transcription/rubato/pervane/raw-score')
    page=ROOT/'piano.html'; html=page.read_text()
    outputs=[]
    for identifier in ['rubato-song-data']:
        pattern=r'(<script id="'+identifier+r'" type="application/json">)(.*?)(</script>)'
        match=re.search(pattern,html,re.S); lesson=json.loads(match[2])
        lesson['notation']=build_notation(lesson,peace,5.64)
        if options.output_directory:
            (options.output_directory/(identifier+'.json')).write_text(json.dumps(lesson,ensure_ascii=False))
        payload=json.dumps(lesson,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
        html=html[:match.start(2)]+payload+html[match.end(2):]
        print(identifier,len(lesson['notation']['measures']),'measures')
    outputs.append((page,html))
    paths=[ROOT/'transcription/rubato/pervane/separated-lesson.json']
    if not options.output_directory:
        for name in ['PianoMan','PianoManDevelopment']:
            paths.extend((Path.home()/'Library/Application Support'/name/'Lessons').glob('*.json'))
    for path in paths:
        lesson=json.loads(path.read_text())
        if 'pervane' not in lesson['title'].lower(): continue
        lesson['notation']=build_notation(lesson,pervane,lesson['provenance']['sourceOffsetSeconds'])
        if options.output_directory:
            (options.output_directory/'pervane.json').write_text(json.dumps(lesson,ensure_ascii=False))
        outputs.append((path,json.dumps(lesson,ensure_ascii=False,separators=(',',':'))))
        print(path.name,len(lesson['notation']['measures']),'measures')
    if options.output_directory:return
    for path,payload in outputs:
        pending=path.with_suffix('.pending')
        pending.write_text(payload)
        pending.replace(path)


if __name__=='__main__': main()
