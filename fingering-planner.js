/**
 * Offline, bounded beam search over published ergonomic fingering costs.
 * See docs/fingering-method.md for sources, extensions and limitations.
 * The worker owns planning; the player owns notes and playback time.
 */
export class FingeringPlanner {
  constructor({ onProgress = () => {} } = {}) {
    this.onProgress = onProgress;
    this.worker = null;
    this.workerUrl = null;
    this.pending = null;
    this.disposed = false;
  }

  async plan(notes, { handSize = 'medium' } = {}) {
    if (this.disposed) throw new Error('The fingering planner has been disposed.');
    this.cancel();
    const url = URL.createObjectURL(new Blob([
      `(${fingeringWorker.toString()})();`,
    ], { type: 'text/javascript' }));
    let worker;
    try {
      worker = new Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    this.worker = worker;
    this.workerUrl = url;
    return new Promise((resolve, reject) => {
      this.pending = { reject };
      const finish = (callback, value) => {
        if (this.worker !== worker) return;
        this.worker = null;
        this.workerUrl = null;
        this.pending = null;
        worker.terminate();
        URL.revokeObjectURL(url);
        callback(value);
      };
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.type === 'progress') this.onProgress(data.value);
        else if (data.type === 'result') finish(resolve, data.value);
        else if (data.type === 'error') finish(reject, new Error(data.message));
      };
      worker.onerror = event => finish(reject, new Error(event.message || 'Fingering planning failed.'));
      worker.onmessageerror = () => finish(reject, new Error('The fingering worker could not decode its result.'));
      try {
        worker.postMessage({ notes, handSize });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  cancel() {
    this.worker?.terminate();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.worker = null;
    this.workerUrl = null;
    this.pending?.reject(new DOMException('Fingering planning was cancelled.', 'AbortError'));
    this.pending = null;
  }

  dispose() {
    this.cancel();
    this.disposed = true;
  }
}

// Keep this function self-contained: it is serialized into the worker's Blob.
function fingeringWorker() {
  const SOURCES = [
    'https://static.uni-graz.at/fileadmin/_Persoenliche_Webseite/parncutt_richard/Pdfs/PaSlClRaDe97_FingeringModel.pdf',
    'https://www.dorienherremans.com/sites/default/files/ITOR_VNS_APF_preprint.pdf',
    'https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/fingering/',
  ];
  // Parncutt et al. (1997), Table 1, in semitones:
  // MinPrac, MinComf, MinRel, MaxRel, MaxComf, MaxPrac.
  const SPANS = {
    12: [-5, -3, 1, 5, 8, 10],
    13: [-4, -2, 3, 7, 10, 12],
    14: [-3, -1, 5, 9, 12, 14],
    15: [-1, 1, 7, 10, 13, 15],
    23: [1, 1, 1, 2, 3, 5],
    24: [1, 1, 3, 4, 5, 7],
    25: [2, 2, 5, 6, 8, 10],
    34: [1, 1, 1, 2, 2, 4],
    35: [1, 1, 3, 4, 5, 7],
    45: [1, 1, 1, 2, 3, 5],
  };
  const KEY_X = [0, .5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const SIZE = { small: .9, medium: 1, large: 1.1 };
  const BEAM_WIDTH = 64;
  const REST_BREAK = .35;
  const scaledSpans = new Map();

  const physicalX = midi => Math.floor(midi / 12) * 7 + KEY_X[midi % 12];
  const outside = (value, min, max) => Math.max(0, min - value, value - max);

  function bounds(a, b, scale) {
    const key = `${scale}:${a}:${b}`;
    if (scaledSpans.has(key)) return scaledSpans.get(key);
    if (a === b) {
      const zero = [0, 0, 0, 0, 0, 0];
      scaledSpans.set(key, zero);
      return zero;
    }
    const values = SPANS[Math.min(a, b) * 10 + Math.max(a, b)];
    const result = a < b ? values.map(v => v * scale) : values.slice().reverse().map(v => -v * scale);
    scaledSpans.set(key, result);
    return result;
  }

  function spanCost(a, b, scale, chord = false) {
    const d = b.pitch - a.pitch;
    const limits = bounds(a.finger, b.finger, scale);
    const weight = a.finger === 1 || b.finger === 1 ? 1 : 2;
    // Rules 1–3. Normalize finger direction for the small/large span rules.
    const ordered = a.finger <= b.finger ? d : -d;
    const sorted = a.finger <= b.finger ? limits : bounds(b.finger, a.finger, scale);
    const stretch = 2 * outside(d, limits[1], limits[4]);
    const small = weight * Math.max(0, sorted[2] - ordered);
    const large = weight * Math.max(0, ordered - sorted[3]);
    // Balliauw et al. rule 14 doubles stretch/small-span costs inside chords.
    if (chord) return 2 * (stretch + small);
    // Balliauw rule 13 permits detached transitions beyond practical legato
    // spans with a cost, never beyond a simultaneous contact's hard reach.
    return stretch + small + large + 10 * outside(d, limits[0], limits[5]);
  }

  function unaryCost(note) {
    return (note.finger >= 4 ? 1 : 0) + (note.finger === 1 && note.black ? 1 : 0);
  }

  function transitionCost(a, b, scale) {
    let cost = spanCost(a, b, scale);
    // Rules 8–11: direction-specific 3→4; white 3/black 4; short black-key
    // fingers beside white keys. Unary thumb-on-black is counted only once.
    if (a.finger === 3 && b.finger === 4) cost++;
    if ((a.finger === 3 && !a.black && b.finger === 4 && b.black) ||
        (b.finger === 3 && !b.black && a.finger === 4 && a.black)) cost++;
    if (a.black && (a.finger === 1 || a.finger === 5) && !b.black) cost += 2;
    if (b.black && (b.finger === 1 || b.finger === 5) && !a.black) cost += 2;
    // Rule 12: only a thumb-under / finger-over transition is a crossing.
    if ((b.pitch - a.pitch) * (b.finger - a.finger) < 0 &&
        (a.finger === 1 || b.finger === 1)) {
      if (a.black === b.black) cost++;
      else if ((a.finger === 1 && a.black) || (b.finger === 1 && b.black)) cost += 3;
    }
    return cost;
  }

  function tripleCost(a, b, c, scale) {
    const limits = bounds(a.finger, c.finger, scale);
    const d = c.pitch - a.pitch;
    const changedFingerOnRepeatedPitch = a.pitch === c.pitch && a.finger !== c.finger;
    const movement = changedFingerOnRepeatedPitch ? 0 : outside(d, limits[1], limits[4]);
    let cost = movement;
    // Rules 4–5, including the repeated outer pitch / changed finger case.
    if (movement > 0) {
      const middlePitch = (b.pitch - a.pitch) * (c.pitch - b.pitch) > 0;
      cost += b.finger === 1 && middlePitch && outside(d, limits[0], limits[5]) > 0 ? 2 : 1;
    } else if (changedFingerOnRepeatedPitch) cost++;
    // Rule 7: any ordering of three distinct fingers 3, 4, 5.
    if (a.finger >= 3 && b.finger >= 3 && c.finger >= 3 &&
        a.finger !== b.finger && b.finger !== c.finger && a.finger !== c.finger) cost++;
    return cost;
  }

  function compatible(a, b, scale) {
    if (a.finger === b.finger) return false;
    // Sustained contacts stay in natural finger order. Crossings are allowed
    // between released notes, not by pretending a held finger has lifted.
    if ((b.x - a.x) * (b.finger - a.finger) <= 0) return false;
    const lowFinger = Math.min(a.finger, b.finger);
    const highFinger = Math.max(a.finger, b.finger);
    const maxWhiteWidths = SPANS[lowFinger * 10 + highFinger][5] * scale * 7 / 12;
    return Math.abs(b.x - a.x) <= maxWhiteWidths + 1e-9;
  }

  function prepare(notes, hand, warnings) {
    const byPitch = new Map();
    for (const note of notes) {
      if (note.hand !== hand) continue;
      if (!byPitch.has(note.midi)) byPitch.set(note.midi, []);
      byPitch.get(note.midi).push(note);
    }
    const contacts = [];
    let mergedCount = 0;
    for (const [midi, pitchedNotes] of byPitch) {
      pitchedNotes.sort((a, b) => a.time - b.time || a.end - b.end || (a.finger || 0) - (b.finger || 0));
      let current = null;
      for (const note of pitchedNotes) {
        // Strict overlap only: a release followed by the same pitch is a new
        // strike, including an exact end/onset boundary.
        if (current && note.time < current.end) {
          current.end = Math.max(current.end, note.end);
          current.ids.push(note.sourceNoteId);
          if (note.finger) current.anchors.add(note.finger);
          mergedCount++;
        } else {
          current = {
            midi, pitch: hand === 0 ? -midi : midi,
            x: physicalX(midi) * (hand === 0 ? -1 : 1),
            black: BLACK.has(midi % 12), time: note.time, end: note.end,
            ids: [note.sourceNoteId], anchors: new Set(note.finger ? [note.finger] : []),
          };
          contacts.push(current);
        }
      }
    }
    contacts.sort((a, b) => a.time - b.time || a.x - b.x || a.end - b.end);
    contacts.forEach((note, index) => { note.index = index; });
    if (mergedCount) warnings.push({
      code: 'overlapping-unisons', hand, count: mergedCount,
      message: 'Overlapping notes on the same key share one held contact; repeated strikes inside that overlap are not inferred.',
    });
    const groups = [];
    for (const note of contacts) {
      let group = groups[groups.length - 1];
      if (!group || group.time !== note.time) {
        group = { time: note.time, notes: [] };
        groups.push(group);
      }
      group.notes.push(note);
    }
    return groups;
  }

  function expand(state, group, scale, emit) {
    const active = state.active.filter(n => n.end > group.time);
    if (active.length + group.notes.length > 5) return;
    const gap = state.last.length ? group.time - Math.max(...state.last.map(n => n.end)) : Infinity;
    const last = gap >= REST_BREAK ? [] : state.last;
    const older = gap >= REST_BREAK ? [] : state.older;
    const chosen = [];
    function visit(index, cost) {
      if (index === group.notes.length) {
        let transition = 0;
        for (const a of last) for (const b of chosen) transition += transitionCost(a, b, scale);
        // A chord is a simultaneous slice, never a fabricated fast melody.
        if (last.length) transition /= last.length * chosen.length;
        if (older.length === 1 && last.length === 1 && chosen.length === 1) {
          transition += tripleCost(older[0], last[0], chosen[0], scale);
        }
        const selected = chosen.slice();
        emit({
          cost: state.cost + cost + transition,
          active: [...active, ...selected].sort((a, b) => a.index - b.index),
          last: selected, older: last,
          path: { parent: state.path, notes: selected },
        });
        return;
      }
      const note = group.notes[index];
      if (note.anchors.size > 1) return;
      const fingers = note.anchors.size ? [...note.anchors] : [1, 2, 3, 4, 5];
      for (const finger of fingers) {
        const candidate = { ...note, finger };
        if (!active.every(other => compatible(candidate, other, scale)) ||
            !chosen.every(other => compatible(candidate, other, scale))) continue;
        let added = unaryCost(candidate);
        for (const other of chosen) added += spanCost(other, candidate, scale, true);
        for (const other of active) added += spanCost(other, candidate, scale, true);
        chosen.push(candidate);
        visit(index + 1, cost + added);
        chosen.pop();
      }
    }
    visit(0, 0);
  }

  function stateKey(state) {
    const encode = notes => notes.map(n => `${n.index}:${n.finger}`).join(',');
    return `${encode(state.active)}|${encode(state.last)}|${encode(state.older)}`;
  }

  function appendPath(path, hand, assignments) {
    const slices = [];
    for (let node = path; node; node = node.parent) slices.push(node.notes);
    for (let i = slices.length - 1; i >= 0; i--) {
      for (const note of slices[i]) for (const noteId of note.ids) {
        assignments.push({ noteId, hand, finger: note.finger });
      }
    }
  }

  function initialState() {
    return { cost: 0, active: [], last: [], older: [], path: null };
  }

  function maximumHeldCount(notes) {
    // Release precedes attack at equal times: adjacent notes are not overlap.
    const events = [];
    for (const note of notes) events.push([note.time, 1], [note.end, -1]);
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let held = 0;
    let maximum = 0;
    for (const [, change] of events) {
      held += change;
      maximum = Math.max(maximum, held);
    }
    return maximum;
  }

  function solveHand(groups, hand, scale, result, progress) {
    let beam = [initialState()];
    let blockStart = 0;
    let blockEnd = -Infinity;
    let beforeBlock = beam;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.time >= blockEnd) {
        blockStart = i;
        beforeBlock = beam;
      }
      for (const note of group.notes) blockEnd = Math.max(blockEnd, note.end);
      const unique = new Map();
      for (const state of beam) expand(state, group, scale, candidate => {
        const key = stateKey(candidate);
        const previous = unique.get(key);
        if (!previous || candidate.cost < previous.cost) unique.set(key, candidate);
      });
      if (unique.size) {
        beam = [...unique.values()].sort((a, b) => a.cost - b.cost).slice(0, BEAM_WIDTH);
        progress(group.notes.reduce((sum, n) => sum + n.ids.length, 0));
        continue;
      }

      // Reject the entire connected held-contact passage. Releasing a lock to
      // save a later note would make earlier output physically contradictory.
      appendPath(beforeBlock[0].path, hand, result.assignments);
      const failed = groups.slice(blockStart, i + 1).flatMap(g => g.notes);
      const failedGroup = group.notes;
      let skippedCount = failedGroup.reduce((sum, n) => sum + n.ids.length, 0);
      while (i + 1 < groups.length && groups[i + 1].time < blockEnd) {
        i++;
        failed.push(...groups[i].notes);
        for (const note of groups[i].notes) {
          blockEnd = Math.max(blockEnd, note.end);
          skippedCount += note.ids.length;
        }
      }
      const anchoredConflict = failed.some(n => n.anchors.size > 1);
      const tooMany = maximumHeldCount(failed) > 5;
      result.unresolved.push({
        noteIds: failed.flatMap(n => n.ids),
        reason: anchoredConflict ? 'conflicting-anchors' : tooMany ? 'more-than-five-held-keys' : 'no-feasible-plan-within-search',
        start: groups[blockStart].time, end: blockEnd, hand,
      });
      progress(skippedCount);
      beam = [initialState()];
      beforeBlock = beam;
      blockEnd = -Infinity;
    }
    appendPath(beam[0].path, hand, result.assignments);
  }

  self.onmessage = ({ data: { notes, handSize } }) => {
    try {
      if (!Object.hasOwn(SIZE, handSize)) throw new Error('Unknown fingering hand size.');
      const ids = new Set();
      for (const note of notes) {
        if (typeof note.sourceNoteId !== 'string' || !note.sourceNoteId || ids.has(note.sourceNoteId)) {
          throw new Error('Fingering notes require unique stable sourceNoteId strings.');
        }
        ids.add(note.sourceNoteId);
        if (!Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127 ||
            !Number.isFinite(note.time) || !Number.isFinite(note.end) || note.end <= note.time ||
            (note.hand !== 0 && note.hand !== 1) ||
            (note.finger !== undefined && (!Number.isInteger(note.finger) || note.finger < 1 || note.finger > 5))) {
          throw new Error('Fingering notes require MIDI pitch, physical onset/end times, hand 0/1 and optional finger 1–5.');
        }
      }
      const result = {
        version: 1,
        handSize,
        handScale: SIZE[handSize],
        method: { id: 'parncutt-constrained-beam', revision: 1, sources: SOURCES },
        assignments: [], unresolved: [], warnings: [],
      };
      let completed = 0;
      let lastProgress = -Infinity;
      const progress = count => {
        completed += count;
        const now = performance.now();
        if (now - lastProgress >= 60 || completed === notes.length) {
          lastProgress = now;
          self.postMessage({ type: 'progress', value: {
            phase: 'planning', completed, total: notes.length,
            progress: notes.length ? completed / notes.length : 1,
          } });
        }
      };
      progress(0);
      for (const hand of [0, 1]) solveHand(prepare(notes, hand, result.warnings), hand, SIZE[handSize], result, progress);
      const order = new Map(notes.map((note, index) => [note.sourceNoteId, index]));
      result.assignments.sort((a, b) => order.get(a.noteId) - order.get(b.noteId));
      if (result.unresolved.length) result.warnings.push({
        code: 'unresolved-passages', count: result.unresolved.length,
        message: 'Some passages have no solution within the selected reach/contact model and bounded search; no finger numbers were invented for them.',
      });
      self.postMessage({ type: 'result', value: result });
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
  };
}
