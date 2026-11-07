// The lesson clock advances only through correctly played score intervals.
// Pedal/soundEnd is deliberately separate: exercises assess physical key holds.
export class PracticeClock {
  constructor() {
    this.events = [];
    this.time = -2;
    this.speed = 1;
    this.lastWall = 0;
    this.expected = new Map();
    this.pending = new Map();
    this.usedAttacks = new Map();
    this.seenAttacks = new Map();
    this.eligibleAttacks = new Map();
    this.releasedAt = new Map();
    this.next = 0;
    this.earlySeconds = .15;
    // Real-time allowance around key releases, scaled into lesson time.
    this.releaseSeconds = .10;
    this.status = { blocked: false, missing: [], extra: [], repeat: [] };
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
      if (this.time >= ended + this.releaseSeconds * this.speed) this.releasedAt.delete(note);
    }
    const horizon = this.time + this.earlySeconds * this.speed;
    for (let i = this.next; i < this.events.length && this.events[i].time <= horizon; i++) {
      for (const note of this.events[i].starts) early.add(note);
    }
    // Capture early attacks when they arrive, in lesson time. A wait for another
    // chord key must not age out a correctly played early note.
    for (const [note, attack] of input.attacks) {
      if (this.seenAttacks.get(note) === attack.serial) continue;
      this.seenAttacks.set(note, attack.serial);
      if (input.held.has(note) && (this.expected.has(note) || early.has(note))) {
        this.eligibleAttacks.set(note, attack.serial);
      }
    }
    for (const note of this.pending.keys()) {
      const attack = input.attacks.get(note);
      if (input.held.has(note) && attack && this.eligibleAttacks.get(note) === attack.serial &&
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
          !(releasing.has(note) && early.has(note))) {
        this.usedAttacks.set(note, attack.serial);
      }
    }
    const missing = [...this.expected.keys()].filter(note => !input.held.has(note) &&
      (this.pending.has(note) || !releasing.has(note)));
    const extra = [...input.held].filter(note => !this.expected.has(note) && !early.has(note) &&
      !this.releasedAt.has(note));
    const repeat = [...this.pending.keys()].filter(note => input.held.has(note));
    this.status = {
      connected: input.connected, missing, extra, repeat,
      blocked: !input.connected || missing.length > 0 || extra.length > 0 || repeat.length > 0,
    };
    return this.status;
  }

  advance(now, input) {
    let remaining = Math.max(0, now - this.lastWall) * this.speed;
    this.lastWall = now;
    if (this.reconcile(input).blocked) return this.time;
    while (remaining > 0) {
      const event = this.events[this.next];
      let boundary = event ? event.time : Infinity;
      // Stop exactly at release allowance expiry, even after a delayed frame.
      for (const ended of this.releasedAt.values()) {
        boundary = Math.min(boundary, ended + this.releaseSeconds * this.speed);
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
