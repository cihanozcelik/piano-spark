"""Read a MIDI file the way a pianist reads the score it came from.

A MIDI file written from a score (LilyPond, MuseScore, a sequencer such as the
piano-midi.de files) keeps every note on the score's beat grid in its ticks, even
when a tempo map bends the timing on every beat. The notation therefore comes from
ticks, never from seconds, and the tempo map only decides when bars sound.

    piece = read_midi(path)          notes, tempo map, meters, keys, track names
    lesson_tracks(piece)             the practice hands, with every note's time in seconds
    notation(piece, title)           the lesson's score: MusicXML and its bars in seconds

A track named for a hand ("Piano right", "left", "RH") is that hand. Every other note
goes to the hand a pianist plays it with (_split_hands): neither hand stretches past a
tenth, the hands do not cross, a figure stays in one hand; a staff's name ("up",
"lower") is only a hint. Each track keeps its own voices, so a melody over an
accompaniment is written as two voices of one staff, as in print.
"""
from bisect import bisect_right
from collections import Counter, defaultdict, deque
from fractions import Fraction
from math import log2
import re
from statistics import median

# A track named for a hand is that hand; a track named for a staff only hints at one,
# since editions print notes of one hand on the other's staff.
RIGHT = re.compile(r'right|rechts|droite|destra|derecha|\br\.?\s?h\b|sağ', re.I)
LEFT = re.compile(r'left|links|gauche|sinistra|izquierda|\bl\.?\s?h\b|\bsol\b', re.I)
UPPER = re.compile(r'treble|upper|\bup\b|primo|oben', re.I)
LOWER = re.compile(r'\bbass\b|lower|\bdown\b|secondo|unten', re.I)
TEMPO_WORDS = re.compile(r'\b(grave|largo|larghetto|lento|adagio|adagietto|andante|andantino|moderato|allegretto|'
                         r'allegro|vivace|vivacissimo|presto|prestissimo|sostenuto|maestoso|tempo di)\b', re.I)
# Subdivisions of a quarter note, simplest first. A beat takes the first one its
# notes fit; 3, 6 and 12 are triplets.
GRIDS = (1, 2, 4, 3, 8, 6, 12, 16)
TERNARY = {3, 6, 12}
NEW_VOICE = 6       # a chord far from every free voice (see _voices.distance) starts a new one
# Letter: (pitch class, position on the line of fifths with C at 0).
LETTERS = {'F': (5, -1), 'C': (0, 0), 'G': (7, 1), 'D': (2, 2), 'A': (9, 3), 'E': (4, 4), 'B': (11, 5)}
MIDDLE_C = 60


class Pitch:
    """A spelled pitch in music21's text form, with the staff step _clef_plan needs."""
    __slots__ = ('step', 'alter', 'octave', 'midi')

    def __init__(self, step, alter, midi):
        self.step, self.alter, self.midi = step, alter, midi
        self.octave = (midi - alter - LETTERS[step][0]) // 12 - 1

    def text(self):
        return self.step + {-2: '--', -1: '-', 0: '', 1: '#', 2: '##'}[self.alter] + str(self.octave)

    @property
    def diatonic(self):
        return self.octave * 7 + 'CDEFGAB'.index(self.step)

    @property
    def fifths(self):
        return LETTERS[self.step][1] + 7 * self.alter


# ---- Reading ---------------------------------------------------------------------------

def read_midi(path):
    import mido
    source = mido.MidiFile(path)
    if source.type == 2 or source.ticks_per_beat <= 0:
        raise ValueError('Vuruş tabanlı, eşzamanlı standart MIDI gerekiyor (tip 0 veya 1).')
    tempos, meters, keys, words, names = [], [], [], [], {}
    notes, pedals, last = [], defaultdict(list), 0
    for index, track in enumerate(source.tracks):
        tick, active, pending_notes = 0, defaultdict(deque), []
        for message in track:
            tick += message.time
            kind = message.type
            if kind == 'set_tempo':
                tempos.append((tick, message.tempo))
            elif kind == 'time_signature':
                meters.append((tick, message.numerator, message.denominator))
            elif kind == 'key_signature':
                keys.append((tick, message.key))
            elif kind in ('marker', 'text', 'cue_marker') and tick == 0:
                words.append(message.text.strip())
            elif kind == 'track_name':
                names.setdefault(index, message.name)
            elif kind == 'control_change' and message.control == 64:
                pedals[index, message.channel].append((tick, message.value / 127))
            elif kind == 'note_on' and message.velocity and message.channel != 9:
                active[message.channel, message.note].append((tick, message.velocity))
            elif kind in ('note_off', 'note_on') and active[message.channel, message.note]:
                start, velocity = active[message.channel, message.note].popleft()
                pending_notes.append((message.channel, message.note, start, tick, velocity))
        last = max(last, tick)
        for (channel, pitch), waiting in active.items():
            pending_notes.extend((channel, pitch, start, tick, velocity) for start, velocity in waiting)
        for channel, pitch, start, end, velocity in pending_notes:
            if end > start and 21 <= pitch <= 108:
                notes.append(dict(source=(index, channel), midi=pitch, on_tick=start, off_tick=end,
                                  velocity=velocity / 127))
    if not notes:
        raise ValueError('Dosyada çalınabilir piyano notası bulunamadı.')
    notes.sort(key=lambda note: (note['on_tick'], note['midi']))
    # One tempo per tick: the last event at a tick wins, as when the file plays.
    tempo_map = [(0, 500000)]
    for tick, value in sorted(tempos, key=lambda event: event[0]):
        if tick == tempo_map[-1][0]: tempo_map[-1] = (tick, value)
        else: tempo_map.append((tick, value))
    piece = dict(resolution=source.ticks_per_beat, notes=notes, tempos=tempo_map, last=last,
                 meters=sorted(meters) or [(0, 4, 4)], keys=sorted(keys), words=words, names=names,
                 pedals=pedals)
    seconds_of = clock(piece)
    for note in notes:
        note['time'], note['end'] = seconds_of(note['on_tick']), seconds_of(note['off_tick'])
    piece['hands'] = hands(piece)
    return piece


def clock(piece):
    """Seconds at a tick, through the file's tempo map."""
    resolution, tempos = piece['resolution'], piece['tempos']
    ticks, seconds = [], []
    elapsed = 0.
    for index, (tick, value) in enumerate(tempos):
        if index:
            previous_tick, previous_value = tempos[index - 1]
            elapsed += (tick - previous_tick) * previous_value / 1e6 / resolution
        ticks.append(tick); seconds.append(elapsed)

    def seconds_of(tick):
        index = max(0, bisect_right(ticks, tick) - 1)
        return seconds[index] + (tick - ticks[index]) * tempos[index][1] / 1e6 / resolution
    return seconds_of


def hands(piece):
    """Hand of each track/channel whose name says it (1 right, 0 left), else None. Every
    note then gets its hand: a hand-named track's hand, otherwise the hand that can play it."""
    result, staves = {}, {}
    for source in {note['source'] for note in piece['notes']}:
        name = piece['names'].get(source[0], '')
        right, left = bool(RIGHT.search(name)), bool(LEFT.search(name))
        result[source] = 1 if right and not left else 0 if left and not right else None
        upper, lower = bool(UPPER.search(name)), bool(LOWER.search(name))
        if result[source] is None and upper != lower: staves[source] = 1 if upper else 0
    _split_hands(piece, result, staves)
    return result


SPAN = 15           # semitones one hand holds and strikes at once (a tenth)
OCTAVE = 12         # a hand stretches past an octave only at a cost
REACH = .6          # seconds a hand still covers the keys it just struck
BEAM = 48           # partial fingerings kept while splitting the hands


def _split_hands(piece, named, staves):
    """Give each note of a track not named for a hand the hand a pianist plays it with.

    Notes struck together are split low to the left, high to the right. A beam search
    over the piece prefers splits where neither hand stretches past SPAN across what it
    holds and strikes, nor reaches past it from what it struck within REACH, the hands do
    not cross, and each stays in its register. A staff's track ("up", "lower") or an
    unnamed track's register is a weak hint, so notes printed on one staff still go to
    the hand that can play them, as the triplets of the Moonlight sonata's bars 13-14 do."""
    pitches = defaultdict(list)
    for note in piece['notes']:
        pitches[note['source']].append(note['midi'])
    hint = dict(staves)
    if len(pitches) > 1:
        for source, values in pitches.items():
            if named[source] is None and source not in hint:
                hint[source] = 1 if median(values) >= MIDDLE_C else 0
    for note in piece['notes']:
        note['hand'] = named[note['source']]
    if all(hand is not None for hand in named.values()):
        return
    near = max(1, piece['resolution'] // 32)       # a spread chord is still struck together
    groups = []
    for note in piece['notes']:
        if groups and note['on_tick'] - groups[-1][0]['on_tick'] <= near: groups[-1].append(note)
        else: groups.append([note])

    def step(state, group, cut):
        cost, held, recent, trail = state
        at, now = group[0]['on_tick'], group[0]['time']
        fixed = [note for note in group if note['hand'] is not None]
        free = sorted((note for note in group if note['hand'] is None), key=lambda note: note['midi'])
        new = ([*[n for n in fixed if n['hand'] == 0], *free[:cut]],
               [*[n for n in fixed if n['hand'] == 1], *free[cut:]])
        held = tuple(tuple(item for item in held[hand] if item[0] > at + near) for hand in (0, 1))
        recent = tuple(tuple(item for item in recent[hand] if item[0] > now - REACH) for hand in (0, 1))
        sounding = [[midi for _, midi in held[hand]] + [note['midi'] for note in new[hand]] for hand in (0, 1)]
        line = [item for hand in (0, 1) for item in recent[hand] if item[0] < now - .01]
        for hand in (0, 1):
            if not new[hand]: continue
            span = max(sounding[hand]) - min(sounding[hand])
            cost += .4 * max(0, min(span, SPAN) - OCTAVE) + 4 * max(0, span - SPAN)
            cost += 20 * max(0, len(sounding[hand]) - 5)
            reach = sounding[hand] + [midi for _, midi, _ in recent[hand]]
            cost += .3 * max(0, max(reach) - min(reach) - SPAN)
            for note in new[hand]:
                cost += .05 * (max(0, note['midi'] - MIDDLE_C) if hand == 0 else max(0, MIDDLE_C - note['midi']))
                if note['source'] in hint and hint[note['source']] != hand: cost += 1
                # A figure runs on in the hand that played its previous note.
                before = [item for item in line if abs(item[1] - note['midi']) <= OCTAVE]
                if before and max(before)[2] != hand: cost += .6
        if sounding[0] and sounding[1] and max(sounding[0]) > min(sounding[1]):
            cost += 6
        held = tuple(held[hand] + tuple((note['off_tick'], note['midi']) for note in new[hand]) for hand in (0, 1))
        recent = tuple(recent[hand] + tuple((now, note['midi'], hand) for note in new[hand]) for hand in (0, 1))
        return cost, held, recent, (trail, cut)

    states = [(0., ((), ()), ((), ()), None)]
    for group in groups:
        count = sum(note['hand'] is None for note in group)
        states = sorted((step(state, group, cut) for state in states for cut in range(count + 1)),
                        key=lambda state: state[0])
        unique, seen = [], set()
        for state in states:
            signature = (state[1], tuple(tuple(midi for _, midi, _ in hand) for hand in state[2]))
            if signature not in seen:
                seen.add(signature); unique.append(state)
            if len(unique) == BEAM: break
        states = unique
    cuts, trail = [], states[0][3]
    while trail is not None:
        trail, cut = trail
        cuts.append(cut)
    for group, cut in zip(groups, reversed(cuts)):
        free = sorted((note for note in group if note['hand'] is None), key=lambda note: note['midi'])
        for index, note in enumerate(free):
            note['hand'] = 0 if index < cut else 1


def hand_of(piece, note):
    return note['hand']


def lesson_tracks(piece):
    tracks = []
    for hand in (0, 1):
        selected = [dict(midi=note['midi'], time=note['time'], end=note['end'], velocity=note['velocity'],
                         hand=hand) for note in piece['notes'] if hand_of(piece, note) == hand]
        selected.sort(key=lambda note: (note['time'], note['midi']))
        sources = {note['source'] for note in piece['notes'] if hand_of(piece, note) == hand}
        tracks.append(dict(id=hand, name='Sol el' if hand == 0 else 'Sağ el', notes=selected,
                           pedals=_pedals(piece, sources)))
    return tracks


def _pedals(piece, sources):
    seconds_of = clock(piece)
    events = sorted((tick, source, value) for source in sources for tick, value in piece['pedals'][source])
    values = {source: 0. for source in sources}
    combined = []
    for tick, source, value in events:
        values[source] = value
        level, time = max(values.values()), seconds_of(tick)
        if combined and combined[-1]['time'] == time: combined[-1]['value'] = level
        elif not combined or level != combined[-1]['value']: combined.append(dict(time=time, value=level))
    return combined


# ---- Rhythm ----------------------------------------------------------------------------

def _grid(points):
    """The simplest subdivision of a quarter that fits these positions within a beat."""
    if not points:
        return 4
    for grid in GRIDS:
        if max(abs(point - round(point * grid) / grid) for point in points) <= .02:
            return grid
    return min(GRIDS[:7], key=lambda grid: sum((point - round(point * grid) / grid) ** 2 for point in points)
               * (1 + .15 * GRIDS.index(grid)))


def _quantize(piece):
    """Every note's onset and end in quarter notes, on its own track's grid for that beat."""
    resolution = piece['resolution']
    position = lambda tick: tick / resolution
    beats = defaultdict(list)
    for note in piece['notes']:
        at = position(note['on_tick'])
        beats[note['source'], int(at)].append(at - int(at))
    grids = {key: _grid(points) for key, points in beats.items()}

    def snap(at, grid):
        beat = int(at)
        return beat + Fraction(round((at - beat) * grid), grid)
    events = []
    for note in piece['notes']:
        at, until = position(note['on_tick']), position(note['off_tick'])
        onset_grid = grids[note['source'], int(at)]
        onset = snap(at, onset_grid)
        end_grid = grids.get((note['source'], int(until)), _grid([until - int(until)]))
        end = snap(until, end_grid)
        if end <= onset:
            end = onset + Fraction(1, onset_grid)
        events.append(dict(note=note, on=onset, end=end))
    triplet_beats = {beat for (source, beat), grid in grids.items() if grid in TERNARY}
    return events, triplet_beats


def _voices(events):
    """Voices, as a score has them. Notes of one track that start and end together form a
    chord; each chord, highest first, continues the free voice nearest in pitch, preferring
    its own track's. A line that a file splits across tracks (a staff per track, with the
    accompaniment crossing staves) stays one voice; a melody over its accompaniment stays two."""
    chords = defaultdict(list)
    for event in events:
        chords[event['note']['source'], event['on'], event['end']].append(event)
    # Ends a hair apart in a played chord still make one chord.
    merged = {}
    for (source, onset, end), chord in sorted(chords.items()):
        target = next((key for key in merged if key[:2] == (source, onset) and abs(key[2] - end) <= Fraction(1, 8)), None)
        merged.setdefault(target or (source, onset, end), []).extend(chord)
    for (source, onset, end), chord in merged.items():
        for event in chord: event['end'] = max(event['end'] for event in chord)
    # A track whose chords never overlap is itself one voice (a melody, an accompaniment);
    # it is kept apart. Tracks that hold several voices (a staff per track) share one pool.
    spans = defaultdict(list)
    for (source, onset, _), chord in merged.items():
        spans[source].append((onset, chord[0]['end']))
    def overlapping(items):
        items = sorted(items)
        return sum(1 for (a, b), (c, d) in zip(items, items[1:]) if c < b)
    single = {source for source, items in spans.items() if overlapping(items) <= len(items) * .02}
    voices = []

    def distance(voice, chord):
        # A voice goes on without a pause, near in pitch, in its own track and note values;
        # an arpeggio's leaps cost less than a pause, and a melody may change note values.
        return (abs(voice['pitch'] - chord['pitch']) / 2 + 2 * (voice['source'] != chord['source'])
                + min(3, 4 * abs(log2(chord['length'] / voice['length'])))
                + 6 * min(1, float(chord['onset'] - voice['end'])))

    def assign(chords, free, new_voice):
        """The cheapest way for the chords struck together to continue the free voices,
        each voice taking one chord; a chord may also start a new voice."""
        best = [float('inf'), None]
        options = [sorted([(distance(voice, chord), voice['id']) for voice in free] + [(new_voice, None)],
                          key=lambda option: (option[0], option[1] is None, option[1] or 0))
                   for chord in chords]

        def search(index, total, taken, choice):
            if total >= best[0]: return
            if index == len(chords):
                best[:] = [total, list(choice)]; return
            for value, voice in options[index]:
                if voice is None or voice not in taken:
                    search(index + 1, total + value, taken | ({voice} - {None}), choice + [voice])
        if len(chords) * max(1, len(free)) <= 64:
            search(0, 0, frozenset(), [])
            return best[1]
        choice, taken = [], set()
        for option in options:
            value, voice = next((value, voice) for value, voice in option if voice is None or voice not in taken)
            choice.append(voice); taken.add(voice)
        return choice
    by_onset = defaultdict(list)
    for (source, onset, _), chord in merged.items():
        by_onset[onset].append(dict(source=source, onset=onset, events=chord, end=chord[0]['end'],
                                    length=float(chord[0]['end'] - onset),
                                    pitch=sum(event['note']['midi'] for event in chord) / len(chord)))
    for onset in sorted(by_onset):
        chords = sorted(by_onset[onset], key=lambda chord: -max(event['note']['midi'] for event in chord['events']))
        pools = defaultdict(list)
        for chord in chords:
            pools[chord['source'] if chord['source'] in single else 'shared'].append(chord)
        for pool, members in pools.items():
            free = [voice for voice in voices if voice['end'] <= onset and voice['pool'] == pool]
            # A one-voice track opens a second voice only where its notes overlap.
            choice = assign(members, free, NEW_VOICE if pool == 'shared' else 1000)
            for chord, voice_id in zip(members, choice):
                if voice_id is None:
                    voice = dict(id=len(voices), events=[], pool=pool); voices.append(voice)
                else:
                    voice = voices[voice_id]
                voice.update(end=chord['end'], pitch=chord['pitch'], source=chord['source'], length=chord['length'])
                voice['events'].append(chord['events'])
                for event in chord['events']: event['voice'] = voice['id']
    # A voice that rests for a moment before its next chord is a slightly short note
    # in a played file, not a written rest.
    for voice in voices:
        for chord, following in zip(voice['events'], voice['events'][1:]):
            onset, end, next_onset = chord[0]['on'], chord[0]['end'], following[0]['on']
            if 0 < next_onset - end <= (end - onset) / 4:
                for event in chord: event['end'] = next_onset


def _bars(piece, finish):
    """Bars in quarter notes from the file's time signatures, up to the last note's end."""
    resolution = piece['resolution']
    meters = [(Fraction(tick, resolution), numerator, denominator) for tick, numerator, denominator in piece['meters']]
    bars, position, index = [], Fraction(0), 0
    while position < finish:
        while index + 1 < len(meters) and meters[index + 1][0] <= position: index += 1
        _, numerator, denominator = meters[index]
        length = Fraction(4 * numerator, denominator)
        if index + 1 < len(meters) and position < meters[index + 1][0] < position + length:
            length = meters[index + 1][0] - position
        bars.append(dict(quarter=position, quarters=length, beats=numerator, beatType=denominator))
        position += length
    return bars


# ---- Key and spelling ------------------------------------------------------------------

MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
SHARPS_OF_MAJOR = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1}


def _key_sharps(name):
    tonic = name[:-1] if name.endswith('m') else name
    letter, accidental = tonic[0].upper(), tonic[1:]
    fifths = LETTERS[letter][1] + 7 * (accidental.count('#') - accidental.count('b'))
    return fifths - 3 if name.endswith('m') else fifths


def _estimated_sharps(events):
    """Krumhansl–Kessler key of the whole piece, when the file names none."""
    weights = [0.] * 12
    for event in events:
        weights[event['note']['midi'] % 12] += float(event['end'] - event['on'])

    def correlation(profile, tonic):
        rotated = profile[-tonic:] + profile[:-tonic]
        mean_a, mean_b = sum(weights) / 12, sum(rotated) / 12
        top = sum((a - mean_a) * (b - mean_b) for a, b in zip(weights, rotated))
        bottom = (sum((a - mean_a) ** 2 for a in weights) * sum((b - mean_b) ** 2 for b in rotated)) ** .5
        return top / bottom if bottom else 0
    best = max(((correlation(MAJOR, tonic), tonic, True) for tonic in range(12)),
               default=(0, 0, True))
    minor = max((correlation(MINOR, tonic), tonic, False) for tonic in range(12))
    _, tonic, major = max(best, minor)
    return SHARPS_OF_MAJOR[tonic if major else (tonic + 3) % 12]


def _spell(events, bars, sharps_at):
    """Choose each note's letter: close to the key and to the harmony around it, without
    augmented or diminished intervals against the notes it sounds with or moves to."""
    def candidates(midi):
        options = []
        for letter, (pitch_class, _) in LETTERS.items():
            alter = (midi % 12 - pitch_class + 6) % 12 - 6
            if abs(alter) <= 2: options.append(Pitch(letter, alter, midi))
        return options
    ordered = sorted(events, key=lambda event: (event['on'], event['note']['midi']))
    starts = [bar['quarter'] for bar in bars]
    bar_of = lambda at: max(0, bisect_right(starts, at) - 1)
    for event in ordered:
        event['options'] = candidates(event['note']['midi'])
        center = sharps_at(event['on']) + 2
        event['pitch'] = min(event['options'], key=lambda pitch: (abs(pitch.fifths - center), -pitch.fifths * (
            1 if center >= 2 else -1)))
        event['bar'] = bar_of(event['on'])
    # Who sounds together, and who comes next in the same voice.
    by_bar = defaultdict(list)
    for event in ordered: by_bar[event['bar']].append(event)
    for index, event in enumerate(ordered):
        event['together'] = [other for other in by_bar[event['bar']] + by_bar[event['bar'] - 1]
                             if other is not event and other['on'] <= event['on'] < other['end']]
    lines = defaultdict(list)
    for event in ordered: lines[event['note']['source'], event['voice']].append(event)
    for line in lines.values():
        onsets = sorted({event['on'] for event in line})
        by_onset = defaultdict(list)
        for event in line: by_onset[event['on']].append(event)
        for position, onset in enumerate(onsets):
            for event in by_onset[onset]:
                near = lambda group: [min(group, key=lambda other: abs(other['note']['midi'] - event['note']['midi']))]
                event['moves'] = (near(by_onset[onsets[position - 1]]) if position else []) + \
                                 (near(by_onset[onsets[position + 1]]) if position + 1 < len(onsets) else [])

    def cost(event, pitch):
        neighbours = [other for bar in (event['bar'] - 1, event['bar'], event['bar'] + 1) for other in by_bar[bar]]
        weight = sum(float(other['end'] - other['on']) for other in neighbours) or 1
        local = sum(other['pitch'].fifths * float(other['end'] - other['on']) for other in neighbours) / weight
        center = .4 * (sharps_at(event['on']) + 2) + .6 * local
        value = max(0, abs(pitch.fifths - center) - 3) * 2 + 1.5 * (abs(pitch.alter) == 2)
        value += 3 * sum(abs(pitch.fifths - other['pitch'].fifths) > 6 for other in event['together'])
        value += 2 * sum(abs(pitch.fifths - other['pitch'].fifths) > 6 for other in event['moves'])
        return value
    for _ in range(4):
        changed = False
        for event in ordered:
            best = min(event['options'], key=lambda pitch: (cost(event, pitch), pitch is not event['pitch']))
            if best is not event['pitch']:
                event['pitch'] = best; changed = True
        if not changed: break
    # Notes struck together on one pitch are written alike.
    unison = defaultdict(list)
    for event in ordered: unison[event['on'], event['note']['midi']].append(event)
    for group in unison.values():
        common = Counter(event['pitch'].text() for event in group).most_common(1)[0][0]
        for event in group:
            event['pitch'] = next(pitch for pitch in event['options'] if pitch.text() == common)


# ---- Staves ----------------------------------------------------------------------------

# Staff lines as diatonic steps (octave * 7 + letter): treble E4..F5, bass G2..A3.
CLEF_LINES = {'G2': (30, 38), 'F4': (18, 26)}
STAFF_LINES = ('PR', 'PL')
SWITCH = 3          # a change of staff costs as much as three ledger lines
OTHER_HAND = .5     # per note written on the other hand's staff


def _ledger_lines(step, clef):
    bottom, top = CLEF_LINES[clef]
    return (bottom - step) // 2 if step < bottom else (step - top) // 2 if step > top else 0


def _staves(events, clef_of):
    """Each voice beat by beat on the staff that needs the fewest ledger lines, leaning to its
    hand's staff and changing staff only when that saves more than the change costs. An
    accompaniment that dips low for a beat crosses to the bass staff, as editions write it;
    a hand that stays low for bars keeps its staff, which takes a bass clef (clef_of)."""
    lines = defaultdict(lambda: defaultdict(list))
    for event in events:
        lines[event['voice']][int(event['on'])].append(event)
    for beats in lines.values():
        order = sorted(beats)
        costs = []
        for beat in order:
            costs.append({staff: sum(_ledger_lines(event['pitch'].diatonic, clef_of(staff, event['bar']))
                                     + OTHER_HAND * (event['hand'] != (1 if staff == 'PR' else 0))
                                     for event in beats[beat]) for staff in STAFF_LINES})
        best = [dict(costs[0])]
        back = [{}]
        for cost in costs[1:]:
            step, links = {}, {}
            for staff in STAFF_LINES:
                prior = min(STAFF_LINES, key=lambda other: best[-1][other] + (SWITCH if other != staff else 0))
                step[staff] = best[-1][prior] + (SWITCH if prior != staff else 0) + cost[staff]
                links[staff] = prior
            best.append(step); back.append(links)
        staff = min(STAFF_LINES, key=lambda name: best[-1][name])
        for index in range(len(order) - 1, -1, -1):
            for event in beats[order[index]]: event['staff'] = staff
            if index: staff = back[index][staff]


# ---- Score -----------------------------------------------------------------------------

def notation(piece, title):
    from notation import _clef_plan
    from score_writer import write_score
    events, triplet_beats = _quantize(piece)
    for event in events: event['hand'] = hand_of(piece, event['note'])
    _voices(events)
    finish = max(event['end'] for event in events)
    bars = _bars(piece, finish)
    resolution = piece['resolution']
    key_changes = [(Fraction(tick, resolution), _key_sharps(name)) for tick, name in piece['keys']]
    if not key_changes:
        key_changes = [(Fraction(0), _estimated_sharps(events))]
    key_starts = [at for at, _ in key_changes]

    def sharps_at(at):
        return key_changes[max(0, bisect_right(key_starts, at) - 1)][1]
    _spell(events, bars, sharps_at)
    seconds_of = clock(piece)
    tempo_ticks = [tick for tick, _ in piece['tempos']]
    score_bars, measures = [], []
    for bar in bars:
        begin, length = bar['quarter'], bar['quarters']
        score_bars.append(dict(metric=begin / 4, length=length / 4, beats=bar['beats'], beatType=bar['beatType'],
                               key=sharps_at(begin),
                               # Quarter beats, counted from the bar's start, whose notes are triplets.
                               tripletBeats=[beat - begin for beat in range(int(begin), int(begin + length) + 1)
                                             if beat in triplet_beats and begin <= beat < begin + length]))
        start_tick, end_tick = begin * resolution, (begin + length) * resolution
        anchors = [(0., seconds_of(float(start_tick)))]
        anchors += [(float(Fraction(tick, resolution) - begin), seconds_of(tick)) for tick in tempo_ticks
                    if start_tick < tick < end_tick]
        anchors.append((float(length), seconds_of(float(end_tick))))
        measures.append(dict(start=anchors[0][1], end=anchors[-1][1], quarter=float(begin), length=float(length),
                             anchors=[list(anchor) for anchor in anchors]))
    # A bar where nearly all of a hand's notes lie on the other side of middle C gives that
    # hand's staff the other clef (the right hand low in the bass clef, as editions write it);
    # voices then cross staves where that reads better; the clefs are settled afterwards for
    # what each staff holds.
    sides = defaultdict(lambda: [0, 0])
    for event in events:
        sides[event['bar'], event['hand']][event['note']['midi'] >= MIDDLE_C] += 1
    def hand_clef(staff, bar):
        hand = 1 if staff == 'PR' else 0
        low, high = sides[bar, hand]
        if hand == 1: return 'F4' if low >= 3 * high and low else 'G2'
        return 'G2' if high >= 3 * low and high else 'F4'
    _staves(events, hand_clef)
    physical = [dict(on=event['on'] / 4, end=event['end'] / 4, pitch=event['pitch'], hand=event['staff'],
                     voice=event['voice'], time=event['note']['time']) for event in events]
    clefs = {staff: _clef_plan(score_bars, physical, staff) for staff in ('PR', 'PL')}
    opening = [value for tick, value in piece['tempos'] if tick < (bars[min(len(bars), 4) - 1]['quarter']
                                                                   + bars[min(len(bars), 4) - 1]['quarters']) * resolution]
    bpm = round(60e6 / median(opening or [piece['tempos'][0][1]]))
    words = next((word for word in piece['words'] if TEMPO_WORDS.search(word) and len(word) <= 40), None)
    musicxml = write_score(score_bars, physical, clefs, title, bpm, [], [], tempo_text=words)
    return dict(musicxml=musicxml, measures=measures, source='MIDI ritim verisi',
                tempo=dict(quarterBpm=bpm, text=words), engraving=dict(engine='music21', version='9.9.1'))
