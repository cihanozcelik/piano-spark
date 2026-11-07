"""Import symbolic scores; audio transcription and its meter inference are not used."""
from bisect import bisect_right
from collections import defaultdict, deque
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import os


def midi_performance(path):
    import mido
    source=mido.MidiFile(path)
    if source.type==2 or source.ticks_per_beat<=0:
        raise ValueError('Vuruş tabanlı, eşzamanlı standart MIDI gerekiyor (tip 0 veya 1).')
    tick=0;seconds=0.;tempo=500000
    anchors=[(0.,0.)];active=defaultdict(deque);notes=[];pedals=defaultdict(list)
    for message in mido.merge_tracks(source.tracks):
        tick+=message.time
        seconds+=mido.tick2second(message.time,source.ticks_per_beat,tempo)
        if message.type=='set_tempo':
            anchors.append((tick/source.ticks_per_beat,seconds));tempo=message.tempo
        elif message.type=='control_change' and message.control==64:
            pedals[message.channel].append(dict(time=seconds,value=message.value/127))
        elif message.type=='note_on' and message.velocity and message.channel!=9:
            active[message.channel,message.note].append((seconds,message.velocity))
        elif message.type in ('note_off','note_on') and active[message.channel,message.note]:
            start,velocity=active[message.channel,message.note].popleft()
            if seconds>start and 21<=message.note<=108:
                notes.append(dict(midi=message.note,time=start,end=seconds,velocity=velocity/127,
                                  hand=0 if message.note<60 else 1,channel=message.channel))
    for (channel,pitch),pending in active.items():
        for start,velocity in pending:
            if seconds>start and 21<=pitch<=108:
                notes.append(dict(midi=pitch,time=start,end=seconds,velocity=velocity/127,
                                  hand=0 if pitch<60 else 1,channel=channel))
    if not notes:raise ValueError('Dosyada çalınabilir piyano notası bulunamadı.')
    anchors.append((tick/source.ticks_per_beat,seconds))
    # Extend the final tempo to the last notated rest, if present.
    def at(quarter):
        index=max(0,bisect_right([q for q,t in anchors],quarter)-1)
        q,t=anchors[index]
        if index+1<len(anchors):
            q1,t1=anchors[index+1]
            if q1>q:return t+(quarter-q)*(t1-t)/(q1-q)
        return t+(quarter-q)*tempo/1_000_000
    tracks=[]
    for hand in (0,1):
        selected=sorted((n for n in notes if n['hand']==hand),key=lambda n:(n['time'],n['midi']))
        channels={n.pop('channel') for n in selected}
        events=sorted((e['time'],c,e['value']) for c in channels for e in pedals[c])
        channel_values={c:0. for c in channels};combined=[]
        for time,channel,value in events:
            channel_values[channel]=value
            level=max(channel_values.values())
            if combined and combined[-1]['time']==time:combined[-1]['value']=level
            elif not combined or level!=combined[-1]['value']:combined.append(dict(time=time,value=level))
        tracks.append(dict(id=hand,name='Sol el' if hand==0 else 'Sağ el',notes=selected,
                           pedals=combined))
    return tracks,at,anchors


def import_score(source,request,work,engine,emit):
    from music21 import converter, layout, midi, stream, tempo
    from statistics import median
    from music21.musicxml.m21ToXml import GeneralObjectExporter
    kind=request['kind'];title=request.get('title') or request.get('sourceName',source.stem)
    if kind=='pdf':
        emit('notation','PDF sayfalarındaki notalar okunuyor…',.12)
        output=work/'recognized-pages.json'
        environment=os.environ.copy()
        environment['PYTHONPATH']=str(engine/'omr-site-packages')
        environment['PYTHONNOUSERSITE']='1'
        subprocess.run([sys.executable,'-u',str(engine/'pdf_recognizer.py'),
                        str(source),str(output)],env=environment,check=True)
        pages=[converter.parse(path) for path in json.loads(output.read_text())]
        score=pages[0]
        for page in pages[1:]:
            if len(page.parts)!=len(score.parts):
                raise ValueError('PDF sayfalarında farklı sayıda porte okundu; sayfalar güvenilir biçimde birleştirilemedi.')
            offset=score.highestTime
            for destination,part in zip(score.parts,page.parts):
                for measure in list(part.getElementsByClass(stream.Measure)):
                    destination.insert(offset+measure.offset,measure)
        for part in score.parts:
            for number,measure in enumerate(part.getElementsByClass(stream.Measure),1):measure.number=number
        model='homr 0.7.0 · ONNX'
    else:
        emit('notation','MIDI notaları ve ritimleri okunuyor…',.25)
        score=converter.parse(str(source),format='midi',quantizePost=True,
                              quarterLengthDivisors=(4,3,8))
        # MIDI events may overlap without explicit notation voices. Let music21
        # allocate voices before export, otherwise durations serialize in sequence.
        for part in score.parts:
            for measure in part.getElementsByClass(stream.Measure):
                measure.makeVoices(inPlace=True)
        if len(score.parts)==2:
            ordered=sorted(score.parts,key=lambda part:median(
                [pitch.midi for event in part.recurse().notes for pitch in event.pitches] or [60]),reverse=True)
            for part in ordered:score.remove(part)
            for part in ordered:score.insert(0,part)
            score.insert(0,layout.StaffGroup(ordered,name='Piano',symbol='brace',barTogether=True))
        model='MIDI · music21 9.9.1'
    if not score.parts:raise ValueError('Dosyada okunabilir bir nota partisi bulunamadı.')
    warnings=[]
    if kind=='pdf':
        overfull={measure.number for part in score.parts
                  for measure in part.getElementsByClass(stream.Measure)
                  if measure.highestTime>measure.barDuration.quarterLength+.001}
        warnings.append('Bu PDF okuyucu pedal işaretlerini aktaramıyor.')
        if overfull:
            warnings.append(f'{len(overfull)} ölçüde ritim tutarsızlığı saptandı; bu sonuç çalışma için güvenilir değil.')
    # Use written repeat semantics for both the displayed and played score.
    if kind=='pdf' and list(score.recurse().getElementsByClass('Repeat')):
        score=score.expandRepeats()
    fallback_tempo=False
    if not list(score.recurse().getElementsByClass(tempo.MetronomeMark)):
        fallback_tempo=True
        score.parts[0].measure(0,indicesNotNumbers=True).insert(
            0,tempo.MetronomeMark(number=max(20,min(300,float(request.get('tempo',60))))))
    emit('notation','Ders ve partisyon eşleniyor…',.85)
    performance=source
    if kind=='pdf':
        performance=work/'recognized.mid'
        data=midi.translate.streamToMidiFile(score)
        data.open(str(performance),'wb');data.write();data.close()
    tracks,seconds_at,anchors=midi_performance(performance)
    # PDF staff assignments come from the recognized grand staff, not pitch alone.
    if kind=='pdf':
        assignments=defaultdict(deque)
        for index,part in enumerate(score.parts):
            hand=1 if index==0 and len(score.parts)>1 else 0 if index==1 else None
            for event in part.flatten().notes:
                pitches=event.pitches
                for pitch in pitches:
                    assignments[pitch.midi,round(seconds_at(float(event.offset)),4)].append(hand)
        combined=[n for track in tracks for n in track['notes']]
        for note in combined:
            candidates=assignments[note['midi'],round(note['time'],4)]
            if candidates:
                hand=candidates.popleft()
                if hand is not None:note['hand']=hand
        for track in tracks:
            track['notes']=sorted((n for n in combined if n['hand']==track['id']),key=lambda n:(n['time'],n['midi']))
    measures=[]
    first=score.parts[0]
    score_measures=list(first.getElementsByClass(stream.Measure))
    for index,measure in enumerate(score_measures):
        start=float(measure.offset)
        end=float(score_measures[index+1].offset) if index+1<len(score_measures) else float(score.highestTime)
        if end<=start:raise ValueError('Nota okuyucu sıfır uzunlukta ölçü üretti; PDF’den güvenilir ders çıkarılamadı.')
        points=[(0.,seconds_at(start)),*[(q-start,t) for q,t in anchors if start<q<end],(end-start,seconds_at(end))]
        measures.append(dict(start=seconds_at(start),end=seconds_at(end),quarter=start,length=end-start,anchors=points))
    exporter=GeneralObjectExporter(score)
    # OMR already supplies measured, voiced MusicXML. Preserve those voices;
    # do not ask makeNotation to infer a new voice topology across page breaks.
    if kind=='pdf':exporter.makeNotation=False
    xml=exporter.parse().decode('utf-8')
    notes=[n for track in tracks for n in track['notes']]
    description=('PDF’den otomatik okundu · Okuma hataları olabilir' if kind=='pdf' else
                 'MIDI’den aktarıldı · El ayrımı perdeye göre tahmini')
    if fallback_tempo:description+=f' · Tempo: {request.get("tempo",60)} BPM (seçilen değer)'
    if warnings:description+=' · '+' '.join(warnings)
    return dict(id=request['id'],title=title,description=description,noteCount=len(notes),
                duration=max(measures[-1]['end'],max(n['end'] for n in notes)),tracks=tracks,
                midiFilename=title+'.mid',
                provenance=dict(sourceKind=kind,sourceName=request.get('sourceName',source.name),
                                sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                                model=model,tempoAssumed=fallback_tempo,warnings=warnings),
                notation=dict(musicxml=xml,measures=measures,
                              source='PDF nota tanıma' if kind=='pdf' else 'MIDI ritim verisi',
                              engraving=dict(engine='music21',version='9.9.1')))
