// Run with: node --test tests/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PracticeSession } from '../practice-session.js';
import { PracticeClock } from '../practice-clock.js';

const note = (midi, time, end) => ({midi, time, end});
const session = (segments, notes, strategy = 'rows') => {
  const practice = new PracticeSession();
  practice.configure({segments, signature: 'test', notes, strategy, target: 3, track: 'both', speed: 1});
  return practice;
};
const pitches = notes => notes.map(note => note.midi).sort((a, b) => a - b);
const firstOnset = notes => {
  const clock = new PracticeClock();
  clock.load(notes, -2, 0, {attacks: new Map(), held: new Set(), connected: true});
  return clock.events[0];
};

// Issue #1: "On the Nature of Daylight", Row 2 starts at measure 6.
const barline = 21.55629;
const daylight = [
  note(53, 19.8, 21.5925), note(58, 19.8, 21.5925), note(61, 19.8, 21.5925), note(75, 21.3, 21.5925),
  note(53, 21.5925, 23.4), note(56, 21.5925, 23.4), note(60, 21.5925, 23.4), note(75, 21.5925, 22.2),
];
const daylightRows = [
  {id: 'm0-4', index: 0, page: 1, firstMeasure: 0, lastMeasure: 4, start: 17.4, end: barline},
  {id: 'm5-8', index: 1, page: 1, firstMeasure: 5, lastMeasure: 8, start: barline, end: 25.7},
];

test('a row starts with its own downbeat, not the previous measure tails', () => {
  const [first, second] = session(daylightRows, daylight).stages;
  assert.equal(second.start, 21.5925);
  assert.deepEqual(pitches(second.notes), [53, 56, 60, 75]);
  assert.ok(second.notes.every(note => note.time === 21.5925));
  const onset = firstOnset(second.notes);
  assert.equal(onset.time, 21.5925);
  assert.deepEqual(onset.starts.sort((a, b) => a - b), [53, 56, 60, 75]);
  assert.deepEqual(onset.ends, []);
  // The previous row keeps its notes until they are really released.
  assert.equal(first.end, 21.5925);
  assert.ok(first.notes.slice(0, 4).every(note => note.end === 21.5925));
});

test('combined build stages share the same boundary', () => {
  const stages = session(daylightRows, daylight, 'build').stages;
  assert.equal(stages.length, 3);
  assert.deepEqual(stages.map(stage => [stage.firstRow, stage.lastRow]), [[1, 1], [2, 2], [1, 2]]);
  assert.equal(stages[2].notes.length, daylight.length);
});

test('a slightly early performed downbeat still belongs to the new row', () => {
  const notes = [note(60, 1, 1.97), note(64, 1.97, 3), note(67, 1.98, 3)];
  const rows = [{start: 0, end: 2}, {start: 2, end: 4}];
  const [first, second] = session(rows, notes).stages;
  assert.equal(second.start, 1.97);
  assert.deepEqual(pitches(second.notes), [64, 67]);
  assert.deepEqual(pitches(first.notes), [60]);
});

test('the nearest chord wins over the last note of the previous measure', () => {
  const notes = [note(60, 1.93, 2.02), note(64, 2.02, 3), note(67, 2.03, 3)];
  const rows = [{start: 0, end: 2}, {start: 2, end: 4}];
  const [first, second] = session(rows, notes).stages;
  assert.equal(second.start, 2.02);
  assert.deepEqual(pitches(first.notes), [60]);
  assert.deepEqual(pitches(second.notes), [64, 67]);
});

test('a note really held over the barline is pressed again in an isolated row', () => {
  const notes = [note(48, 1, 3.5), note(60, 1.5, 2), note(60, 2, 2.5), note(62, 2, 2.5)];
  const rows = [{start: 0, end: 2}, {start: 2, end: 4}];
  const [first, second] = session(rows, notes).stages;
  assert.deepEqual(pitches(second.notes), [48, 60, 62]);
  assert.equal(second.notes.find(note => note.midi === 48).time, 2);
  assert.deepEqual(pitches(first.notes), [48, 60]);
  assert.equal(first.notes.find(note => note.midi === 48).end, 2);
});

test('a short skew tail is not a target even without a nearby downbeat', () => {
  // The new row starts with a rest; the old chord overhangs its barline by 36 ms.
  const notes = [note(53, 1, 2.036), note(58, 1, 2.036), note(60, 2.5, 3)];
  const [, second] = session([{start: 0, end: 2}, {start: 2, end: 4}], notes).stages;
  assert.equal(second.start, 2);
  assert.deepEqual(pitches(second.notes), [60]);
});

test('the final row end is not moved', () => {
  const notes = [note(60, 0, 1), note(62, 3.95, 4)];
  const [, second] = session([{start: 0, end: 2}, {start: 2, end: 4}], notes).stages;
  assert.equal(second.end, 4);
  assert.deepEqual(pitches(second.notes), [62]);
});

test('a row holding only carried-over tails has no exercise', () => {
  const rows = [{start: 0, end: 2}, {start: 2, end: 4}, {start: 4, end: 6}];
  const practice = session(rows, [note(60, 0, 2.05), note(62, 4, 5)]);
  assert.deepEqual(practice.stages.map(stage => stage.firstRow), [1, 3]);
  assert.equal(practice.mastery().rows[1].status, 'empty');
});

const threeRows = [{start: 0, end: 2}, {start: 2, end: 4}, {start: 4, end: 6}];
const threeRowNotes = [note(60, 0, 1), note(62, 2, 3), note(64, 4, 5)];
const cleanPasses = (practice, count) => {
  for (let pass = 0; pass < count; pass++) { practice.phase = 'playing'; practice.finish(); }
};

test('skipping ahead does not award the skipped row', () => {
  const practice = session(threeRows, threeRowNotes);
  cleanPasses(practice, 2);
  assert.ok(practice.select(2));
  assert.equal(practice.stage, 2);
  assert.equal(practice.streak, 0);
  const mastery = practice.mastery();
  assert.deepEqual(mastery.rows.map(row => row.status), ['waiting', 'waiting', 'learning']);
  assert.equal(mastery.learned, 0);
  assert.equal(mastery.percent, 0);
});

test('mastering a later row returns to the first skipped row', () => {
  const practice = session(threeRows, threeRowNotes);
  practice.select(1);
  cleanPasses(practice, 3);
  assert.equal(practice.stage, 2);
  cleanPasses(practice, 3);
  assert.equal(practice.stage, 0);
  assert.equal(practice.done, false);
  assert.deepEqual(practice.progress().cleared, [1, 2]);
  assert.equal(practice.mastery().percent, 66);
  cleanPasses(practice, 3);
  assert.equal(practice.done, true);
  assert.equal(practice.mastery().percent, 100);
});

test('going back keeps earned mastery and replaying it finishes again', () => {
  const practice = session(threeRows, threeRowNotes);
  cleanPasses(practice, 9);
  assert.equal(practice.done, true);
  assert.ok(practice.select(1));
  assert.equal(practice.done, false);
  assert.equal(practice.current.firstRow, 2);
  assert.equal(practice.mastery().learned, 3);
  assert.equal(practice.mastery().percent, 100);
  cleanPasses(practice, 3);
  assert.equal(practice.done, true);
});

test('selection stays inside the plan', () => {
  const practice = session(threeRows, threeRowNotes);
  assert.equal(practice.select(-1), false);
  assert.equal(practice.select(3), false);
  assert.equal(practice.select(0), false);
  assert.equal(practice.stage, 0);
});

test('progress saved before free navigation keeps every earlier stage', () => {
  const first = session(threeRows, threeRowNotes);
  const restore = saved => {
    const practice = new PracticeSession();
    practice.configure({segments: threeRows, signature: 'test', notes: threeRowNotes, strategy: 'rows',
      target: 3, track: 'both', speed: 1, saved: {[first.key]: saved}});
    return practice;
  };
  const legacy = restore({stage: 2, streak: 1});
  assert.deepEqual(legacy.progress(), {stage: 2, streak: 1, cleared: [0, 1]});
  assert.equal(restore({stage: 3, streak: 0}).done, true);
  const current = restore({stage: 0, streak: 2, cleared: [2, 7, -1, 'x']});
  assert.deepEqual(current.progress(), {stage: 0, streak: 2, cleared: [2]});
});
