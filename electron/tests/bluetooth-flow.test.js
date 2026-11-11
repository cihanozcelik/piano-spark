// Plain Node: node electron/tests/bluetooth-flow.test.js
// The whole service against a simulated piano: the real bluetooth.js and bluetooth-page.js,
// with a stand-in for the hidden window, for Chromium's device chooser and for Web Bluetooth.
// It checks the states and events the page receives; it cannot check a real radio.
'use strict';
const assert = require('assert');
const page = require('../bluetooth-page');
const { createBluetooth, hashedAddress } = require('../bluetooth');

const MAC = process.platform === 'darwin';
// The Windows app words the messages that name the Mac differently (WINDOWS_TEXT in bluetooth.js).
const worded = (mac, windows) => process.platform === 'win32' ? windows : mac;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const failure = (name, message) => Object.assign(new Error(message), { name });

function piano(deviceId, name, options = {}) {
  const listeners = {}, written = [];
  let notify = null;
  const characteristic = {
    properties: { read: true, writeWithoutResponse: options.output !== false, notify: true },
    readValue: async () => { if (options.readError) throw options.readError; return new DataView(new ArrayBuffer(0)); },
    startNotifications: async () => {},
    addEventListener: (type, listener) => { notify = listener; },
    writeValueWithoutResponse: async bytes => { written.push([...bytes].slice(2)); },
  };
  const device = {
    name,
    addEventListener: (type, listener) => { listeners[type] = listener; },
    gatt: {
      connected: false,
      connect: async () => {
        if (options.connectError) throw options.connectError;
        device.gatt.connected = true;
        return { getPrimaryService: async () => {
          if (options.noService) throw failure('NotFoundError', 'No Services matching UUID found in Device.');
          return { getCharacteristic: async () => characteristic };
        } };
      },
      disconnect: () => { device.gatt.connected = false; },
    },
  };
  return {
    deviceId, name, device, written,
    play: bytes => notify({ target: { value: new DataView(Uint8Array.from(bytes).buffer) } }),
    drop: () => { device.gatt.connected = false; listeners.gattserverdisconnected(); },
  };
}

// The store main.js passes in (electron/settings.js), kept in memory.
function memoryStore(values = {}) {
  const store = { values: { ...values }, get: key => store.values[key] ?? null,
    set: (key, value) => { if (value == null) delete store.values[key]; else store.values[key] = value; } };
  return store;
}
// One service with its recorded output. world.show(pianos) is Chromium reporting its list.
function rig(options = {}) {
  const settings = memoryStore(options.settings);
  const world = { published: [], statuses: [], stopped: 0, windows: 0, destroyed: 0, searches: 0, settings, pending: null, chooser: null };
  const openHost = events => {
    world.windows++;
    let toPage = null, alive = true;
    const bluetooth = {
      getAvailability: async () => options.available !== false,
      requestDevice: () => new Promise((resolve, reject) => {
        world.searches++;
        if (options.refuse) { reject(options.refuse); return; }
        world.pending = { resolve, reject };
      }),
    };
    const instance = page.start({
      send: message => setImmediate(() => { if (alive) events.message(JSON.parse(JSON.stringify(message))); }),
      receive: callback => { toPage = callback; },
    }, bluetooth, { sleep: () => wait(1) });
    world.show = pianos => {
      const pending = world.pending;
      if (!pending) return false;
      events.chooser(pianos.map(item => ({ deviceId: item.deviceId, deviceName: item.name || `Unknown or Unsupported Device (${item.deviceId})` })), deviceId => {
        world.pending = null;
        if (!deviceId) pending.reject(failure('NotFoundError', 'User cancelled the requestDevice() chooser.'));
        else pending.resolve(pianos.find(item => item.deviceId === deviceId).device);
      });
      return true;
    };
    world.crash = () => events.gone('crashed', 5);
    setImmediate(() => events.loaded());
    return {
      search: id => { instance.request(id); return Promise.resolve(); },
      send: message => setImmediate(() => { if (alive) toPage(JSON.parse(JSON.stringify(message))); }),
      destroy: () => { if (alive) { alive = false; world.destroyed++; world.pending = null; } },   // a search dies with its window
    };
  };
  world.bluetooth = createBluetooth({
    text: source => source, settings, openHost, timeoutSeconds: options.timeoutSeconds || 45,
    publish: event => {
      world.published.push(event);
      if (event.event === 'status') world.statuses.push(`${event.status.phase}|${event.status.message}`);
    },
    onStopped: () => { world.stopped++; },
  });
  world.other = () => world.published.filter(event => event.event !== 'status').map(event => {
    const { time_unix, received_monotonic_seconds, device_time_ms, ...rest } = event; return rest;
  });
  world.last = () => world.published.filter(event => event.event === 'status').pop().status;
  world.rejects = async (body, message) => assert.rejects(world.bluetooth.command(body), error => { assert.strictEqual(error.message, message); return true; });
  return world;
}

const tests = [];
const test = (name, body) => tests.push([name, body]);

test('scan, discover, connect, play both ways, disconnect', async () => {
  const world = rig(), clp = piano('AA:BB:CC:01:02:03', 'CLP-835'), unnamed = piano('AA:BB:CC:0A:0B:0C', '');
  assert.strictEqual(world.bluetooth.state.remembered_device, null);
  const uuid = '00000000-0000-0000-0000-AABBCC010203';
  assert.strictEqual(world.bluetooth.active, false);
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'scan' }), {});
  assert.strictEqual(world.bluetooth.active, true);
  await wait(20);
  world.show([]); world.show([clp, unnamed]);
  await wait(20);
  assert.deepStrictEqual(world.last().devices.map(({ name, uuid }) => ({ name, uuid })),
    [{ name: 'CLP-835', uuid }, { name: 'Bluetooth MIDI', uuid: '00000000-0000-0000-0000-AABBCC0A0B0C' }]);
  assert.ok(Math.abs(world.last().devices[0].time_unix - Date.now() / 1000) < 5);
  assert.strictEqual(world.last().browsing, true);
  await world.rejects({ command: 'output-heartbeat', session: 's' }, 'Piyano bağlı değil.');
  await world.rejects({ command: 'connect', uuid: 'not-a-uuid' }, 'Listeden bir MIDI cihazı seç.');

  assert.deepStrictEqual(await world.bluetooth.command({ command: 'connect', uuid: uuid.toLowerCase() }), { ok: true });
  await world.rejects({ command: 'scan' }, 'Önce mevcut bağlantıyı kes.');
  await wait(30);
  assert.deepStrictEqual(world.statuses, [
    worded('starting|Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla.', 'starting|Bilgisayarın Bluetooth erişimi kontrol ediliyor…'),
    'scanning|Yakındaki Bluetooth MIDI cihazları aranıyor…',
    'scanning|Yakındaki Bluetooth MIDI cihazları aranıyor…',     // discovered: CLP-835
    'scanning|Yakındaki Bluetooth MIDI cihazları aranıyor…',     // discovered: unnamed
    'connecting|Seçilen piyanoya bağlanılıyor…',
    'connecting|Piyanoya Bluetooth bağlantısı kuruldu. MIDI hizmeti kontrol ediliyor…',
    worded('connecting|MIDI bağlantısı hazırlanıyor… macOS eşleştirme onayı sorarsa onayla.', 'connecting|MIDI bağlantısı hazırlanıyor… Windows eşleştirme onayı sorarsa onayla.'),
    'connected|MIDI bağlantısı hazır',
  ]);
  const ready = world.last();
  assert.deepStrictEqual([ready.connected, ready.uuid, ready.device, ready.input_capable, ready.output_capable, ready.browsing, ready.active, 'diagnostic' in ready],
    [true, uuid, 'CLP-835', true, true, false, true, false]);
  // the piano that connected is remembered under the key the earlier apps used
  assert.deepStrictEqual([world.settings.values, ready.remembered_device], [{ BluetoothDeviceUUID: uuid }, uuid]);

  // piano -> page: a chord with running status, the sustain pedal, then all notes off
  clp.play([0x80, 0x80, 0x90, 60, 100, 64, 90]);
  clp.play([0x80, 0x81, 0xB0, 64, 127, 0x82, 0xB0, 7, 100, 0x83, 0xC0, 5]);
  await wait(20);
  assert.deepStrictEqual(world.other(), [
    { event: 'note_on', channel: 1, note: 60, name: 'C4', velocity: 100 },
    { event: 'note_on', channel: 1, note: 64, name: 'E4', velocity: 90 },
    { event: 'pedal', channel: 1, controller: 64, value: 127, pedal: 'sustain', pressed: true },
  ]);
  assert.strictEqual(world.published.find(event => event.event === 'note_on').device_time_ms, 0);
  assert.strictEqual(typeof world.published.find(event => event.event === 'note_on').received_monotonic_seconds, 'number');
  assert.deepStrictEqual(world.bluetooth.held().map(note => note.note).sort(), [60, 64]);
  assert.deepStrictEqual([world.bluetooth.state.note_count, world.bluetooth.state.last_note.note, world.bluetooth.state.pedal.pressed], [2, 64, true]);
  clp.play([0x80, 0x80, 0x80, 60, 0, 0x81, 0xB0, 123, 0]);
  await wait(20);
  assert.deepStrictEqual(world.other().slice(3), [
    { event: 'note_off', channel: 1, note: 60, name: 'C4', velocity: 0 },
    { event: 'note_off', channel: 1, note: 64, name: 'E4', velocity: 0 },   // released by controller 123
  ]);
  assert.deepStrictEqual(world.bluetooth.held(), []);

  // page -> piano: a short lesson, stopped half way
  const reply = await world.bluetooth.command({ command: 'output-start', session: 'lesson', duration: 30,
    events: [[0, 0x93, 60, 80], [0, 0xB3, 64, 127], [0.05, 0x83, 60, 0], [0.05, 0x93, 62, 70], [20, 0x83, 62, 0]] });
  assert.strictEqual(reply.ok, true);
  assert.ok(Math.abs(reply.start_unix_ms - (Date.now() + 120)) < 50);
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'output-heartbeat', session: 'lesson' }), { ok: true });
  await world.rejects({ command: 'output-start', session: 'second', duration: 1, events: [] }, 'Önce mevcut piyano çalmasını durdur.');
  await wait(300);
  assert.deepStrictEqual(clp.written, [[0x93, 60, 80], [0xB3, 64, 127], [0x83, 60, 0], [0x93, 62, 70]]);

  // disconnect while a key and the pedal are down: both are released before the link closes
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'disconnect' }), {});
  assert.strictEqual(world.bluetooth.active, true);
  assert.strictEqual(world.last().phase, 'stopping');
  await world.rejects({ command: 'scan' }, 'Önce mevcut bağlantıyı kes.');
  await wait(250);
  assert.deepStrictEqual(clp.written.slice(4), [[0xB3, 64, 0], [0x83, 62, 0]]);
  assert.strictEqual(clp.device.gatt.connected, false);
  assert.deepStrictEqual(world.statuses.slice(-2), ['stopping|Bağlantı kapatılıyor…', 'disconnected|Piyano bağlantısı kapalı']);
  assert.deepStrictEqual([world.bluetooth.active, world.last().active, world.stopped, world.destroyed, world.last().output_capable], [false, false, 1, 1, false]);
});

test('a piano saved by the Mac app’s CoreBluetooth identifier is found by its hashed address', async () => {
  if (!MAC) return 'skipped: Mac only';
  const identifier = 'AF6E0481-C4E7-5B16-BFD5-23A18933854B';      // seen on the test Mac: Chromium listed it as 34:34:A2:98:33:B4
  assert.strictEqual(hashedAddress(identifier), '34:34:A2:98:33:B4');
  const world = rig({ settings: { language: 'tr', BluetoothDeviceUUID: identifier } });
  assert.strictEqual(world.bluetooth.state.remembered_device, identifier);
  const clp = piano('34:34:A2:98:33:B4', 'CLP-835'), other = piano('11:22:33:44:55:66', 'Other');
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'connect', uuid: identifier }), {});
  await wait(20);
  assert.deepStrictEqual(world.statuses.slice(-1), ['connecting|Seçilen piyano aranıyor…']);
  world.show([other]); await wait(10);
  assert.strictEqual(world.last().phase, 'connecting');
  world.show([other, clp]); await wait(30);
  assert.deepStrictEqual([world.last().phase, world.last().uuid, world.last().device], ['connected', identifier, 'CLP-835']);
  // the alias is stored as JSON text, beside whatever else the store holds
  assert.deepStrictEqual(world.settings.values,
    { language: 'tr', BluetoothDeviceUUID: identifier, BluetoothDeviceAliases: JSON.stringify({ '34:34:A2:98:33:B4': identifier }) });
  world.bluetooth.stop(); await wait(200);
  // a later scan lists that piano under the identifier the page saved
  const again = rig({ settings: world.settings.values });
  await again.bluetooth.command({ command: 'scan' }); await wait(20);
  again.show([clp]); await wait(20);
  assert.deepStrictEqual(again.last().devices.map(device => device.uuid), [identifier]);
  again.bluetooth.stop(); await wait(50);
});

test('Windows refuses an id that is not an address', async () => {
  if (MAC) return 'skipped: not the Mac';
  await rig().rejects({ command: 'connect', uuid: 'AF6E0481-C4E7-5B16-BFD5-23A18933854B' }, 'Listeden bir MIDI cihazı seç.');
});

test('scan deadline: idle, then connect from the list starts a fresh search', async () => {
  const world = rig({ timeoutSeconds: 0.15 }), clp = piano('AA:BB:CC:01:02:03', 'CLP-835');
  await world.bluetooth.command({ command: 'scan' }); await wait(20);
  world.show([clp]); await wait(250);
  assert.deepStrictEqual(world.statuses.slice(-1), ['idle|Tarama tamamlandı. Listeden bir piyano seç veya yeniden tara.']);
  assert.deepStrictEqual([world.bluetooth.active, world.last().active, world.pending, world.last().devices.length], [true, true, null, 1]);
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'connect', uuid: '00000000-0000-0000-0000-AABBCC010203' }), { ok: true });
  await wait(20);
  assert.deepStrictEqual(world.statuses.slice(-1), ['connecting|Seçilen piyano aranıyor…']);
  assert.strictEqual(world.searches, 2);
  world.show([clp]); await wait(30);
  assert.strictEqual(world.last().phase, 'connected');
  await wait(250);                                   // the deadline no longer applies once connected
  assert.strictEqual(world.last().phase, 'connected');
  world.bluetooth.stop(); await wait(200);
  assert.strictEqual(world.stopped, 1);
});

test('rescan while scanning; stopping a scan', async () => {
  const world = rig(), clp = piano('AA:BB:CC:01:02:03', 'CLP-835');
  await world.bluetooth.command({ command: 'scan' }); await wait(20);
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'scan' }), { ok: true });   // nothing reported yet: same search
  assert.strictEqual(world.searches, 1);
  world.show([clp]); await wait(20);
  assert.strictEqual(world.last().devices.length, 1);
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'scan' }), { ok: true });
  await wait(20);
  assert.deepStrictEqual([world.searches, world.last().devices.length, world.last().phase], [2, 0, 'scanning']);
  await world.bluetooth.command({ command: 'disconnect' }); await wait(20);
  assert.deepStrictEqual(world.statuses.slice(-2), ['stopping|Bağlantı kapatılıyor…', 'disconnected|Piyano bağlantısı kapalı']);
  assert.deepStrictEqual([world.pending, world.stopped, world.destroyed, world.other()], [null, 1, 1, []]);
});

test('a piano that never appears: piano_unreachable', async () => {
  const world = rig({ timeoutSeconds: 0.15 });
  await world.bluetooth.command({ command: 'connect', uuid: '00000000-0000-0000-0000-AABBCC010203' }); await wait(20);
  world.show([]); await wait(300);
  const status = world.last();
  assert.deepStrictEqual([status.phase, status.message, status.active], ['error', 'Bluetooth bağlantısı tamamlanamadı.', false]);
  assert.deepStrictEqual(status.diagnostic, { code: 'piano_unreachable', stage: 'scanning', deviceSeen: false, linkEstablished: false, cleanupConfirmed: true });
  assert.strictEqual(world.stopped, 1);
});

test('Chromium never reports: mac_bluetooth_unavailable; Chromium ends the search itself: the same', async () => {
  let world = rig({ timeoutSeconds: 0.15 });
  await world.bluetooth.command({ command: 'scan' }); await wait(300);
  assert.deepStrictEqual([world.last().phase, world.last().diagnostic.code, world.last().active], ['error', 'mac_bluetooth_unavailable', false]);
  world = rig({ refuse: failure('NotFoundError', 'User cancelled the requestDevice() chooser.') });
  await world.bluetooth.command({ command: 'scan' }); await wait(50);
  assert.deepStrictEqual([world.last().phase, world.last().diagnostic.code, world.stopped], ['error', 'mac_bluetooth_unavailable', 1]);
  world = rig({ refuse: failure('NotFoundError', 'User denied the browser permission to scan for Bluetooth devices.') });
  await world.bluetooth.command({ command: 'scan' }); await wait(50);
  assert.strictEqual(world.last().diagnostic.code, 'permission_denied');
  world = rig({ refuse: failure('NotFoundError', 'Bluetooth adapter not available.'), available: false });
  await world.bluetooth.command({ command: 'scan' }); await wait(50);
  assert.strictEqual(world.last().diagnostic.code, 'mac_bluetooth_unsupported');
  world = rig({ refuse: failure('SecurityError', 'Must be handling a user gesture to show a permission request.') });
  await world.bluetooth.command({ command: 'scan' }); await wait(50);
  assert.deepStrictEqual([world.last().diagnostic.code, world.last().diagnostic.domain], ['service_failed', 'SecurityError']);
});

test('failures while connecting carry the native diagnostic codes', async () => {
  const uuid = '00000000-0000-0000-0000-AABBCC010203';
  const attempt = async options => {
    const world = rig(), device = piano('AA:BB:CC:01:02:03', 'CLP-835', options);
    await world.bluetooth.command({ command: 'connect', uuid }); await wait(20);
    world.show([device]); await wait(250);
    assert.deepStrictEqual([world.last().phase, world.last().active, world.stopped, device.device.gatt.connected], ['error', false, 1, false]);
    return world.last().diagnostic;
  };
  assert.deepStrictEqual(await attempt({ noService: true }),
    { code: 'midi_service_missing', stage: 'discovering_midi_service', deviceSeen: true, linkEstablished: true, cleanupConfirmed: true });
  assert.deepStrictEqual(await attempt({ connectError: failure('NetworkError', 'Connection Error: Connection attempt failed.') }),
    { code: 'connect_failed', stage: 'connecting', deviceSeen: true, linkEstablished: false, domain: 'NetworkError', detail: 'Connection Error: Connection attempt failed.', cleanupConfirmed: true });
  assert.strictEqual((await attempt({ readError: failure('NetworkError', 'Authentication failed.') })).code, 'pairing_failed');
  const read = await attempt({ readError: failure('NetworkError', 'GATT operation failed for unknown reason.') });
  assert.deepStrictEqual([read.code, read.stage], ['midi_read_failed', 'authenticating_midi']);
});

test('the link drops; a broken packet; the window dies', async () => {
  const uuid = '00000000-0000-0000-0000-AABBCC010203';
  const connected = async () => {
    const world = rig(), device = piano('AA:BB:CC:01:02:03', 'CLP-835');
    await world.bluetooth.command({ command: 'connect', uuid }); await wait(20);
    world.show([device]); await wait(30);
    assert.strictEqual(world.last().phase, 'connected');
    return { world, device };
  };
  let { world, device } = await connected();
  device.play([0x80, 0x80, 0x90, 60, 100]); await wait(10);
  device.drop(); await wait(200);
  assert.deepStrictEqual(world.statuses.slice(-2), ['error|Bluetooth bağlantısı tamamlanamadı.', 'error|Bluetooth bağlantısı tamamlanamadı.']);
  assert.deepStrictEqual(world.last().diagnostic, { code: 'connection_lost', stage: 'listening', deviceSeen: true, linkEstablished: true, cleanupConfirmed: true });
  assert.deepStrictEqual([world.last().active, world.last().connected, world.bluetooth.held(), world.stopped], [false, false, [], 1]);

  ({ world, device } = await connected());
  device.play([0x80, 0x80, 0x90, 60, 100, 0x81, 0x90, 61]); await wait(200);
  const diagnostic = world.last().diagnostic;
  assert.deepStrictEqual([diagnostic.code, diagnostic.domain, diagnostic.osCode, diagnostic.detail], ['invalid_ble_midi', 'Rach3.BLEMIDI', 1, 'Truncated MIDI message (byte 7)']);
  assert.strictEqual(world.stopped, 1);

  ({ world, device } = await connected());
  world.crash(); await wait(20);
  assert.deepStrictEqual([world.last().phase, world.last().message, world.last().diagnostic, world.last().active, world.stopped],
    ['error', 'Bluetooth bağlantı servisi kapandı.', { code: 'service_failed', osCode: 5 }, false, 1]);
  // and it starts again afterwards
  assert.deepStrictEqual(await world.bluetooth.command({ command: 'scan' }), {});
  await wait(20);
  assert.deepStrictEqual([world.last().phase, 'diagnostic' in world.last(), world.windows], ['scanning', false, 2]);
  world.bluetooth.stop(); await wait(20);
});

(async () => {
  let number = 0;
  for (const [name, body] of tests) {
    const note = await body();
    console.log(`ok ${++number} - ${name}${note ? ` # ${note}` : ''}`);
  }
  console.log(`${number} tests passed`);
})().catch(error => { console.error(error); process.exit(1); });
