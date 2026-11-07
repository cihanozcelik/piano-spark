"""Recover explicit raw staff context lost by Rubato's onset cleanup.

The pinned scanner may remove a staff marker next to a tombstoned duplicate
onset. Later notes inherit the wrong staff. This module compares the original
staff context with surviving scanner onsets, without changing the parser,
source text, source durations, or accepted lesson performance.
"""
from collections import defaultdict
from fractions import Fraction
import hashlib
import re

_STAFF = re.compile(r'^([A-Za-z][A-Za-z0-9]*):')
_FENCES = re.compile(r'<\|.*?\|>')
_INTERVAL = re.compile(r'(?:(\d+)(?:/(\d+))?|/(\d+))$')


def _raw_contexts(text, unit):
    from rubato.convert._scan import _onset_info
    contexts = defaultdict(set)
    staff = None
    clock = 0
    started = False

    def advance(token):
        match = _INTERVAL.fullmatch(token)
        if match is None:
            return None
        numerator = int(match[1] or 1)
        denominator = int(match[2] or match[3] or 1)
        if denominator == 0 or denominator > 128:
            return 0
        ticks = numerator * (unit // denominator)
        return ticks if ticks <= 16 * unit else 0

    for word in text.split():
        token = _FENCES.sub('', word)
        if not token:
            continue
        marker = _STAFF.match(token)
        if marker:
            staff = marker[1]
            token = token[marker.end():]
            if not token:
                continue
        if token.startswith('|'):
            started = True
        elif token[0] in 'ABCDEFG' and ';' not in token:
            _, fused, _, junk, midi, _ = _onset_info(token)
            if junk or midi is None:
                continue
            started = True
            if staff in ('PL', 'PR'):
                contexts[(clock, midi)].add(staff)
            if fused:
                amount = advance(fused)
                if amount is None:
                    return {}, 'unsupported fused interval'
                clock += amount
        elif token[0].isdigit() or token[0] == '/':
            if not started:
                continue  # The pinned scanner discards leading intervals.
            amount = advance(token)
            if amount is None:
                return {}, 'unsupported interval token'
            clock += amount
    return contexts, None


def source_staff_repairs(raw_text, score):
    """Return (repairs, audit), limited to exact, unambiguous source evidence.

    Repair records have local-window seconds, MIDI pitch, fromStaff and toStaff.
    Consumers may use them for notation staff placement; lesson hand assignments
    and physical timing are deliberately not changed here.
    """
    from rubato.convert._scan import scan
    from rubato.convert._model import pitch_midi
    from rubato.convert.midi import TimeMap, score_notes

    tokens, _, _, unit = scan(raw_text)
    contexts, unsupported = _raw_contexts(raw_text, unit)
    audit = dict(method='Raw explicit staff context matched to surviving onset clock and pitch',
                 rawSHA256=hashlib.sha256(raw_text.encode()).hexdigest(),
                 ambiguousOnsets=sum(len(staves) != 1 for staves in contexts.values()),
                 recoveredStaffAssignments=0, lessonPerformanceChanged=False)
    if unsupported:
        audit['unresolved'] = unsupported
        return [], audit
    physical = {(round(on, 6), pitch, staff) for on, off, pitch, staff in score_notes(score)}
    timing = TimeMap(score)
    clock, staff = 0, None
    repairs = []
    seen = set()
    for kind, value in tokens:
        if kind == 'D':
            clock += value
        elif kind == 'M':
            staff = value
        elif kind == 'N':
            pitch = pitch_midi(value)
            source = contexts.get((clock, pitch), set())
            if len(source) != 1 or staff not in ('PL', 'PR'):
                continue
            intended = next(iter(source))
            if intended == staff:
                continue
            seconds = timing(Fraction(clock, unit))
            identity = (round(seconds, 6), pitch, staff)
            if identity not in physical or identity in seen:
                continue
            seen.add(identity)
            repairs.append(dict(time=seconds, pitch=pitch, fromStaff=staff, toStaff=intended))
    audit['recoveredStaffAssignments'] = len(repairs)
    return repairs, audit
