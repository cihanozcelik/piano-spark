// Adapts practice targets to a player's measured hand span. The lesson is never
// changed: callers receive copies, and only practice uses the optional flag.
// A chord wider than the span keeps its anchor (right hand: the highest note,
// usually the melody; left hand: the lowest note, the bass). Notes outside the
// reachable window from that anchor become optional: never required, always
// accepted when played, e.g. by rolling the chord.
export class HandReach {
  // Seconds between onsets that still form one chord.
  static chordWindow = .05;
  // Measured spans are semitones between the two outer keys of one hand.
  static minimum = 5;
  static maximum = 24;

  static hand(note) { return note.hand === 0 || note.hand === 1 ? note.hand : (note.midi < 60 ? 0 : 1); }

  static valid(reach) {
    return !!reach && [reach.left, reach.right].every(span =>
      Number.isInteger(span) && span >= HandReach.minimum && span <= HandReach.maximum);
  }

  // `notes` must be sorted by onset. Returns the same array when nothing changes.
  static adapt(notes, reach) {
    if (!HandReach.valid(reach)) return notes;
    const optional = new Set();
    for (const hand of [0, 1]) {
      const span = hand === 0 ? reach.left : reach.right;
      let chord = [];
      const settle = () => {
        if (chord.length > 1) {
          const pitches = chord.map(note => note.midi);
          const anchor = hand === 0 ? Math.min(...pitches) : Math.max(...pitches);
          for (const note of chord) if (Math.abs(note.midi - anchor) > span) optional.add(note);
        }
        chord = [];
      };
      for (const note of notes) {
        if (HandReach.hand(note) !== hand) continue;
        if (chord.length && note.time - chord[0].time > HandReach.chordWindow) settle();
        chord.push(note);
      }
      settle();
    }
    return optional.size ? notes.map(note => optional.has(note) ? {...note, optional: true} : note) : notes;
  }

  // The reach recorded from keys held by one hand, or null when it is not a span.
  static measure(held) {
    if (held.length < 2) return null;
    const span = Math.max(...held) - Math.min(...held);
    return span >= HandReach.minimum && span <= HandReach.maximum ? span : null;
  }
}
