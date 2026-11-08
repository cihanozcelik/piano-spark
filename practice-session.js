import { PracticeClock } from './practice-clock.js';
// PracticeClock owns matching and time. This session owns only the learning plan
// and completed progress; the player owns transport, input and loop restarts.
export class PracticeSession {
  // Seconds. A performed downbeat this close to a barline is that barline.
  static boundaryTolerance = .08;
  // Seconds between onsets of one spread or rolled chord.
  static chordSpread = .03;

  // Returns a function that moves a score barline to the earliest onset of
  // the nearest chord performed around it, or keeps it when nothing is near.
  static boundaryFinder(onsets) {
    const times = [...new Set(onsets)].sort((a, b) => a - b);
    return barline => {
      const near = times.filter(time => Math.abs(time - barline) <= PracticeSession.boundaryTolerance);
      const groups = [];
      for (const time of near) {
        if (groups.length && time - groups.at(-1).at(-1) <= PracticeSession.chordSpread) groups.at(-1).push(time);
        else groups.push([time]);
      }
      const distance = group => Math.min(...group.map(time => Math.abs(time - barline)));
      return groups.reduce((best, group) => !best || distance(group) < distance(best) ? group : best, null)?.[0] ?? barline;
    };
  }

  constructor() {
    this.key = '';
    this.stages = [];
    this.stage = 0;
    this.streak = 0;
    this.cleared = new Set();
    this.target = 10;
    this.done = false;
    this.phase = 'idle';
    this.reason = '';
    this.blockedSince = null;
    this.seenAttacks = new Map();
  }

  configure({segments, signature, notes, strategy, target, track, speed, timing = PracticeClock.timingProfile('hard'), saved = {}}) {
    this.target = target;
    this.timing = timing;
    this.stages = [];
    // Use the clock's microsecond domain before deciding boundary membership.
    // Floating-point noise at a barline must not create an ends/starts event
    // pair at one clock tick and leave a phantom key pending forever.
    const tick = time => Math.round(time * 1000000) / 1000000;
    const clockNotes = notes.map(note => ({...note, time: tick(note.time), end: tick(note.end)}))
      .filter(note => note.end > note.time);
    // A held note crossing the start of an isolated stage is pressed again
    // there. A carried-over fragment shorter than the boundary tolerance is
    // only timing skew between the score and the performance, never a target.
    const clip = (start, end) => clockNotes
      .filter(note => note.time < end && note.end > start &&
        (note.time >= start || note.end - start > PracticeSession.boundaryTolerance))
      .map(note => ({...note, time: Math.max(start, note.time), end: Math.min(end, note.end)}));
    // Score barlines and performed onsets disagree by a few milliseconds. Use
    // the performed downbeat as the shared boundary of adjacent rows. The piece
    // end is never moved: no following row could own a note left out there.
    const boundary = PracticeSession.boundaryFinder(clockNotes.map(note => note.time));
    const scoreRows = segments.map((segment, index) => {
      let start = boundary(tick(segment.start));
      let end = index === segments.length - 1 ? tick(segment.end) : boundary(tick(segment.end));
      if (end <= start) [start, end] = [tick(segment.start), tick(segment.end)];
      return {
        id: segment.id, page: segment.page,
        firstMeasure: segment.firstMeasure, lastMeasure: segment.lastMeasure,
        start, end,
        firstRow: (segment.index ?? index) + 1,
        lastRow: (segment.index ?? index) + 1,
        notes: clip(start, end),
        // Tracked under the 0.6.0 overlap rule; see the progress context below.
        legacyTracked: clockNotes.some(note => note.time < tick(segment.end) && note.end > tick(segment.start)),
      };
    });
    const rows = scoreRows.filter(row => row.notes.length);
    this.rows = scoreRows;
    this.masteryCache = null;
    if (strategy === 'rows') this.stages = rows;
    if (strategy === 'build') {
      for (const [index, row] of rows.entries()) {
        this.stages.push(row);
        // Learn the new row alone before joining it to the learned prefix:
        // A, B, A+B, C, A+B+C. Silent standalone rows have no exercise.
        if (index > 0) this.stages.push({
          start: rows[0].start,
          end: row.end,
          firstRow: rows[0].firstRow,
          lastRow: row.lastRow,
          notes: clip(rows[0].start, row.end),
        });
      }
    }
    // Changing hands, speed, target, notation layout or the source performance
    // creates a different mastery context, without erasing the previous one.
    const context = [signature, strategy, target, track, speed,
      notes.map(note => [note.midi, note.time, note.end])];
    // Hard is the original grading contract; its existing progress stays valid.
    if (timing.id !== 'hard') context.push(timing);
    // Saved stage indices stay valid unless a row held only carried-over tails
    // and therefore no longer has an exercise. Only that layout gets a new context.
    if (scoreRows.some(row => row.legacyTracked !== row.notes.length > 0)) context.push('onset-rows');
    const identity = JSON.stringify(context);
    let hash = 2166136261;
    for (let index = 0; index < identity.length; index++) {
      hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
    }
    this.key = 'practice-v1-' + (hash >>> 0).toString(16);
    const progress = saved[this.key] || {};
    this.stage = Number.isInteger(progress.stage)
      ? Math.max(0, Math.min(this.stages.length, progress.stage)) : 0;
    // Before free navigation, every stage before the saved one was mastered.
    this.cleared = new Set(Array.isArray(progress.cleared)
      ? progress.cleared.filter(index => Number.isInteger(index) && index >= 0 && index < this.stages.length)
      : Array.from({length: Math.min(this.stage, this.stages.length)}, (_, index) => index));
    if (this.stage === this.stages.length && !this.complete) this.stage = this.nextOpenStage(-1);
    this.streak = this.stage < this.stages.length && Number.isInteger(progress.streak)
      ? Math.max(0, Math.min(target - 1, progress.streak)) : 0;
    this.done = this.stages.length > 0 && this.stage === this.stages.length;
    this.interrupt();
    if (this.done) this.phase = 'complete';
  }

  get current() { return this.stages[this.stage]; }
  get active() { return this.stages.length > 0; }
  get complete() { return this.stages.length > 0 && this.cleared.size === this.stages.length; }
  progress() { return {stage: this.stage, streak: this.streak, cleared: [...this.cleared].sort((a, b) => a - b)}; }

  // The first unmastered stage after `index`, wrapping to the start, or the
  // end of the plan when every stage is mastered.
  nextOpenStage(index) {
    for (let step = 1; step <= this.stages.length; step++) {
      const candidate = (index + step) % this.stages.length;
      if (!this.cleared.has(candidate)) return candidate;
    }
    return this.stages.length;
  }

  // Move freely through the plan. Mastery is kept per stage, so skipping
  // ahead never awards a stage and going back never removes one. A clean
  // streak is consecutive, so it does not survive leaving its stage.
  select(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.stages.length || index === this.stage) return false;
    this.stage = index;
    this.streak = 0;
    this.done = false;
    this.interrupt();
    return true;
  }

  mastery() {
    if (!this.active) return null;
    const revision = this.stage + ':' + this.streak + ':' + this.cleared.size;
    if (this.masteryCache?.revision === revision) return this.masteryCache;
    const rows = this.rows.map(row => {
      const tracked = row.notes.length > 0;
      const standalone = this.stages.findIndex(stage => stage.firstRow === row.firstRow && stage.lastRow === row.lastRow);
      const passes = !tracked ? 0 : this.cleared.has(standalone) ? this.target : standalone === this.stage ? this.streak : 0;
      const active = tracked && !!this.current && row.firstRow >= this.current.firstRow && row.lastRow <= this.current.lastRow;
      return {id:row.id,row:row.firstRow,page:row.page,firstMeasure:row.firstMeasure,lastMeasure:row.lastMeasure,
        start:row.start,end:row.end,passes,target:this.target,percent:tracked ? Math.floor(passes / this.target * 100) : null,active,
        status:!tracked ? 'empty' : passes === this.target ? 'learned' : active ? 'learning' : 'waiting'};
    });
    // Row mastery means its standalone goal. The plan also includes every
    // combined stage, so mastering all rows alone cannot falsely finish it.
    this.masteryCache = {revision,rows,total:rows.filter(row => row.status !== 'empty').length,
      learned:rows.filter(row => row.status === 'learned').length,
      percent:this.complete ? 100 : Math.floor((this.cleared.size * this.target +
        (this.current && !this.cleared.has(this.stage) ? this.streak : 0)) / (this.stages.length * this.target) * 100),
      combined:!!this.current && this.current.firstRow !== this.current.lastRow,
      stagePercent:this.done ? 100 : Math.floor(this.streak / this.target * 100)};
    return this.masteryCache;
  }

  interrupt() {
    // Pauses and disconnections discard the unfinished attempt, not earned runs.
    this.phase = 'idle';
    this.reason = '';
    this.blockedSince = null;
    this.seenAttacks.clear();
  }

  begin(input) {
    this.reason = '';
    this.blockedSince = null;
    this.seenAttacks = new Map([...input.attacks].map(([pitch, attack]) => [pitch, attack.serial]));
    this.phase = this.done ? 'complete' : 'release';
  }

  started() { this.phase = 'countdown'; }

  fail(reason) {
    if (this.reason) return;
    this.reason = reason;
    // An already observed mistake breaks consecutiveness immediately. Pausing
    // afterwards must not restore the streak from before this failed attempt.
    this.streak = 0;
  }

  observe(now, input, clock) {
    const newAttacks = [];
    for (const [pitch, attack] of input.attacks) {
      if (attack.serial > (this.seenAttacks.get(pitch) || 0)) newAttacks.push(pitch);
      this.seenAttacks.set(pitch, attack.serial);
    }
    if (!input.connected || !this.current || !['countdown', 'playing'].includes(this.phase)) return;
    // The count-in permits the clock's normal early-onset allowance, but an
    // unrelated or much-too-early physical attack still invalidates the run.
    if (newAttacks.some(pitch => clock.status.extra.includes(pitch) ||
      clock.unexpectedAttacks.get(pitch) === input.attacks.get(pitch).serial)) this.fail('wrong');
    if (this.phase === 'countdown') {
      if (clock.time < this.current.start) return;
      this.phase = 'playing';
    }
    if (!this.timing.enabled) return;
    // Evaluate each physical attack once, immediately after reconciliation.
    // A previously accepted pitch becoming extra later is a release/timing
    // issue, never retroactively a wrong attack. Pedal and velocity are ungraded.
    // The clock has already applied the selected release tolerance. Giving a
    // second grace period here would incorrectly credit shortened/extended holds.
    if (clock.status.extra.some(pitch => !newAttacks.includes(pitch)) ||
      clock.status.missing.some(pitch => !clock.pending.has(pitch))) this.fail('release');
    const blocked = clock.status.missing.length || clock.status.repeat.length || clock.status.extra.length;
    // A normal onset initially waits for input. Only a wall-clock delay beyond
    // this allowance breaks the clean streak; speed changes do not scale it.
    // Check elapsed time before clearing the block so late corrections count.
    if (this.blockedSince !== null && now - this.blockedSince > this.timing.late) {
      this.fail(clock.time >= this.current.end ? 'release' : 'timing');
    }
    if (blocked) {
      if (this.blockedSince === null) this.blockedSince = now;
    } else this.blockedSince = null;
  }

  finish() {
    if (this.phase !== 'playing') return null;
    const clean = this.reason === '';
    const completedStage = this.stage;
    const reason = this.reason;
    this.streak = clean ? this.streak + 1 : 0;
    if (this.streak >= this.target) {
      this.cleared.add(this.stage);
      this.stage = this.nextOpenStage(this.stage);
      this.streak = 0;
    }
    this.done = this.stage === this.stages.length;
    this.phase = this.done ? 'complete' : 'idle';
    this.blockedSince = null;
    return {clean, reason, completedStage, advanced: this.stage !== completedStage, done: this.done, ...this.progress()};
  }
}
