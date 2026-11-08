// Run with: node --test tests/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { HandReach } from '../hand-reach.js';
import { PracticeClock } from '../practice-clock.js';

const note = (midi, time, end, hand) => ({midi, time, end, hand});
const optional = notes => notes.filter(note => note.optional).map(note => note.midi);
const reach = {left: 10, right: 10};

test('the right hand keeps the melody and drops the far low note', () => {
  // C4 E4 G4 C5 (12 semitones) for a 10-semitone hand.
  const notes = [note(60, 0, 1, 1), note(64, 0, 1, 1), note(67, 0.01, 1, 1), note(72, 0.02, 1, 1)];
  const adapted = HandReach.adapt(notes, reach);
  assert.deepEqual(optional(adapted), [60]);
  assert.equal(adapted.find(n => n.midi === 72).optional, undefined);
});

test('the left hand keeps the bass and drops the far high note', () => {
  const notes = [note(36, 0, 1, 0), note(43, 0, 1, 0), note(48, 0, 1, 0)];
  assert.deepEqual(optional(HandReach.adapt(notes, reach)), [48]);
});

test('reachable chords, separate onsets and the other hand stay required', () => {
  const notes = [
    note(60, 0, 1, 1), note(69, 0, 1, 1),          // 9 semitones: reachable
    note(48, 1, 2, 1), note(72, 1.2, 2, 1),        // far apart in time
    note(36, 2, 3, 0), note(76, 2, 3, 1),          // different hands
  ];
  assert.equal(HandReach.adapt(notes, reach), notes);
});

test('the lesson notes are never changed', () => {
  const notes = [note(60, 0, 1, 1), note(72, 0, 1, 1)];
  const before = JSON.stringify(notes);
  const adapted = HandReach.adapt(notes, reach);
  assert.equal(JSON.stringify(notes), before);
  assert.notEqual(adapted, notes);
  assert.equal(HandReach.adapt(notes, null), notes);
});

test('hands without an explicit part follow the middle C split', () => {
  const notes = [{midi: 40, time: 0, end: 1}, {midi: 55, time: 0, end: 1}];
  assert.deepEqual(optional(HandReach.adapt(notes, reach)), [55]);
});

test('measurement accepts only one-hand spans', () => {
  assert.equal(HandReach.measure([60]), null);
  assert.equal(HandReach.measure([60, 62]), null);
  assert.equal(HandReach.measure([60, 64, 71]), 11);
  assert.equal(HandReach.measure([36, 84]), null);
  assert.equal(HandReach.valid({left: 11, right: 12}), true);
  assert.equal(HandReach.valid({left: 11}), false);
});

const input = (held = [], attacks = []) => ({
  connected: true, held: new Set(held),
  attacks: new Map(attacks.map(([midi, serial]) => [midi, {serial}])),
});

test('the clock waits only for required notes of an adapted chord', () => {
  const notes = HandReach.adapt([note(60, 1, 2, 1), note(64, 1, 2, 1), note(72, 1, 2, 1)], reach);
  const clock = new PracticeClock();
  clock.load(notes, 0, 0, input());
  clock.advance(5, input());
  assert.equal(clock.time, 1);
  assert.deepEqual(clock.status.missing.sort((a, b) => a - b), [64, 72]);
  const played = input([64, 72], [[64, 1], [72, 2]]);
  clock.advance(5.5, played);
  assert.equal(clock.status.blocked, false);
  assert.ok(clock.time > 1);
});

test('playing the optional note too is accepted, not an error', () => {
  const notes = HandReach.adapt([note(60, 1, 2, 1), note(64, 1, 2, 1), note(72, 1, 2, 1)], reach);
  const clock = new PracticeClock();
  clock.load(notes, 0, 0, input());
  clock.advance(5, input());
  const all = input([60, 64, 72], [[60, 1], [64, 2], [72, 3]]);
  clock.advance(5.5, all);
  assert.equal(clock.status.blocked, false);
  assert.deepEqual(clock.status.extra, []);
  assert.equal(clock.unexpectedAttacks.has(60), false);
});

test('a wrong note is still an error next to an optional one', () => {
  const notes = HandReach.adapt([note(60, 1, 2, 1), note(64, 1, 2, 1), note(72, 1, 2, 1)], reach);
  const clock = new PracticeClock();
  clock.load(notes, 0, 0, input());
  clock.advance(5, input());
  clock.advance(5.1, input([61, 64, 72], [[61, 1], [64, 2], [72, 3]]));
  assert.deepEqual(clock.status.extra, [61]);
  assert.equal(clock.status.blocked, true);
});
