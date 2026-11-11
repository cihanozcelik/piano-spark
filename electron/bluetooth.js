// The Bluetooth piano connection for Mac and Windows: one implementation over Web Bluetooth
// in a hidden window. It replaces the Mac helper (bluetooth-connection/main.m) together with
// the Bluetooth parts of desktop/main.m, and windows/Rach3/Bluetooth.cs + BleTransport.cs,
// and publishes the same events and state to the page.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TIMEOUT_SECONDS = 45;
const PARTITION = 'rach3-bluetooth';          // in memory, apart from the page's session
const HOST = 'bluetooth.rach3.invalid';       // answered by this file, never by the network
const HTML = '<!doctype html><meta charset="utf-8"><title>rach3 Bluetooth</title><script src="bluetooth-page.js"></script>';
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const trace = process.env.RACH3_BLUETOOTH_DEBUG ? (...values) => console.error('bluetooth:', ...values) : () => {};

// The two places where the systems differ.
// 1. Wording: the Windows app's source strings for the messages that name the Mac.
const WINDOWS_TEXT = process.platform !== 'win32' ? {} : {
  'Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla.': 'Bilgisayarın Bluetooth erişimi kontrol ediliyor…',
  'Mac’in Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.': 'Bilgisayarın Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.',
  'MIDI bağlantısı hazırlanıyor… macOS eşleştirme onayı sorarsa onayla.': 'MIDI bağlantısı hazırlanıyor… Windows eşleştirme onayı sorarsa onayla.',
  'macOS bağlantının kapandığını doğrulamadı.': 'Windows bağlantının kapandığını doğrulamadı.',
  'Mac’in Bluetooth servisi hazır değil.': 'Bilgisayarın Bluetooth servisi hazır değil.',
};
// 2. Device ids. Chromium names a device by its Bluetooth address. On Windows that is the
// real address, which the Windows app already showed the page as 00000000-0000-0000-0000-<address>.
// On the Mac it is the first six bytes of SHA-256 of the CoreBluetooth identifier, so a piano
// the Mac app saved by that identifier can still be recognized, one way.
const HASHED_ADDRESSES = process.platform === 'darwin';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ADDRESS_PREFIX = '00000000-0000-0000-0000-';
const ADDRESS = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

// The id the page sees for a Chromium device id that no saved CoreBluetooth identifier matches.
function plainIdentifier(deviceId) {
  const id = String(deviceId);
  if (ADDRESS.test(id)) return ADDRESS_PREFIX + id.replace(/[:-]/g, '').toUpperCase();
  const hex = crypto.createHash('sha256').update(id).digest('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Chromium's address for a CoreBluetooth peripheral identifier (BluetoothLowEnergyDeviceMac).
function hashedAddress(identifier) {
  return crypto.createHash('sha256').update(identifier.toUpperCase()).digest('hex').slice(0, 12).toUpperCase().match(/../g).join(':');
}

// The page event for one MIDI message, as the native helpers word it.
function midiEvent(status, first, second, timestamp, received) {
  const kind = status & 0xF0;
  const value = { channel: (status & 15) + 1, device_time_ms: timestamp, received_monotonic_seconds: received };
  if (kind === 0x80 || kind === 0x90) {
    Object.assign(value, { note: first, name: NOTES[first % 12] + (Math.floor(first / 12) - 1), velocity: second });
    return [kind === 0x90 && second !== 0 ? 'note_on' : 'note_off', value];
  }
  if (kind === 0xB0) {
    Object.assign(value, { controller: first, value: second });
    if (first !== 64 && first !== 66 && first !== 67) return ['control_change', value];
    Object.assign(value, { pedal: first === 64 ? 'sustain' : first === 66 ? 'sostenuto' : 'soft', pressed: second >= 64 });
    return ['pedal', value];
  }
  Object.assign(value, { status, data1: first, data2: second });
  return ['midi_message', value];
}

// The hidden window. events: loaded(), failed(message, code), gone(reason, code),
// message(object), chooser(devices, callback), pairing(deviceId) -> allow.
function electronHost(events) {
  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition(PARTITION);
  if (!ses.protocol.isProtocolHandled('https')) {
    ses.protocol.handle('https', request => {
      const url = new URL(request.url);
      const headers = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'" };
      if (url.host === HOST && url.pathname === '/')
        return new Response(HTML, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
      if (url.host === HOST && url.pathname === '/bluetooth-page.js')
        return new Response(fs.readFileSync(path.join(__dirname, 'bluetooth-page.js')), { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } });
      return new Response('', { status: 404 });
    });
    ses.setPermissionRequestHandler((contents, permission, done) => done(false));
  }
  // Windows asks here when the piano wants pairing; macOS pairs by itself. rach3 has no
  // place to type a PIN, so only pairings that need a plain yes are accepted.
  if (typeof ses.setBluetoothPairingHandler === 'function')
    ses.setBluetoothPairingHandler((details, done) => {
      trace('pairing', details.pairingKind, details.deviceId);
      done({ confirmed: details.pairingKind !== 'providePin' && events.pairing(details.deviceId) });
    });

  const window = new BrowserWindow({
    show: false, width: 320, height: 200, skipTaskbar: true, title: 'rach3 Bluetooth',
    webPreferences: {
      partition: PARTITION, preload: path.join(__dirname, 'preload-bluetooth.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false,            // lesson playback is timed by this window's 5 ms tick
    },
  });
  const contents = window.webContents;
  let open = true;
  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    let used = false;
    events.chooser(devices, deviceId => { if (!used) { used = true; callback(deviceId); } });
  });
  contents.ipc.on('rach3-bluetooth', (event, message) => {
    if (event.senderFrame !== contents.mainFrame || !message || typeof message !== 'object') return;
    try { events.message(message); } catch (error) { trace('message', error.message); }
  });
  contents.on('did-finish-load', () => events.loaded());
  contents.on('did-fail-load', (event, code, description, url, mainFrame) => { if (mainFrame) events.failed(description, code); });
  contents.on('render-process-gone', (event, details) => events.gone(details.reason, details.exitCode || 1));
  contents.on('will-navigate', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => { if (open) { open = false; events.gone('closed', 0); } });
  window.loadURL(`https://${HOST}/`).catch(() => {});   // did-fail-load reports it
  return {
    // requestDevice needs a user gesture; the second argument stands in for one.
    search: id => contents.executeJavaScript(`rach3BluetoothPage.request(${Number(id)}); undefined`, true),
    send: message => { if (open) contents.send('rach3-bluetooth', message); },
    destroy: () => { if (open) { open = false; window.destroy(); } },
  };
}

// One run of the connection, from start to stopped: the role of the Mac's helper process.
// emit(event) receives what the helper printed; exited(code) what its exit meant.
function createConnection({ identifier, timeoutSeconds, openHost, identifierOf, emit: deliver, exited }) {
  let browsing = !identifier, phase = 'starting', target = '', peripheral = null;
  let chooser = null, chooserSeen = false, loaded = false, searches = 0, commands = 0;
  let ready = false, stopping = false, finished = false, linkEstablished = false, deviceSeen = false;
  let diagnostic = null, stopReason = 'stopped', exitCode = 0, deadline = null, cleanup = null;
  const names = new Map(), lastAdvertisement = new Map(), replies = new Map();

  const emit = (event, details) => deliver({ ...details, event, time_unix: Date.now() / 1000 });
  const wanted = deviceId => Boolean(identifier) && (identifierOf(deviceId) === identifier || plainIdentifier(deviceId) === identifier);

  function issue(code, error) {
    if (diagnostic) return; // Cleanup must not erase the original cause.
    diagnostic = { code, stage: phase, deviceSeen, linkEstablished };
    if (error) {
      diagnostic.domain = error.name;
      if (error.code !== undefined) diagnostic.osCode = error.code;
      diagnostic.detail = error.message;
    }
    emit('connection_issue', { diagnostic: { ...diagnostic } });
  }

  function fail(operation, error) {
    if (stopping) return;
    issue('service_failed', { name: String((error && error.name) || 'Error'), message: String((error && error.message) || error) });
    stop(operation, 1);
  }

  // Discovery and connection share one deadline.
  function armDeadline() {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (stopping || ready) return;
      if (browsing && chooserSeen) {
        cancelSearch(); phase = 'idle';
        emit('scan_complete', {}); return;
      }
      stop(!chooserSeen ? 'mac_bluetooth_unavailable' : linkEstablished ? 'midi_timeout' : 'piano_unreachable', 3);
    }, timeoutSeconds * 1000);
  }

  function cancelSearch() {
    const current = chooser;
    chooser = null;
    if (current && current.callback) current.callback('');
  }

  function advertise(deviceId) {
    const now = Date.now();
    if (lastAdvertisement.has(deviceId) && now - lastAdvertisement.get(deviceId) < 1000) return;
    lastAdvertisement.set(deviceId, now);
    emit('discovered', { name: names.get(deviceId) || 'Bluetooth MIDI', uuid: identifierOf(deviceId) });
  }

  function scan() {
    phase = 'scanning';
    lastAdvertisement.clear();
    emit('scanning', { browsing });
    // A search that has reported nothing yet has nothing stale in it: let it continue.
    if (chooser && !chooser.callback) return;
    cancelSearch();
    chooser = { id: ++searches, callback: null, devices: [], chosen: false };
    trace('search', chooser.id);
    Promise.resolve(host.search(chooser.id)).catch(error => fail('bluetooth_start', error));
  }

  function connect(deviceId) {
    peripheral = { id: deviceId, uuid: identifierOf(deviceId) };
    target = names.get(deviceId) || 'Bluetooth MIDI';
    phase = 'connecting';
    emit('connecting', { name: target, uuid: peripheral.uuid });
    const choose = chooser.callback;
    chooser.callback = null; chooser.chosen = true;
    choose(deviceId);
  }

  // select-bluetooth-device: Chromium repeats the whole list as devices appear and change.
  function chosen(devices, callback) {
    trace('devices', JSON.stringify(devices));
    if (chooser && chooser.chosen) return;                 // already answered with a device
    if (!chooser || stopping || finished) { callback(''); return; }
    chooserSeen = true;
    chooser.callback = callback;
    chooser.devices = devices.map(device => String(device.deviceId));
    for (const device of devices) {
      // Chromium invents a label that contains the address for a device without a name.
      const name = String(device.deviceName || '').trim();
      names.set(String(device.deviceId), name.includes(String(device.deviceId)) ? '' : name);
    }
    if (peripheral || phase !== 'scanning') return;
    if (browsing) { for (const deviceId of chooser.devices) advertise(deviceId); return; }
    const found = chooser.devices.find(wanted);
    if (found === undefined) return;
    deviceSeen = true;
    connect(found);
  }

  function command(request) {
    if (stopping) return { error: 'Bağlantı kapanıyor; tamamlanmasını bekle.' };
    if (request.command === 'scan') {
      if (peripheral) return { error: 'Yeni tarama için önce mevcut bağlantıyı kes.' };
      if (!loaded) return { error: 'Mac’in Bluetooth servisi hazır değil.' };
      browsing = true; identifier = null; target = '';
      armDeadline(); scan(); return { ok: true };
    }
    if (request.command === 'connect') {
      if (peripheral) return { error: 'Önce mevcut bağlantıyı kes.' };
      if (!loaded) return { error: 'Mac’in Bluetooth servisi hazır değil.' };
      identifier = request.uuid; browsing = false;
      armDeadline();
      const known = phase === 'scanning' && chooser && chooser.callback ? chooser.devices.find(wanted) : undefined;
      if (known !== undefined) connect(known); else scan();
      return { ok: true };
    }
    if (!ready) return { error: 'Piyano bağlı değil.' };
    return new Promise(resolve => {
      const id = ++commands;
      const timer = setTimeout(() => { replies.delete(id); resolve(null); }, 3000);
      replies.set(id, value => { clearTimeout(timer); replies.delete(id); resolve(value); });
      host.send({ type: 'command', id, request });
    });
  }

  function receive(message) {
    if (finished) return;
    if (message.type !== 'midi') trace('page', JSON.stringify(message));
    switch (message.type) {
      case 'request-failed': {
        if (!chooser || message.request !== chooser.id) return;   // a search this side cancelled
        const picked = chooser.chosen, error = message.error || {};
        chooser = null;
        if (stopping) return;
        if (picked) { issue('connect_failed', error); stop('connect_failed', 1); }
        else if (error.name !== 'NotFoundError') fail('bluetooth_start', error);
        else if (/denied/i.test(error.message)) stop('permission_denied', 4);
        else if (message.available === false || /adapter not available/i.test(error.message)) stop('mac_bluetooth_unsupported', 4);
        // Chromium ends the search by itself when Bluetooth is off or cannot scan, and does not say which.
        else stop('mac_bluetooth_unavailable', 4);
        return;
      }
      case 'reply': { const reply = replies.get(message.id); if (reply) reply(message.value); return; }
      case 'output-error': emit('output_error', { message: String(message.message) }); return;
      case 'closed': if (stopping) finish(!message.connected); return;
    }
    if (stopping || !peripheral) return;
    switch (message.type) {
      case 'chosen': if (message.name) target = String(message.name); return;
      case 'linked':
        linkEstablished = true; phase = 'discovering_midi_service';
        emit('midi_discovery', {}); return;
      case 'characteristic':
        phase = 'authenticating_midi';
        emit('midi_initial_read', { properties: message.properties }); return;
      case 'handshake':
        emit('midi_handshake_complete', { bytes: message.bytes });
        phase = 'subscribing'; return;
      case 'ready':
        ready = true; phase = 'listening';
        clearTimeout(deadline);
        if (message.name) target = String(message.name);
        emit('ready', { name: target, target, input_capable: true, uuid: peripheral.uuid, output_capable: Boolean(message.output_capable) });
        return;
      case 'failed': {
        const error = message.error || {}, missing = error.name === 'NotFoundError';
        const pairing = /auth|pair|encrypt|not permitted|not authorized/i.test(error.message);
        if (message.stage === 'connect') { issue(pairing ? 'pairing_failed' : 'connect_failed', error); stop('connect_failed', 1); }
        else if (message.stage === 'service') {
          if (!missing) issue('midi_discovery_failed', error);
          stop(missing ? 'midi_service_missing' : 'discover_services', 1);
        } else if (message.stage === 'characteristic') {
          if (!missing) issue('midi_discovery_failed', error);
          stop(missing ? 'midi_characteristic_missing' : 'discover_characteristics', 1);
        } else if (message.stage === 'read') { issue(pairing ? 'pairing_failed' : 'midi_read_failed', error); stop('midi_read_failed', 1); }
        else { issue('midi_subscription_failed', error); stop('midi_subscription_failed', 1); }
        return;
      }
      case 'link-lost':
        issue('connection_lost'); stop('bluetooth_disconnected', 5); return;
      case 'midi':
        for (const [status, first, second, timestamp] of message.messages) {
          if (stopping) return;
          emit(...midiEvent(status, first, second, timestamp, message.received));
        }
        return;
      case 'invalid':
        issue('invalid_ble_midi', { name: 'Rach3.BLEMIDI', code: 1, message: String(message.detail) });
        stop('invalid_ble_midi', 1); return;
    }
  }

  function stop(reason, code) {
    if (stopping || finished) return;
    if (code !== 0) issue(reason);
    stopping = true; phase = 'stopping';
    stopReason = reason; exitCode = code;
    clearTimeout(deadline);
    cancelSearch();
    if (!peripheral || !loaded) { finish(true); return; }
    phase = 'disconnecting';
    cleanup = setTimeout(() => {
      issue('disconnect_unconfirmed');
      if (!exitCode) exitCode = 1;
      finish(false);
    }, 4000);
    // The page releases held notes and the sustain pedal, then closes its link and answers.
    host.send({ type: 'close' });
  }

  function finish(closed) {
    if (finished) return;
    finished = true;
    clearTimeout(cleanup); clearTimeout(deadline);
    const result = { reason: stopReason, exit_code: exitCode, pid: process.pid, own_connection_closed: closed };
    if (diagnostic) result.diagnostic = { ...diagnostic, cleanupConfirmed: closed };
    host.destroy();   // closing the window ends anything Chromium still holds
    emit('stopped', result);
    setImmediate(() => exited(exitCode));
  }

  // The window died or was closed from outside: the helper process exiting on its own.
  function gone(reason, code) {
    if (finished) return;
    trace('window gone', reason, code);
    finished = true; stopping = true;
    clearTimeout(cleanup); clearTimeout(deadline);
    host.destroy();
    setImmediate(() => exited(code));
  }

  const host = openHost({
    loaded() { if (loaded || stopping || finished) return; loaded = true; scan(); },
    failed(message, code) { if (finished) return; emit('error', { operation: 'window', message: String(message), code }); gone('load', 1); },
    gone,
    message: receive,
    chooser: chosen,
    pairing: deviceId => Boolean(peripheral) && !stopping && String(deviceId) === peripheral.id,
  });
  emit('started', { pid: process.pid, target: '', transport: 'BLE MIDI' });
  armDeadline();
  return { command, stop };
}

// settings: the store from electron/settings.js, get(key) and set(key, value).
function createBluetooth({ text, settings, publish, onStopped, timeoutSeconds = TIMEOUT_SECONDS, openHost = electronHost }) {
  const say = source => text(WINDOWS_TEXT[source] || source);
  const stored = key => { try { return settings.get(key); } catch (error) { trace('settings', error.message); return null; } };
  const store = (key, value) => { try { settings.set(key, value); } catch (error) { trace('settings', error.message); } };
  // The last piano that connected, under the key both earlier apps used.
  const savedDevice = stored('BluetoothDeviceUUID');
  const remembered = typeof savedDevice === 'string' && savedDevice ? savedDevice : null;
  const state = {
    phase: 'disconnected', connected: false, message: say('Piyano bağlı değil'), device: '', uuid: null, devices: [],
    input_capable: false, note_count: 0, last_note: null, pedal: null, active: false, remembered_device: remembered,
  };
  const held = new Map();
  let session = null;

  // Chromium address -> the CoreBluetooth identifier the page knows that piano by (Mac only).
  const aliases = new Map(), confirmed = new Map();
  const alias = identifier => {
    if (HASHED_ADDRESSES && !identifier.startsWith(ADDRESS_PREFIX)) aliases.set(hashedAddress(identifier), identifier);
  };
  // Kept as JSON text: the Mac's store holds text only.
  let savedAliases = stored('BluetoothDeviceAliases');
  if (typeof savedAliases === 'string') { try { savedAliases = JSON.parse(savedAliases); } catch (error) { savedAliases = null; } }
  if (savedAliases && typeof savedAliases === 'object')
    for (const [address, identifier] of Object.entries(savedAliases))
      if (HASHED_ADDRESSES && ADDRESS.test(address) && typeof identifier === 'string' && UUID.test(identifier)) {
        aliases.set(address.toUpperCase(), identifier.toUpperCase()); confirmed.set(address.toUpperCase(), identifier.toUpperCase());
      }
  if (remembered && UUID.test(remembered)) alias(remembered.toUpperCase());
  const identifierOf = deviceId => aliases.get(String(deviceId).toUpperCase()) || plainIdentifier(deviceId);

  // A piano that connected is remembered, with its CoreBluetooth identifier if it came by one.
  function remember(identifier) {
    if (typeof identifier !== 'string' || !identifier) return;
    if (state.remembered_device !== identifier) {
      state.remembered_device = identifier;
      store('BluetoothDeviceUUID', identifier);
    }
    for (const [address, known] of aliases) {
      if (known !== identifier || confirmed.get(address) === identifier) continue;
      confirmed.set(address, identifier);
      store('BluetoothDeviceAliases', JSON.stringify(Object.fromEntries(confirmed)));
    }
  }

  const status = () => publish({ event: 'status', status: { ...state } });

  function setPhase(phase, message) {
    const connected = phase === 'connected';
    Object.assign(state, { phase, connected, message });
    if (!connected) { held.clear(); state.pedal = null; state.output_capable = false; state.input_capable = false; }
    status();
  }

  function start(identifier) {
    if (session) return;
    state.active = true;
    delete state.diagnostic;
    state.note_count = 0;
    state.last_note = null;
    state.uuid = identifier || null;
    state.device = ''; state.devices = [];
    state.browsing = !identifier;
    setPhase('starting', say('Mac’in Bluetooth erişimi kontrol ediliyor… macOS izin sorarsa onayla.'));
    const current = {};
    session = current;
    try {
      current.connection = createConnection({
        identifier, timeoutSeconds, openHost, identifierOf,
        emit: event => { if (session === current) handle(event); },
        exited: code => exit(current, code),
      });
    } catch (error) {
      session = null;
      state.active = false;
      state.diagnostic = { code: 'service_failed', detail: error.message };
      setPhase('error', error.message);
    }
  }

  function exit(finished, code) {
    if (session !== finished) return;
    session = null;
    state.active = false;
    if (state.phase === 'error') setPhase('error', state.message);
    else if (code !== 0) {
      state.diagnostic = { code: 'service_failed', osCode: code };
      setPhase('error', say('Bluetooth bağlantı servisi kapandı.'));
    } else setPhase('disconnected', say('Piyano bağlantısı kapalı'));
    onStopped();
  }

  function handle(event) {
    const kind = event.event;
    if (kind === 'output_error') { publish(event); return; }
    if (kind === 'connection_issue' || (kind === 'stopped' && event.diagnostic)) {
      state.diagnostic = event.diagnostic;
      setPhase('error', say('Bluetooth bağlantısı tamamlanamadı.')); return;
    }
    if (kind === 'error') {
      if (!state.diagnostic) state.diagnostic = { code: 'service_failed', detail: event.message || '',
        stage: event.operation || '', osCode: event.code === undefined ? null : event.code };
      setPhase('error', event.message || say('Bluetooth bağlantısında hata oluştu'));
    } else if (kind === 'stopped') {
      if (!event.own_connection_closed) {
        state.diagnostic = { code: 'disconnect_unconfirmed' };
        setPhase('error', say('macOS bağlantının kapandığını doğrulamadı.'));
      }
    } else if (state.phase === 'stopping') {
      return;
    } else if (kind === 'ready') {
      delete state.diagnostic;
      state.output_capable = event.output_capable || false;
      state.uuid = event.uuid;
      state.device = event.name || 'Bluetooth MIDI';
      state.input_capable = event.input_capable === undefined ? true : event.input_capable;
      remember(event.uuid);
      setPhase('connected', say('MIDI bağlantısı hazır'));
    } else if (kind === 'discovered') {
      state.devices = [...state.devices.filter(device => device.uuid !== event.uuid), event];
      status();
    } else if (kind === 'scan_complete') {
      setPhase('idle', say('Tarama tamamlandı. Listeden bir piyano seç veya yeniden tara.'));
    } else if (kind === 'connection_timeout') {
      setPhase('error', say('Piyanoya ulaşılamadı. Piyanonun açık ve Bluetooth’un etkin olduğunu kontrol et.'));
    } else if (kind === 'disconnected') {
      setPhase('disconnected', say('Piyano bağlantısı kesildi'));
    } else if (kind === 'scanning') {
      state.devices = []; state.browsing = event.browsing || false;
      setPhase(state.browsing ? 'scanning' : 'connecting',
        say(state.browsing ? 'Yakındaki Bluetooth MIDI cihazları aranıyor…' : 'Seçilen piyano aranıyor…'));
    } else if (kind === 'bluetooth_waiting') {
      setPhase('starting', say('Mac’in Bluetooth servisi hazırlanıyor; henüz piyanoya bağlantı kurulmadı.'));
    } else if (kind === 'midi_discovery') {
      setPhase('connecting', say('Piyanoya Bluetooth bağlantısı kuruldu. MIDI hizmeti kontrol ediliyor…'));
    } else if (kind === 'connecting') {
      state.uuid = event.uuid; state.device = event.name;
      state.browsing = false;
      setPhase('connecting', say('Seçilen piyanoya bağlanılıyor…'));
    } else if (kind === 'midi_initial_read') {
      setPhase('connecting', say('MIDI bağlantısı hazırlanıyor… macOS eşleştirme onayı sorarsa onayla.'));
    } else if (state.connected) {
      const key = `${event.channel === undefined ? 1 : event.channel}:${event.note}`;
      if (kind === 'note_on' && event.velocity > 0) {
        held.set(key, event);
        state.note_count += 1;
        state.last_note = event;
        publish(event);
      } else if (kind === 'note_off' || kind === 'note_on') {
        held.delete(key); publish(event);
      } else if (kind === 'pedal') {
        if (event.pedal === 'sustain') state.pedal = event;
        publish(event);
      } else if (kind === 'control_change' && (event.controller === 120 || event.controller === 123)) {
        for (const [heldKey, note] of [...held]) {
          if (note.channel !== event.channel) continue;
          held.delete(heldKey);
          publish({ ...note, event: 'note_off', velocity: 0 });
        }
      }
    }
  }

  function stop() {
    if (!session) return;
    setPhase('stopping', say('Bağlantı kapatılıyor…'));
    session.connection.stop('terminate', 0);
  }

  // What the helper answered, as the Mac's reply handler passed it on.
  async function answered(reply) {
    const result = await reply;
    if (!result) throw new Error(say('Piyano çalma komutuna yanıt alınamadı.'));
    if (result.error) throw new Error(say(result.error));
    return result;
  }

  async function command(body) {
    const name = body && body.command;
    if (name === 'connect' || name === 'scan') {
      let identifier = null;
      if (name === 'connect') {
        const raw = body.uuid;
        identifier = typeof raw === 'string' && UUID.test(raw) ? raw.toUpperCase() : null;
        // Only the Mac has ids that are not an address (see HASHED_ADDRESSES).
        if (identifier && !HASHED_ADDRESSES && !identifier.startsWith(ADDRESS_PREFIX)) identifier = null;
        if (!identifier) throw new Error(say('Listeden bir MIDI cihazı seç.'));
        alias(identifier);
      }
      if (!session) { start(identifier); return {}; }
      if (!['scanning', 'idle'].includes(state.phase)) throw new Error(say('Önce mevcut bağlantıyı kes.'));
      return answered(session.connection.command(identifier ? { command: 'connect', uuid: identifier } : { command: 'scan' }));
    }
    if (name === 'disconnect') { stop(); return {}; }
    if (['output-start', 'output-stop', 'output-heartbeat'].includes(name)) {
      if (!state.connected || !session) throw new Error(say('Piyano bağlı değil.'));
      return answered(session.connection.command(body));
    }
    throw new Error('Unknown command');
  }

  return {
    state,
    held: () => [...held.values()],
    get active() { return session !== null; },
    command,
    stop,
  };
}

module.exports = { createBluetooth, midiEvent, plainIdentifier, hashedAddress };
