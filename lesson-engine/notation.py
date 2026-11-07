"""Compile a readable score projection without changing the lesson performance."""
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from fractions import Fraction
from math import log, log2
from statistics import median


def rhythm_window(score, start, owns_until, raw_text=None):
    from rubato.convert.midi import TimeMap

    def attacks(source):
        clock = TimeMap(source)
        result = []
        for bar in source.bars:
            for staff in bar.staves:
                for layer in staff.layers:
                    position = bar.start
                    for event in layer.events:
                        for note in event.notes:
                            if not note.tie_stop:
                                result.append((clock(position)+start,note.pitch.midi,note.pitch.text(),staff.label))
                        position += event.duration
        return result

    repair = {}
    staff_repairs = []
    if raw_text is not None:
        from notation_source import source_staff_repairs
        staff_repairs, repair = source_staff_repairs(raw_text,score)
    clock = TimeMap(score)
    bars = []
    for index,bar in enumerate(score.bars):
        begin,end = clock(bar.start)+start,clock(bar.start+bar.length)+start
        if end<=begin:
            continue
        anchors = [[float(position-bar.start),clock(position)+start]
                   for position in sorted(score.stamps) if bar.start<=position<=bar.start+bar.length]
        durations = [event.duration for staff in bar.staves for layer in staff.layers for event in layer.events]
        bars.append(dict(start=begin,end=end,length=str(bar.length),beats=bar.ts_top,beatType=bar.ts_bot,
                         key=bar.key,pickup=bar.pickup,anchors=anchors,
                         triplets=any(value.denominator%3==0 for value in durations),
                         fine=any(0<value<Fraction(1,16) for value in durations),
                         edge=index==0 or index==len(score.bars)-1))
    spellings = []
    for seconds,midi,text,staff in attacks(score):
        matches = [item for item in staff_repairs if item['pitch']==midi and item['fromStaff']==staff and abs(item['time']+start-seconds)<.025]
        changed = bool(matches)
        recovered = matches[0]['toStaff'] if changed else staff
        spellings.append([seconds,midi,text,recovered,changed])
    return dict(bars=bars,spellings=spellings,start=start,ownsUntil=owns_until,staffRepair=repair)


def _source_clock(windows, source_offset, final_time):
    """Choose overlapping rhythmic evidence before constructing complete measures.

    Complete interior bars outrank crop edges. Beat durations that agree with the
    surrounding evidence outrank isolated half/double interpretations. Crucially,
    a new inference window never shortens an existing bar to its ownership cut.
    """
    candidates = [dict(bar,window=window.get('start',0)) for window in windows for bar in window['bars']
                  if bar['end']>source_offset and bar['start']<final_time]
    if not candidates:
        raise ValueError('Model ölçü bilgisi üretmedi; partisyon oluşturulamadı.')
    periods = [(bar['end']-bar['start'])/(float(Fraction(bar['length']))*4) for bar in candidates]
    reference = median(periods)
    for bar,period in zip(candidates,periods):
        bar['period']=period
        bar['length']=Fraction(bar['length'])
    initial = min((bar for bar in candidates if bar['start']<=source_offset+.04),
                  key=lambda bar:(abs(log(bar['period']/reference))+.15*bar['edge'],abs(bar['start']-source_offset)),
                  default=min(candidates,key=lambda bar:bar['start']))
    begin=initial['start']
    raw=sorted({begin,final_time,*[value for bar in candidates for value in [bar['start'],bar['end'],*[t for p,t in bar['anchors']]]
                                 if begin<value<final_time]})
    times=[]
    for stamp in raw:
        if times and stamp-times[-1]<.025 and stamp!=final_time:
            continue
        times.append(stamp)
    points=[(0.0,begin)]; choices=[]; quarter=0.0; recent=[reference]*8

    def local(bar,seconds):
        anchors=[(0.0,bar['start'])]+[(p,t) for p,t in bar['anchors'] if 0<p<float(bar['length']) and bar['start']<t<bar['end']]+[(float(bar['length']),bar['end'])]
        index=max(0,min(len(anchors)-2,bisect_right([t for p,t in anchors],seconds)-1))
        p0,t0=anchors[index];p1,t1=anchors[index+1]
        return (p0+(p1-p0)*(seconds-t0)/(t1-t0))*4

    for left,right in zip(times,times[1:]):
        middle=(left+right)/2
        options=[bar for bar in candidates if bar['start']-.025<=middle<=bar['end']+.025]
        context=median(recent[-24:])
        if options:
            source=min(options,key=lambda bar:abs(log(bar['period']/context))+.12*bar['edge'])
            delta=local(source,right)-local(source,left)
            effective=source['period']
            supporters={bar['window'] for bar in options if abs(log(bar['period']/effective))<.08}
            octave=round(log2(effective/context))
            factor=2**octave
            if octave and abs(log(effective/context/factor))<.08 and len(supporters)<2:
                # A crop seam covered by only one contradictory interpretation
                # must not insert/remove beats. Independent agreement can change
                # the rate; an isolated half/double hypothesis cannot.
                delta*=factor;effective/=factor
            if delta<=0: delta=(right-left)/context
            recent.append(effective)
        else:
            source=choices[-1][2] if choices else initial
            delta=(right-left)/context
        quarter+=delta
        nearest=round(quarter*8)/8
        if abs(nearest-quarter)<.025:
            quarter=nearest
        if quarter<=points[-1][0]:
            quarter=points[-1][0]+delta
        points.append((quarter,right));choices.append((left,right,source))
    return points,choices,initial


def _meter_evidence(windows):
    runs=[]
    for window in windows:
        sequence=[]
        def record():
            if not sequence:return
            nominal=[bar for bar in sequence if not bar['pickup'] and Fraction(bar['length'])==Fraction(bar['beats'],bar['beatType'])]
            if len(nominal)<2 or len(nominal)<len(sequence)*.6:return
            first=nominal[0]
            runs.append(dict(meter=(first['beats'],first['beatType']),start=first['start'],end=sequence[-1]['end'],
                             window=window.get('start',0),period=median((bar['end']-bar['start'])/(float(Fraction(bar['length']))*4) for bar in nominal)))
        for bar in window['bars']:
            if sequence and (bar['beats'],bar['beatType'])!=(sequence[-1]['beats'],sequence[-1]['beatType']):record();sequence=[]
            sequence.append(bar)
        record()
    if not runs:
        raise ValueError('Güvenilir ölçü seçmek için en az iki tutarlı tam ölçü gerekiyor.')
    first=min(runs,key=lambda run:(run['window'],run['start']))
    supported=[]
    for run in runs:
        independent=[other for other in runs if other['window']!=run['window'] and other['meter']==run['meter']
                     and min(other['end'],run['end'])-max(other['start'],run['start'])>=
                     2*float(Fraction(*run['meter']))*4*min(other['period'],run['period'])]
        if independent:supported.append(run)
    regions=[]
    for run in sorted(supported,key=lambda run:run['start']):
        overlap=next((region for region in regions if region['meter']==run['meter'] and region['end']>=run['start']-.05),None)
        if overlap:overlap['end']=max(overlap['end'],run['end'])
        else:regions.append(dict(meter=run['meter'],start=run['start'],end=run['end']))
    proposed={(bar['beats'],bar['beatType']) for window in windows for bar in window['bars'] if not bar['pickup']}
    accepted={first['meter'],*[region['meter'] for region in regions]}
    audit=dict(initial=list(first['meter']),corroborated=[dict(meter=list(region['meter']),start=region['start'],end=region['end']) for region in regions],
               uncorroborated=[list(meter) for meter in sorted(proposed-accepted)])
    return first['meter'],regions,audit


def _assemble_bars(windows, offset, duration):
    points,choices,initial=_source_clock(windows,offset,offset+duration)
    quarters=[q for q,t in points];seconds=[t for q,t in points]

    def at(quarter):
        index=max(0,min(len(points)-2,bisect_right(quarters,quarter)-1))
        q0,t0=points[index];q1,t1=points[index+1]
        return t0+(t1-t0)*(quarter-q0)/(q1-q0)

    meter,regions,meter_audit=_meter_evidence(windows)
    bars=[];position=Fraction(0);length=initial['length'] if initial['pickup'] else Fraction(*meter)
    while float(position*4)<quarters[-1]-.001:
        begin=at(float(position*4))
        matching=[entry for entry in choices if entry[0]-.025<=begin<entry[1]+.025]
        source=matching[-1][2] if matching else choices[-1][2]
        # Retain source meter changes and initial pickup; do not promote crop tails
        # to new short measures. A final incomplete measure is kept explicitly.
        confirmed=[region for region in regions if region['start']-.05<=begin<region['end']-.05]
        if confirmed:meter=max(confirmed,key=lambda region:region['start'])['meter']
        if bars:length=Fraction(*meter)
        finish=position+length
        final=float(finish*4)>quarters[-1]+.001
        if final:
            remaining=Fraction(round((quarters[-1]/4-float(position))*16),16)
            if remaining>0: length=remaining;finish=position+length
        end=at(min(float(finish*4),quarters[-1]))
        anchors=[(Fraction(0),begin-offset)]
        anchors.extend((Fraction(str(q/4)).limit_denominator(3072)-position,t-offset) for q,t in points
                       if float(position*4)<q<float(finish*4) and begin<t<end)
        anchors.append((length,end-offset))
        evidence=[entry[2] for entry in choices if entry[0]<end and entry[1]>begin]
        bars.append(dict(start=begin-offset,end=end-offset,metric=position,length=length,
                         beats=meter[0],beatType=meter[1],key=source['key'],
                         pickup=(not bars and initial['pickup']) or final,anchors=anchors,
                         triplets=any(item['triplets'] for item in evidence),fine=any(item['fine'] for item in evidence)))
        position=finish
        if final: break
    return bars,meter_audit


def _clef_plan(bars, physical, hand):
    """Minimize ledger burden across the phrase, including the cost of switching.

    A single moderately high/low bar should not flip the clef and immediately
    flip it back. Sustained register changes can still justify a new clef.
    """
    clefs=('G2','F4'); bounds={'G2':(30,38),'F4':(18,26)}
    preferred='G2' if hand=='PR' else 'F4'
    previous={clef:0 if clef==preferred else 24 for clef in clefs}
    links=[]
    for bar in bars:
        start=bar['metric'];end=start+bar['length']
        members=[item for item in physical if item['hand']==hand and item['on']<end and item['end']>start]
        costs={};back={}
        for clef in clefs:
            low,high=bounds[clef]
            burden=0
            for item in members:
                pitch=item['pitch'].diatonic
                ledger=max(0,(low-pitch)//2,(pitch-high)//2)
                weight=float((min(end,item['end'])-max(start,item['on']))/bar['length'])
                burden+=ledger*ledger*weight
            crossing=any(item['on']<start<item['end'] for item in members)
            parent=min(clefs,key=lambda prior:previous[prior]+(0 if prior==clef else 24+(8 if crossing else 0)))
            costs[clef]=previous[parent]+burden+(0 if parent==clef else 24+(8 if crossing else 0))
            back[clef]=parent
        previous=costs;links.append(back)
    chosen=min(clefs,key=lambda clef:previous[clef]);result=[]
    for back in reversed(links):result.append(chosen);chosen=back[chosen]
    return list(reversed(result))


def build_notation(lesson, windows, source_offset):
    from rubato.convert._model import parse_pitch
    from score_writer import write_score
    notes=sorted((note for track in lesson['tracks'] for note in track['notes']),key=lambda n:(n['time'],n['midi']))
    duration=max(lesson['duration'],max(note['end'] for note in notes))
    bars,meter_audit=_assemble_bars(windows,source_offset,duration)
    starts=[bar['start'] for bar in bars];position=bars[-1]['metric']+bars[-1]['length']
    spellings=defaultdict(list)
    for window in windows:
        for item in window['spellings']:
            spellings[item[1]].append((item[0]-source_offset,*item[2:]))
    alterations=['C','C#','D','E-','E','F','F#','G','A-','A','B-','B']

    def local_position(seconds):
        bar_index=max(0,min(len(bars)-1,bisect_right(starts,seconds)-1))
        bar=bars[bar_index]
        anchors=bar['anchors'];index=max(0,min(len(anchors)-2,bisect_right([t for p,t in anchors],seconds)-1))
        p0,t0=anchors[index];p1,t1=anchors[index+1]
        local=p0+(p1-p0)*Fraction(str((seconds-t0)/(t1-t0)))
        return bar_index,min(bar['length'],max(Fraction(0),local))

    # Choose one subdivision for a whole beat, not independently for each note
    # endpoint. Mixing binary and ternary grids creates artificial 48:29 tuplets.
    beat_points=defaultdict(set)
    for item in notes:
        for seconds in (item['time'],item['end']):
            index,local=local_position(seconds)
            beat=int(local*4)
            beat_points[index,beat].add(float(local*4-beat))
    for index,bar in enumerate(bars):
        bar['tripletBeats']=[]
        if not bar['triplets']:continue
        for (owner,beat),points in beat_points.items():
            if owner!=index:continue
            interior=[point for point in points if .08<point<.92]
            binary=8 if bar['fine'] else 4
            straight=sum((point-round(point*binary)/binary)**2 for point in interior)
            ternary=sum((point-round(point*3)/3)**2 for point in interior)
            supported={round(point*3) for point in interior if abs(point-round(point*3)/3)<.06}
            if supported & {1,2} and ternary<straight*.5:
                bar['tripletBeats'].append(beat)

    def metric(seconds):
        index,local=local_position(seconds);bar=bars[index]
        grid=32 if bar['fine'] else 16
        if int(local*4) in bar['tripletBeats']:grid=12
        quantized=Fraction(round(float(local)*grid),grid)
        return bar['metric']+min(bar['length'],quantized)

    # Repeated attacks that round to one slot must occupy distinct slots on
    # that same rhythmic grid. Inserting an arbitrary 64th between them would
    # mix subdivisions again and manufacture tiny notes/rests inside tuplets.
    slots={position}
    for bar in bars:
        for beat in range((bar['length']*4).__ceil__()):
            step=Fraction(1,12 if beat in bar['tripletBeats'] else 32 if bar['fine'] else 16)
            local=Fraction(beat,4)
            until=min(bar['length'],local+Fraction(1,4))
            while local<until:
                slots.add(bar['metric']+local);local+=step
        slots.add(bar['metric']+bar['length'])
    slots=sorted(slots)

    provenance=lesson.get('provenance',{})
    recover_model_staff=str(provenance.get('model','')).startswith('Rubato') and provenance.get('visualDataUsed') is False
    physical=[];staff_repairs=0
    for note in notes:
        onset,end=metric(note['time']),metric(note['end'])
        onset=min(onset,slots[-2])
        if end<=onset:end=slots[bisect_right(slots,onset)]
        closest=min(spellings[note['midi']],key=lambda item:abs(item[0]-note['time'])) if spellings[note['midi']] else None
        matched=closest is not None and abs(closest[0]-note['time'])<=.08
        text=closest[1] if matched else alterations[note['midi']%12]+str(note['midi']//12-1)
        hand='PL' if note.get('hand',note['midi']>=60)==0 else 'PR'
        if recover_model_staff and matched and len(closest)>3 and closest[3] and closest[2]!=hand:
            hand=closest[2];staff_repairs+=1
        physical.append(dict(on=onset,end=min(position,end),pitch=parse_pitch(text)[0],hand=hand,time=note['time']))
    # Quantization must not fuse repeated attacks of the same pitch.
    repeats=defaultdict(list)
    for item in physical: repeats[(item['hand'],item['pitch'].midi)].append(item)
    for sequence in repeats.values():
        indices=[bisect_left(slots,item['on']) for item in sequence]
        for index in range(1,len(indices)):
            indices[index]=max(indices[index],indices[index-1]+1)
        indices[-1]=min(indices[-1],len(slots)-2)
        for index in range(len(indices)-2,-1,-1):
            indices[index]=min(indices[index],indices[index+1]-1)
        if indices[0]<0:
            raise ValueError('Tekrarlanan notalar seçilen ritmik ızgaraya sığmıyor.')
        for item,index in zip(sequence,indices):item['on']=slots[index]
        for index,item in enumerate(sequence):
            boundary=sequence[index+1]['on'] if index+1<len(sequence) else position
            item['end']=min(boundary,max(item['end'],slots[indices[index]+1]))
    clefs={hand:_clef_plan(bars,physical,hand) for hand in ('PR','PL')}
    pedals=[];dynamic_marks=[]

    initial_periods=[(bar['end']-bar['start'])/(float(bar['length'])*4) for bar in bars[:8]]
    tempo=round(60/median(initial_periods))
    event_times=sorted({0,duration,*[max(0,event['time']) for track in lesson['tracks'] for event in track.get('pedals',[])]})
    previous=False
    tracks=[sorted(track.get('pedals',[]),key=lambda event:event['time']) for track in lesson['tracks']]
    for seconds in event_times:
        pressed=False
        for events in tracks:
            index=bisect_right([event['time'] for event in events],seconds)-1
            pressed|=index>=0 and events[index]['value']>=.5
        if seconds>=duration:pressed=False
        if pressed==previous:continue
        previous=pressed;at=metric(seconds)
        # A quantized down/up at the same point has no printable duration.
        if pedals and pedals[-1][0]==at:
            pedals.pop()
        else:
            pedals.append((at,pressed))
    levels=[(32,'pp'),(48,'p'),(64,'mp'),(80,'mf'),(100,'f'),(128,'ff')]
    last=None;pending=None
    for i,bar in enumerate(bars):
        velocities=[round(note['velocity']*127) for note in notes if bar['start']<=note['time']<bar['end']]
        if not velocities:continue
        value=median(velocities);level=next(label for cutoff,label in levels if value<cutoff)
        if last is not None and level!=last and level!=pending:pending=level;continue
        if level==last:pending=None;continue
        last=level;pending=None
        dynamic_marks.append((i,level))
    musicxml=write_score(bars,physical,clefs,lesson['title'],tempo,pedals,dynamic_marks)
    return dict(musicxml=musicxml,
                measures=[dict(start=max(0,bar['start']),end=bar['end'],quarter=float(bar['metric']*4),length=float(bar['length']*4),
                               anchors=[[float(p*4),t] for p,t in bar['anchors']]) for bar in bars],
                source='Örtüşen Rubato ritim tahminlerinden ortak ölçü saati; otomatik nota yazımı',
                pedal='Dersin birleşik CC64 tahmini',dynamics='Velocity medyanından süreklilik süzgeçli nüans tahmini',
                tempo=dict(approximate=True,quarterBpm=tempo),meterEvidence=meter_audit,staffRepairs=staff_repairs,
                sourceStaffRepairs=[window.get('staffRepair',{}) for window in windows if window.get('staffRepair')],
                quantization='Gösterim için 16lık/32lik ritim; yalnız kaynak destekliyorsa üçleme; çalma zamanları korunur',
                engraving=dict(engine='music21',version='9.9.1'),repairs=[])
