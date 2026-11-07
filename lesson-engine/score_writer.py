"""Engrave the lesson's metric projection with music21's notation objects.

This module owns notation, not transcription: it never shortens a performance
note to make a voice easier to print. Music21 owns rests, duration spelling,
ties, accidentals, beams, tuplets and MusicXML serialization.
"""
from bisect import bisect_right
from collections import defaultdict
from fractions import Fraction

from music21 import (
    bar, chord, clef, duration, dynamics, expressions, instrument, key, layout, metadata,
    meter, note, spanner, stream, tempo,
)
from music21.musicxml.m21ToXml import GeneralObjectExporter


def _spell_duration(event):
    quarters = Fraction(event.quarterLength)
    if quarters.denominator % 3 == 0:
        # The projection admits binary and triplet subdivisions only. Tell
        # music21 the known 3:2 grouping instead of inferring arbitrary ratios
        # from a compound duration (e.g. 5/12 = 1/3 tied to 1/12).
        event.duration = duration.Duration(quarters * Fraction(3, 2))
        event.duration.appendTuplet(duration.Tuplet(3, 2))


def write_score(bars, physical, clefs, title, quarter_bpm, pedals, dynamic_marks):
    score = stream.Score()
    score.metadata = metadata.Metadata(title=title)
    starts = [entry['metric'] * 4 for entry in bars]
    ends = [(entry['metric'] + entry['length']) * 4 for entry in bars]
    rhythm_boundaries = sorted({entry['metric'] * 4 + beat + edge
                                for entry in bars for beat in entry['tripletBeats']
                                for edge in (0, 1)})
    parts = []
    voice_base = 1

    for hand in ('PR', 'PL'):
        part = stream.PartStaff(id=hand)
        part.insert(0, instrument.Piano())
        grouped = defaultdict(list)
        for item in physical:
            if item['hand'] == hand:
                grouped[(item['on'] * 4, item['end'] * 4)].append(item['pitch'].text())
        unmeasured = stream.Stream()
        for (onset, finish), pitches in sorted(grouped.items()):
            event = chord.Chord(pitches) if len(pitches) > 1 else note.Note(pitches[0])
            event.quarterLength = finish - onset
            unmeasured.insert(onset, event)
        unmeasured.makeVoices(inPlace=True, fillGaps=False)
        voices = list(unmeasured.voices) if unmeasured.hasVoices() else [unmeasured]

        measures = []
        prior_context = None
        for index, entry in enumerate(bars):
            measure = stream.Measure(number=index + 1)
            context = (entry['beats'], entry['beatType'], entry['key'], clefs[hand][index])
            if prior_context is None or context[:2] != prior_context[:2]:
                measure.timeSignature = meter.TimeSignature(f'{context[0]}/{context[1]}')
            if prior_context is None or context[2] != prior_context[2]:
                measure.keySignature = key.KeySignature(context[2])
            if prior_context is None or context[3] != prior_context[3]:
                measure.clef = clef.TrebleClef() if context[3] == 'G2' else clef.BassClef()
            missing = Fraction(entry['beats'] * 4, entry['beatType']) - entry['length'] * 4
            if missing > 0:
                if index == 0:
                    measure.paddingLeft = missing
                else:
                    measure.paddingRight = missing
            prior_context = context
            part.insert(starts[index], measure)
            measures.append(measure)

        for voice_index, source in enumerate(voices):
            destinations = {}
            for event in source.notes:
                onset = Fraction(event.offset)
                finish = onset + Fraction(event.quarterLength)
                first = max(0, bisect_right(starts, onset) - 1)
                cuts = sorted({onset, finish,
                               *[end for end in ends[first:] if onset < end < finish],
                               *[at for at in rhythm_boundaries if onset < at < finish]})
                fragments = event.splitByQuarterLengths([b - a for a, b in zip(cuts, cuts[1:])])
                for at, fragment in zip(cuts, fragments):
                    index = min(len(bars) - 1, bisect_right(starts, at) - 1)
                    if index not in destinations:
                        voice = stream.Voice(id=voice_base + voice_index)
                        measures[index].insert(0, voice)
                        destinations[index] = voice
                    destinations[index].insert(at - starts[index], fragment)
            for index, voice in destinations.items():
                voice.makeRests(inPlace=True, fillGaps=True,
                                refStreamOrTimeRange=(0, bars[index]['length'] * 4))
                for rest in list(voice.recurse().getElementsByClass(note.Rest)):
                    at = Fraction(rest.offset)
                    finish = at + Fraction(rest.quarterLength)
                    cuts = [at, *[boundary - starts[index] for boundary in rhythm_boundaries
                                  if at < boundary - starts[index] < finish], finish]
                    if len(cuts) == 2:
                        continue
                    voice.remove(rest)
                    for offset, fragment in zip(cuts, rest.splitByQuarterLengths(
                            [b - a for a, b in zip(cuts, cuts[1:])])):
                        voice.insert(offset, fragment)
        for index, measure in enumerate(measures):
            if not measure.hasVoices():
                silence = stream.Voice(id=voice_base)
                silence.insert(0, note.Rest(quarterLength=bars[index]['length'] * 4))
                measure.insert(0, silence)
            elif len(measure.voices) > 1:
                # Independent durations need visibly independent voices. The
                # upper register gets upward stems, the lower downward stems.
                ordered = sorted(measure.voices, key=lambda voice: sum(
                    pitch.midi for event in voice.notes for pitch in event.pitches
                ) / sum(len(event.pitches) for event in voice.notes), reverse=True)
                for rank, voice in enumerate(ordered):
                    for event in voice.notes:
                        event.stemDirection = 'up' if rank % 2 == 0 else 'down'
        voice_base += len(voices)
        for event in part.recurse().notesAndRests:
            _spell_duration(event)
        part.splitAtDurations(recurse=True)
        part.makeAccidentals(inPlace=True)
        part.makeBeams(inPlace=True)
        for measure in measures:
            for voice in measure.voices or [measure]:
                stream.makeNotation.makeTupletBrackets(voice, inPlace=True)
        measures[-1].rightBarline = bar.Barline('final')
        score.insert(0, part)
        parts.append(part)

    score.insert(0, layout.StaffGroup(parts, name='Piano', symbol='brace', barTogether=True))
    opening_tempo = tempo.MetronomeMark(number=quarter_bpm, parentheses=True)
    parts[0].measure(1).insert(0, opening_tempo)
    for index, level in dynamic_marks:
        parts[0].measure(index + 1).insert(0, dynamics.Dynamic(level))

    pedal_start = None
    for position, pressed in pedals:
        at = position * 4
        index = min(len(bars) - 1, max(0, bisect_right(starts, at) - 1))
        anchor = spanner.SpannerAnchor()
        parts[1].measure(index + 1).insert(at - starts[index], anchor)
        if pressed:
            pedal_start = anchor
        else:
            mark = expressions.PedalMark(pedal_start, anchor)
            mark.pedalType = expressions.PedalType.Sustain
            mark.pedalForm = expressions.PedalForm.Line
            mark.placement = 'below'
            score.insert(0, mark)

    # The public notation steps above prepare the existing measure/voice grid.
    # Do not run makeTies again: it flattens single-voice measures, dropping
    # their persistent voice IDs even when a tie continues into the next bar.
    exporter = GeneralObjectExporter(score)
    exporter.makeNotation = False
    return exporter.parse().decode('utf-8')
