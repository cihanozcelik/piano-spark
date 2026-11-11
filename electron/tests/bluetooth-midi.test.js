// Plain Node: node electron/tests/bluetooth-midi.test.js
// The BLE-MIDI decoder, encoder and scheduled output against hand-built packets.
'use strict';
const assert = require('assert');
const { createDecoder, encode, createOutput, propertyMask } = require('../bluetooth-page');
const { midiEvent, plainIdentifier, hashedAddress } = require('../bluetooth');

let passed = 0;
function test(name, body) { body(); passed++; console.log(`ok ${passed} - ${name}`); }
const decodeAll = (decode, bytes) => { const out = []; const error = decode(Uint8Array.from(bytes), (...message) => out.push(message)); return { out, error }; };

test('one full message: header, timestamp, note on', () => {
  // header high=0b000010 (2), timestamp low=0x05 -> (2<<7)|5 = 261
  const { out, error } = decodeAll(createDecoder(), [0x82, 0x85, 0x90, 60, 100]);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(out, [[0x90, 60, 100, 261]]);
});

test('running status: no status byte, with and without a new timestamp', () => {
  const { out, error } = decodeAll(createDecoder(), [0x80, 0x80, 0x90, 60, 100, 64, 90, 0x81, 67, 80]);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(out, [[0x90, 60, 100, 0], [0x90, 64, 90, 0], [0x90, 67, 80, 1]]);
});

test('several full messages in one packet, each with its own timestamp', () => {
  const { out, error } = decodeAll(createDecoder(), [0x80, 0x81, 0x90, 60, 100, 0x82, 0xB0, 64, 127, 0x83, 0x80, 60, 0]);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(out, [[0x90, 60, 100, 1], [0xB0, 64, 127, 2], [0x80, 60, 0, 3]]);
});

test('timestamp rollover: a lower low byte raises the high bits', () => {
  // high=1, low 0x7E -> 254; then low 0x02 is smaller, so high becomes 2 -> 258
  const { out } = decodeAll(createDecoder(), [0x81, 0xFE, 0x90, 60, 100, 0x82, 0x80, 60, 0]);
  assert.deepStrictEqual(out, [[0x90, 60, 100, 254], [0x80, 60, 0, 258]]);
  // the 6 high bits wrap at 64: high=63, low 0x7F -> 8191; then low 0 -> high 0 -> 0
  const wrap = decodeAll(createDecoder(), [0xBF, 0xFF, 0x90, 60, 1, 0x80, 0x90, 61, 1]);
  assert.deepStrictEqual(wrap.out, [[0x90, 60, 1, 8191], [0x90, 61, 1, 0]]);
});

test('sysex is skipped, inside one packet and across packets', () => {
  const one = decodeAll(createDecoder(), [0x80, 0x80, 0xF0, 0x7E, 0x7F, 0x06, 0x01, 0x80, 0xF7, 0x81, 0x90, 60, 100]);
  assert.strictEqual(one.error, null);
  assert.deepStrictEqual(one.out, [[0x90, 60, 100, 1]]);
  const decode = createDecoder();
  assert.deepStrictEqual(decodeAll(decode, [0x80, 0x80, 0xF0, 1, 2, 3]), { out: [], error: null });
  assert.deepStrictEqual(decodeAll(decode, [0x80, 4, 5, 6]), { out: [], error: null });           // continuation packet
  assert.deepStrictEqual(decodeAll(decode, [0x80, 7, 0x85, 0xF7, 0x86, 0x90, 62, 70]), { out: [[0x90, 62, 70, 6]], error: null });
});

test('real-time messages are dropped and do not end running status', () => {
  const { out, error } = decodeAll(createDecoder(), [0x80, 0x80, 0x90, 60, 100, 0x81, 0xFE, 0x82, 0xF8, 0x83, 64, 90]);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(out, [[0x90, 60, 100, 0], [0x90, 64, 90, 3]]);
});

test('one-data-byte messages: program change and channel pressure', () => {
  const { out } = decodeAll(createDecoder(), [0x80, 0x80, 0xC0, 5, 0x81, 0xD3, 99]);
  assert.deepStrictEqual(out, [[0xC0, 5, 0, 0], [0xD3, 99, 0, 1]]);
});

test('invalid packets are named, as the Mac decoder names them', () => {
  assert.strictEqual(decodeAll(createDecoder(), []).error, null);
  assert.strictEqual(decodeAll(createDecoder(), [0x40, 0x80, 0x90, 60, 1]).error, 'Invalid BLE-MIDI header (byte 0)');
  assert.strictEqual(decodeAll(createDecoder(), [0x80, 60, 100]).error, 'Missing MIDI timestamp (byte 1)');
  assert.strictEqual(decodeAll(createDecoder(), [0x80, 0x80]).error, 'Timestamp without MIDI message (byte 2)');
  assert.strictEqual(decodeAll(createDecoder(), [0x80, 0x80, 0x90, 60]).error, 'Truncated MIDI message (byte 3)');
  assert.strictEqual(decodeAll(createDecoder(), [0x80, 0x80, 0x90, 60, 0x90]).error, 'Status inside MIDI data (byte 4)');
  assert.strictEqual(decodeAll(createDecoder(), [0x80, 0x80, 60, 100]).error, 'Running status without a channel message (byte 2)');
  // messages before the fault are still delivered
  const partial = decodeAll(createDecoder(), [0x80, 0x80, 0x90, 60, 100, 0x81, 0x90, 61]);
  assert.deepStrictEqual(partial.out, [[0x90, 60, 100, 0]]);
  assert.strictEqual(partial.error, 'Truncated MIDI message (byte 7)');
});

test('encoder: 13-bit timestamp, one message per packet, and it decodes back', () => {
  assert.deepStrictEqual([...encode(0x93, 60, 100, 0)], [0x80, 0x80, 0x93, 60, 100]);
  assert.deepStrictEqual([...encode(0x90, 60, 100, 8191)], [0xBF, 0xFF, 0x90, 60, 100]);
  assert.deepStrictEqual([...encode(0x90, 60, 100, 8192 + 261.7)], [0x82, 0x85, 0x90, 60, 100]);
  for (const milliseconds of [0, 1, 127, 128, 4095, 8191, 123456789]) {
    const { out, error } = decodeAll(createDecoder(), [...encode(0xB2, 64, 127, milliseconds)]);
    assert.strictEqual(error, null);
    assert.deepStrictEqual(out, [[0xB2, 64, 127, milliseconds % 8192]]);
  }
});

test('page events: notes, pedals, control change, other messages', () => {
  assert.deepStrictEqual(midiEvent(0x92, 60, 100, 261, 1.5), ['note_on',
    { channel: 3, device_time_ms: 261, received_monotonic_seconds: 1.5, note: 60, name: 'C4', velocity: 100 }]);
  assert.strictEqual(midiEvent(0x90, 60, 0, 0, 0)[0], 'note_off');           // note on with velocity 0
  assert.strictEqual(midiEvent(0x80, 21, 64, 0, 0)[1].name, 'A0');
  assert.strictEqual(midiEvent(0x80, 108, 64, 0, 0)[1].name, 'C8');
  assert.strictEqual(midiEvent(0x90, 0, 1, 0, 0)[1].name, 'C-1');
  assert.deepStrictEqual(midiEvent(0xB0, 64, 127, 7, 2), ['pedal',
    { channel: 1, device_time_ms: 7, received_monotonic_seconds: 2, controller: 64, value: 127, pedal: 'sustain', pressed: true }]);
  assert.deepStrictEqual([midiEvent(0xB0, 64, 63, 0, 0)[1].pressed, midiEvent(0xB0, 64, 64, 0, 0)[1].pressed], [false, true]);
  assert.strictEqual(midiEvent(0xB0, 66, 127, 0, 0)[1].pedal, 'sostenuto');
  assert.strictEqual(midiEvent(0xB0, 67, 127, 0, 0)[1].pedal, 'soft');
  assert.deepStrictEqual(midiEvent(0xB4, 123, 0, 0, 0), ['control_change',
    { channel: 5, device_time_ms: 0, received_monotonic_seconds: 0, controller: 123, value: 0 }]);
  assert.deepStrictEqual(midiEvent(0xC1, 5, 0, 9, 0), ['midi_message',
    { channel: 2, device_time_ms: 9, received_monotonic_seconds: 0, status: 0xC1, data1: 5, data2: 0 }]);
});

// A fake link with a clock the test moves by hand.
function fakeLink() {
  const link = {
    time: 100, sent: [], errors: [], isConnected: true, isWritable: true, room: true, ticking: false,
    now: () => link.time, unix: () => 1700000000000, connected: () => link.isConnected, writable: () => link.isWritable,
    canSend: () => link.room, send: packet => link.sent.push([...packet]), onError: message => link.errors.push(message),
    every: { start: () => { link.ticking = true; return 1; }, stop: () => { link.ticking = false; } },
  };
  return link;
}
const midi = link => link.sent.map(packet => packet.slice(2));

test('output: events leave at their time, 120 ms after the start', () => {
  const link = fakeLink(), output = createOutput(link);
  const reply = output.command({ command: 'output-start', session: 's', duration: 1, events: [[0, 0x90, 60, 80], [0.5, 0x80, 60, 0], [0.5, 0x90, 62, 70], [1, 0x80, 62, 0]] });
  assert.deepStrictEqual(reply, { ok: true, start_unix_ms: 1700000000120 });
  assert.strictEqual(link.ticking, true);
  link.time = 100.10; output.flush(); assert.deepStrictEqual(midi(link), []);
  link.time = 100.12; output.flush(); assert.deepStrictEqual(midi(link), [[0x90, 60, 80]]);
  // the packet carries the low 13 bits of the millisecond clock
  assert.deepStrictEqual(link.sent[0].slice(0, 2), [0x80 | ((100120 % 8192) >> 7), 0x80 | ((100120 % 8192) & 127)]);
  link.time = 100.63; output.flush(); assert.deepStrictEqual(midi(link).slice(1), [[0x80, 60, 0], [0x90, 62, 70]]);
  link.time = 101.13; output.flush();
  // the last note-off, then the end of the lesson releases the sustain pedal on the used channel
  assert.deepStrictEqual(midi(link).slice(3), [[0x80, 62, 0], [0xB0, 64, 0]]);
  assert.strictEqual(output.playing(), false);
  output.flush(); assert.strictEqual(link.ticking, false);
  assert.deepStrictEqual(link.errors, []);
});

test('output: stop releases held keys and the pedal; overlapping notes release once', () => {
  const link = fakeLink(), output = createOutput(link);
  output.command({ command: 'output-start', session: 's', duration: 10,
    events: [[0, 0x93, 60, 80], [0, 0x93, 60, 80], [0, 0xB3, 64, 127], [0.1, 0x83, 60, 0], [5, 0x93, 64, 80]] });
  link.time = 100.25; output.flush();
  // the first of two note-offs for a key struck twice is held back
  assert.deepStrictEqual(midi(link), [[0x93, 60, 80], [0x93, 60, 80], [0xB3, 64, 127]]);
  assert.deepStrictEqual(output.command({ command: 'output-stop', session: 'other' }), { ok: true });
  assert.strictEqual(output.playing(), true);
  assert.deepStrictEqual(output.command({ command: 'output-stop', session: 's' }), { ok: true });
  assert.deepStrictEqual(midi(link).slice(3), [[0xB3, 64, 0], [0x83, 60, 0]]);
  assert.strictEqual(output.drained(), true);
});

test('output: a full link holds releases back; a new lesson must wait for them', () => {
  const link = fakeLink(), output = createOutput(link);
  output.command({ command: 'output-start', session: 'a', duration: 10, events: [[0, 0x90, 60, 80]] });
  link.time = 100.2; output.flush();
  link.room = false;
  output.command({ command: 'output-stop', session: 'a' });
  assert.strictEqual(output.drained(), false);
  assert.deepStrictEqual(output.command({ command: 'output-start', session: 'b', duration: 1, events: [] }), { error: 'Önce mevcut piyano çalmasını durdur.' });
  link.room = true; output.flush();
  assert.strictEqual(output.drained(), true);
  assert.deepStrictEqual(midi(link).slice(1), [[0xB0, 64, 0], [0x80, 60, 0]]);
  assert.strictEqual(output.command({ command: 'output-start', session: 'b', duration: 1, events: [] }).ok, true);
});

test('output: heartbeat lease, lateness and a refused write stop the lesson with the Mac’s messages', () => {
  let link = fakeLink(), output = createOutput(link);
  output.command({ command: 'output-start', session: 's', duration: 60, events: [[0, 0x90, 60, 80], [30, 0x80, 60, 0]] });
  link.time = 100.2; output.flush();
  link.time = 101.9; output.command({ command: 'output-heartbeat', session: 's' });
  link.time = 103.8; output.flush(); assert.deepStrictEqual(link.errors, []);
  link.time = 106; output.flush();
  assert.deepStrictEqual(link.errors, ['Çalma sayfasıyla iletişim kesildi; piyano çalması durduruldu.']);
  assert.deepStrictEqual(midi(link).slice(1), [[0xB0, 64, 0], [0x80, 60, 0]]);

  link = fakeLink(); output = createOutput(link);
  output.command({ command: 'output-start', session: 's', duration: 60, events: [[0, 0x90, 60, 80], [1, 0x80, 60, 0]] });
  link.time = 100.2; output.flush();
  link.room = false; link.time = 101.3; output.flush(); assert.deepStrictEqual(link.errors, []);   // 180 ms late: still waiting
  link.time = 101.5; output.flush();
  assert.deepStrictEqual(link.errors, ['Bluetooth MIDI gönderimi gecikti; çalma durduruldu.']);

  link = fakeLink(); output = createOutput(link);
  output.command({ command: 'output-start', session: 's', duration: 60, events: [[0, 0x90, 60, 80]] });
  output.failed();
  assert.deepStrictEqual(link.errors, ['Bluetooth MIDI gönderimi gecikti; çalma durduruldu.']);
  output.failed(); assert.strictEqual(link.errors.length, 1);
});

test('output: a lost link drops everything without writing', () => {
  const link = fakeLink(), output = createOutput(link);
  output.command({ command: 'output-start', session: 's', duration: 60, events: [[0, 0x90, 60, 80]] });
  link.time = 100.2; output.flush();
  link.isConnected = false; output.stop();
  assert.strictEqual(link.sent.length, 1);
  assert.strictEqual(output.drained(), true);
  assert.strictEqual(link.ticking, false);
});

test('output: requests are refused with the Mac’s messages', () => {
  const link = fakeLink(), output = createOutput(link);
  const start = extra => output.command({ command: 'output-start', session: 's', duration: 1, events: [], ...extra });
  assert.deepStrictEqual(output.command({ command: 'output-start' }), { error: 'Geçersiz çalma oturumu.' });
  assert.deepStrictEqual(output.command({ command: 'output-start', session: 'x'.repeat(81) }), { error: 'Geçersiz çalma oturumu.' });
  assert.deepStrictEqual(output.command({ command: 'output-play', session: 's' }), { error: 'Geçersiz MIDI çıkış komutu.' });
  assert.deepStrictEqual(start({ events: 'no' }), { error: 'Ders MIDI çıkışı için çok büyük veya geçersiz.' });
  assert.deepStrictEqual(start({ duration: 86401 }), { error: 'Ders MIDI çıkışı için çok büyük veya geçersiz.' });
  assert.deepStrictEqual(start({ events: [[0, 0x90, 60]] }), { error: 'Geçersiz MIDI olayı.' });
  assert.deepStrictEqual(start({ events: [[0, 0x90, '60', 1]] }), { error: 'Geçersiz MIDI değeri.' });
  for (const event of [[2, 0x90, 60, 1], [-1, 0x90, 60, 1], [0, 0xC0, 60, 1], [0, 0x90, 128, 1], [0, 0x90, 60, 128], [0, 0xB0, 7, 1], [0, 256 + 0x90, 60, 1]])
    assert.deepStrictEqual(start({ events: [event] }), { error: 'Desteklenmeyen MIDI olayı.' }, JSON.stringify(event));
  assert.deepStrictEqual(start({ events: [[0.5, 0x90, 60, 1], [0.4, 0x80, 60, 0]] }), { error: 'Desteklenmeyen MIDI olayı.' });
  link.isWritable = false;
  assert.deepStrictEqual(start(), { error: 'Bu bağlantıda MIDI gönderimi hazır değil.' });
  link.isWritable = true;
  assert.strictEqual(start().ok, true);
  assert.deepStrictEqual(start(), { error: 'Önce mevcut piyano çalmasını durdur.' });
});

test('device ids: an address becomes the id the Windows app used; a Mac identifier hashes to Chromium’s address', () => {
  assert.strictEqual(plainIdentifier('AA:BB:CC:01:02:03'), '00000000-0000-0000-0000-AABBCC010203');
  assert.strictEqual(plainIdentifier('aa:bb:cc:01:02:03'), '00000000-0000-0000-0000-AABBCC010203');
  assert.match(plainIdentifier('something-else'), /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);
  assert.match(hashedAddress('12345678-1234-1234-1234-1234567890AB'), /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  assert.strictEqual(hashedAddress('12345678-1234-1234-1234-1234567890ab'), hashedAddress('12345678-1234-1234-1234-1234567890AB'));
  assert.strictEqual(propertyMask({ read: true, writeWithoutResponse: true, notify: true }), 0x16);
});

console.log(`${passed} tests passed`);
