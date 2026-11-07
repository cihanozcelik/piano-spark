// The lesson clock advances only through correctly played score intervals.
// Pedal/soundEnd is separate; timed profiles assess physical key holds.
export class PracticeClock {
  // Seconds in real time. Matching, grading and UI all use these profiles.
  static timingProfiles = {
    off: Object.freeze({id:'off',enabled:false,early:0,late:0,release:0}),
    easy: Object.freeze({id:'easy',enabled:true,early:.5,late:1,release:.4}),
    normal: Object.freeze({id:'normal',enabled:true,early:.3,late:.5,release:.2}),
    hard: Object.freeze({id:'hard',enabled:true,early:.15,late:.2,release:.1}),
  };

  static timingProfile(id) {
    return PracticeClock.timingProfiles[id];
  }

  constructor() {
    this.events = [];
    this.time = -2;
    this.speed = 1;
    this.lastWall = 0;
    this.expected = new Map();
    this.pending = new Map();
    this.usedAttacks = new Map();
    this.seenAttacks = new Map();
    this.unexpectedAttacks = new Map();
    this.eligibleAttacks = new Map();
    this.releasedAt = new Map();
    this.next = 0;
    this.setTiming('hard');
    this.status = { blocked: false, missing: [], extra: [], repeat: [] };
  }

  setTiming(id) {
    this.timing = PracticeClock.timingProfile(id);
    this.earlySeconds = this.timing.early;
    this.releaseSeconds = this.timing.release;
  }

  load(notes, time, now, input) {
    const boundaries = new Map();
    const boundary = time => {
      const key = Math.round(time * 1000000);
      if (!boundaries.has(key)) boundaries.set(key, { time: key / 1000000, starts: [], ends: [] });
      return boundaries.get(key);
    };
    for (const note of notes) {
      boundary(note.time).starts.push(note.midi);
      boundary(note.end).ends.push(note.midi);
    }
    this.events = [...boundaries.values()].sort((a, b) => a.time - b.time);
    this.seek(time, now, input);
  }

  seek(time, now, input) {
    this.time = time;
    this.lastWall = now;
    this.next = 0;
    this.expected.clear();
    this.pending.clear();
    this.usedAttacks = new Map([...input.attacks].map(([note, attack]) => [note, attack.serial]));
    this.seenAttacks = new Map(this.usedAttacks);
    this.unexpectedAttacks.clear();
    this.eligibleAttacks.clear();
    this.releasedAt.clear();
    while (this.next < this.events.length && this.events[this.next].time <= time) {
      this.enter(this.events[this.next++]);
    }
    for (const note of this.expected.keys()) this.pending.set(note, true);
    this.reconcile(input);
  }

  resume(now) { this.lastWall = now; }

  enter(event) {
    for (const note of event.ends) {
      const count = this.expected.get(note) - 1;
      if (count > 0) this.expected.set(note, count);
      else {
        if (!this.pending.has(note)) this.releasedAt.set(note, event.time);
        this.expected.delete(note); this.pending.delete(note);
      }
    }
    for (const note of event.starts) {
      const count = this.expected.get(note) || 0;
      this.expected.set(note, count + 1);
      if (count === 0) this.pending.set(note, true);
    }
  }

  reconcile(input) {
    const early = new Set();
    const releasing = new Set();
    const releaseHorizon = this.time + this.releaseSeconds * this.speed;
    const remainingHolds = new Map(this.expected);
    for (let i = this.next; i < this.events.length && this.events[i].time <= releaseHorizon; i++) {
      const event = this.events[i];
      for (const note of event.ends) {
        const count = (remainingHolds.get(note) || 0) - 1;
        remainingHolds.set(note, count);
        if (count === 0 && this.expected.has(note)) releasing.add(note);
      }
      for (const note of event.starts) remainingHolds.set(note, (remainingHolds.get(note) || 0) + 1);
    }
    for (const [note, ended] of this.releasedAt) {
      if (this.timing.enabled ? this.time >= ended + this.releaseSeconds * this.speed : !input.held.has(note)) {
        this.releasedAt.delete(note);
      }
    }
    const horizon = this.time + this.earlySeconds * this.speed;
    if (this.timing.enabled) {
      for (let i = this.next; i < this.events.length && this.events[i].time <= horizon; i++) {
        for (const note of this.events[i].starts) early.add(note);
      }
    } else if (!this.pending.size) {
      // Timing off accepts the next onset group at any time, not every future
      // pitch in the piece. Unplayed current chord notes still have to be played.
      for (let i = this.next; i < this.events.length; i++) {
        if (!this.events[i].starts.length) continue;
        for (const note of this.events[i].starts) early.add(note);
        break;
      }
    }
    // Capture early attacks when they arrive, in lesson time. A wait for another
    // chord key must not age out a correctly played early note.
    for (const [note, attack] of input.attacks) {
      if (this.seenAttacks.get(note) === attack.serial) continue;
      this.seenAttacks.set(note, attack.serial);
      // A fresh attack must satisfy an onset, not simply hit a pitch that is
      // already supposed to be held. Retain its serial across reconciliations.
      if (input.held.has(note) && !this.pending.has(note) && !early.has(note)) {
        this.unexpectedAttacks.set(note, attack.serial);
      }
      if (input.held.has(note) && (this.expected.has(note) || early.has(note))) {
        this.eligibleAttacks.set(note, attack.serial);
      }
    }
    for (const note of this.pending.keys()) {
      const attack = input.attacks.get(note);
      if ((!this.timing.enabled || input.held.has(note)) && attack && this.eligibleAttacks.get(note) === attack.serial &&
          attack.serial > (this.usedAttacks.get(note) || 0)) {
        this.pending.delete(note);
        this.usedAttacks.set(note, attack.serial);
      }
    }
    // A re-press near the end may belong to the upcoming repeated note.
    // Earlier repairs still belong to the current hold.
    for (const note of this.expected.keys()) {
      const attack = input.attacks.get(note);
      if (input.held.has(note) && !this.pending.has(note) && attack &&
          !((!this.timing.enabled || releasing.has(note)) && early.has(note))) {
        this.usedAttacks.set(note, attack.serial);
      }
    }
    const missing = [...this.expected.keys()].filter(note => !input.held.has(note) &&
      (this.pending.has(note) || (this.timing.enabled && !releasing.has(note))));
    const extra = [...input.held].filter(note => !this.expected.has(note) && !early.has(note) &&
      !this.releasedAt.has(note));
    const repeat = [...this.pending.keys()].filter(note => input.held.has(note));
    this.status = {
      connected: input.connected, missing, extra, repeat,
      blocked: !input.connected || missing.length > 0 || extra.length > 0 || repeat.length > 0,
    };
    return this.status;
  }

  advance(now, input, end = Infinity) {
    let remaining = Math.min(Math.max(0, end - this.time), Math.max(0, now - this.lastWall) * this.speed);
    this.lastWall = now;
    if (this.reconcile(input).blocked) return this.time;
    while (remaining > 0) {
      const event = this.events[this.next];
      let boundary = event ? event.time : Infinity;
      // Stop exactly at release allowance expiry, even after a delayed frame.
      if (this.timing.enabled) {
        for (const ended of this.releasedAt.values()) {
          boundary = Math.min(boundary, ended + this.releaseSeconds * this.speed);
        }
      }
      if (boundary > this.time + remaining) break;
      remaining -= boundary - this.time;
      this.time = boundary;
      if (event && event.time === boundary) { this.next++; this.enter(event); }
      if (this.reconcile(input).blocked) return this.time;
    }
    this.time += remaining;
    this.reconcile(input);
    return this.time;
  }
}
