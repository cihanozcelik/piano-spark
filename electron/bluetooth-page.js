// The hidden window's script: the Web Bluetooth side of the piano connection.
// electron/bluetooth.js drives it over rach3BluetoothHost. The BLE-MIDI decoder and the
// scheduled output are ports of bluetooth-connection/BLEMIDI.m and BLEMIDIOutput.m.
// The same file loads in plain Node, where the tests exercise it without a piano.
(function (root) {
  'use strict';

  const SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
  const CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';

  // decode(bytes, handler) calls handler(status, first, second, timestamp) for each MIDI
  // message and returns null, or the reason the packet is not BLE-MIDI.
  function createDecoder() {
    let sysex = false;
    return function decode(bytes, handler) {
      const length = bytes.length;
      if (!length) return null;
      const invalid = (message, position) => { sysex = false; return `${message} (byte ${position})`; };
      if ((bytes[0] & 0xC0) !== 0x80) return invalid('Invalid BLE-MIDI header', 0);
      let high = bytes[0] & 0x3F, running = 0, previousLow = -1, timestamp = 0, timestampRequired = true, position = 1;
      while (position < length) {
        // Only SysEx may continue across packets. Its payload is deliberately not retained.
        if (sysex && bytes[position] < 0x80) { position++; continue; }
        const hasTimestamp = bytes[position] >= 0x80;
        if (hasTimestamp) {
          const low = bytes[position++] & 0x7F;
          if (previousLow >= 0 && low < previousLow) high = (high + 1) & 0x3F;
          previousLow = low;
          timestamp = (high << 7) | low;
          if (position === length) return invalid('Timestamp without MIDI message', position);
        } else if (timestampRequired) return invalid('Missing MIDI timestamp', position);
        let status;
        if (bytes[position] >= 0x80) {
          if (!hasTimestamp) return invalid('Status without timestamp', position);
          status = bytes[position++];
        } else {
          if (!running || sysex) return invalid('Running status without a channel message', position);
          status = running;
        }
        if (sysex) {
          if (status === 0xF7) sysex = false;
          else if (status < 0xF8) return invalid('Unexpected status inside SysEx', position - 1);
          timestampRequired = true;
          continue;
        }
        if (status === 0xF0) { sysex = true; timestampRequired = true; continue; }
        // Timing clock/active sensing are not piano key or pedal events.
        if (status >= 0xF8) { timestampRequired = true; continue; }
        let count;
        if (status < 0xF0) {
          running = status;
          const kind = status & 0xF0;
          count = kind === 0xC0 || kind === 0xD0 ? 1 : 2;
          timestampRequired = false;
        } else {
          count = status === 0xF2 ? 2 : (status === 0xF1 || status === 0xF3 ? 1 : 0);
          timestampRequired = true;
        }
        if (position + count > length) return invalid('Truncated MIDI message', position);
        for (let i = 0; i < count; i++)
          if (bytes[position + i] >= 0x80) return invalid('Status inside MIDI data', position + i);
        const first = count ? bytes[position] : 0, second = count > 1 ? bytes[position + 1] : 0;
        position += count;
        handler(status, first, second, timestamp);
      }
      return null;
    };
  }

  // One MIDI message in one packet, stamped with the low 13 bits of a millisecond clock.
  function encode(status, first, second, milliseconds) {
    const timestamp = Math.floor(milliseconds) % 8192;
    return Uint8Array.of(0x80 | (timestamp >> 7), 0x80 | (timestamp & 127), status, first, second);
  }

  // Lesson playback to the piano. link: now() in seconds, connected(), writable(),
  // canSend(), send(packet), onError(message); every: start/stop of the 5 ms tick.
  function createOutput(link) {
    const held = Array.from({ length: 16 }, () => new Uint32Array(128));
    const used = new Array(16).fill(false);
    const every = link.every || {
      start: tick => setInterval(tick, 5),
      stop: handle => clearInterval(handle),
    };
    let events = null, releases = null, index = 0, releaseIndex = 0, session = null, timer = null;
    let anchor = 0, lease = 0, end = 0;

    const drained = () => !releases || releaseIndex >= releases.length;
    const startTimer = () => { if (timer === null) timer = every.start(flush); };
    const stopTimer = () => { if (timer !== null) { every.stop(timer); timer = null; } };
    const error = message => ({ error: message });

    function command(request) {
      const kind = request.command, wanted = request.session;
      if (typeof wanted !== 'string' || !wanted.length || wanted.length > 80) return error('Geçersiz çalma oturumu.');
      if (kind === 'output-stop') { if (session === wanted) stop(); return { ok: true }; }
      if (kind === 'output-heartbeat') { if (session === wanted) lease = link.now(); return { ok: true }; }
      if (kind !== 'output-start') return error('Geçersiz MIDI çıkış komutu.');
      if (session || !drained()) return error('Önce mevcut piyano çalmasını durdur.');
      if (!link.connected() || !link.writable()) return error('Bu bağlantıda MIDI gönderimi hazır değil.');
      const list = request.events;
      const duration = request.duration == null ? 0 : request.duration;
      if (!Array.isArray(list) || list.length > 100000 || typeof duration !== 'number' ||
          !Number.isFinite(duration) || duration < 0 || duration > 86400)
        return error('Ders MIDI çıkışı için çok büyük veya geçersiz.');
      let previous = -1;
      for (const item of list) {
        if (!Array.isArray(item) || item.length !== 4) return error('Geçersiz MIDI olayı.');
        for (const value of item) if (typeof value !== 'number') return error('Geçersiz MIDI değeri.');
        const [at, status, first, second] = item, type = status & 0xF0;
        if (!Number.isFinite(at) || at < previous || at < 0 || at > duration ||
            !Number.isInteger(status) || !Number.isInteger(first) || !Number.isInteger(second) ||
            (type !== 0x80 && type !== 0x90 && type !== 0xB0) ||
            status > 255 || status < 0 || first < 0 || first > 127 || second < 0 || second > 127 ||
            (type === 0xB0 && first !== 64)) return error('Desteklenmeyen MIDI olayı.');
        previous = at;
      }
      events = list; index = 0; session = wanted;
      lease = link.now(); anchor = lease + .12; end = duration;
      startTimer();
      return { ok: true, start_unix_ms: (link.unix ? link.unix() : Date.now()) + 120 };
    }

    function write(event) {
      const status = event[1], first = event[2], second = event[3];
      const channel = status & 15, type = status & 0xF0;
      if (type === 0x80 || (type === 0x90 && !second)) {
        if (held[channel][first] > 1) { held[channel][first]--; return; }
        held[channel][first] = 0;
      } else if (type === 0x90) held[channel][first]++;
      used[channel] = true;
      link.send(encode(status, first, second, link.now() * 1000));
    }

    function flush() {
      if (!link.connected()) { stopTimer(); session = null; events = null; releases = null; releaseIndex = 0; return; }
      const now = link.now();
      if (session && now - lease > 2) {
        stop(); link.onError('Çalma sayfasıyla iletişim kesildi; piyano çalması durduruldu.'); return;
      }
      while (!drained() && link.canSend()) write(releases[releaseIndex++]);
      if (!drained()) return;
      if (releases) { releases = null; releaseIndex = 0; used.fill(false); }
      if (!session) { stopTimer(); return; }
      const time = now - anchor;
      if (index < events.length && time - events[index][0] > .35) {
        stop(); link.onError('Bluetooth MIDI gönderimi gecikti; çalma durduruldu.'); return;
      }
      while (index < events.length && events[index][0] <= time && link.canSend()) write(events[index++]);
      if (index === events.length && time >= end) stop();
    }

    // Ends the lesson and queues what silences the piano: sustain up and every held key.
    function stop() {
      session = null; events = null;
      const pending = [];
      for (let channel = 0; channel < 16; channel++) {
        if (!used[channel]) continue;
        pending.push([0, 0xB0 | channel, 64, 0]);
        for (let pitch = 0; pitch < 128; pitch++) {
          if (!held[channel][pitch]) continue;
          held[channel][pitch] = 1;
          pending.push([0, 0x80 | channel, pitch, 0]);
        }
      }
      releases = pending; releaseIndex = 0;
      startTimer(); flush();
    }

    // Web Bluetooth reports a write the system refused; CoreBluetooth never did.
    function failed() {
      if (!session) return;
      stop(); link.onError('Bluetooth MIDI gönderimi gecikti; çalma durduruldu.');
    }

    return { command, flush, stop, failed, drained, playing: () => session !== null };
  }

  // CBCharacteristicProperties, the number the Mac helper reports in midi_initial_read.
  function propertyMask(properties) {
    const bits = [['broadcast', 1], ['read', 2], ['writeWithoutResponse', 4], ['write', 8], ['notify', 16],
      ['indicate', 32], ['authenticatedSignedWrites', 64]];
    return bits.reduce((mask, [name, bit]) => mask | (properties && properties[name] ? bit : 0), 0);
  }

  // host: send(message), receive(callback). bluetooth: navigator.bluetooth.
  function start(host, bluetooth, options = {}) {
    const now = options.now || (() => performance.now() / 1000);
    const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const decode = createDecoder();
    let device = null, characteristic = null, output = null, closing = false;
    let searching = Promise.resolve(), writes = Promise.resolve(), queued = 0;

    const describe = error => ({ name: String((error && error.name) || 'Error'), message: String((error && error.message) || error) });

    // One write at a time: Chromium refuses a write while another is in progress.
    function send(packet) {
      queued++;
      writes = writes.then(() => characteristic.writeValueWithoutResponse(packet))
        .then(() => { queued--; }, () => { queued--; if (output) output.failed(); });
    }

    function received(event) {
      const view = event.target.value;
      if (!view || !view.byteLength) return;
      const messages = [];
      const invalid = decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        (status, first, second, timestamp) => messages.push([status, first, second, timestamp]));
      if (messages.length) host.send({ type: 'midi', received: now(), messages });
      if (invalid) host.send({ type: 'invalid', detail: invalid });
    }

    // The search runs until the app picks a device in select-bluetooth-device or cancels.
    async function search(id) {
      let found;
      try { found = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] }); }
      catch (error) {
        let available = null;
        try { available = await bluetooth.getAvailability(); } catch (ignored) { /* unknown */ }
        host.send({ type: 'request-failed', request: id, error: describe(error), available });
        return;
      }
      if (closing) return;
      device = found;
      host.send({ type: 'chosen', request: id, name: found.name || '' });
      link(found);
    }

    async function link(found) {
      let stage = 'connect';
      const lost = () => { if (!closing) host.send({ type: 'link-lost' }); };
      found.addEventListener('gattserverdisconnected', lost);
      try {
        const server = await found.gatt.connect();
        if (closing) return;
        host.send({ type: 'linked' });
        stage = 'service';
        const service = await server.getPrimaryService(SERVICE);
        stage = 'characteristic';
        const midi = await service.getCharacteristic(CHARACTERISTIC);
        if (closing) return;
        host.send({ type: 'characteristic', properties: propertyMask(midi.properties) });
        // BLE-MIDI 1.0 section 5: read the I/O characteristic after connecting.
        // The piano normally returns an empty value; encryption/pairing may occur here.
        stage = 'read';
        const value = await midi.readValue();
        if (closing) return;
        host.send({ type: 'handshake', bytes: value ? value.byteLength : 0 });
        stage = 'subscribe';
        midi.addEventListener('characteristicvaluechanged', received);
        await midi.startNotifications();
        if (closing) return;
        characteristic = midi;
        output = createOutput({
          now,
          connected: () => Boolean(found.gatt.connected),
          writable: () => Boolean(midi.properties && midi.properties.writeWithoutResponse),
          canSend: () => queued < 16,
          send,
          onError: message => host.send({ type: 'output-error', message }),
        });
        host.send({ type: 'ready', name: found.name || '', output_capable: Boolean(midi.properties && midi.properties.writeWithoutResponse) });
      } catch (error) {
        if (closing) return;
        if (stage !== 'connect' && !found.gatt.connected) lost();
        else host.send({ type: 'failed', stage, error: describe(error) });
      }
    }

    async function close() {
      if (closing) return;
      closing = true;
      if (device) {
        if (output) {
          // Drain our note-offs and sustain release before closing our BLE link.
          output.stop();
          const started = now();
          while ((!output.drained() || queued) && now() - started < 1) await sleep(10);
          if (!output.drained() || queued)
            host.send({ type: 'output-error', message: 'Nota bırakma gönderimi tamamlanmadan bağlantı kapanıyor.' });
        }
        await sleep(100);
        try { device.gatt.disconnect(); } catch (ignored) { /* already closed */ }
      }
      host.send({ type: 'closed', connected: Boolean(device && device.gatt.connected) });
    }

    host.receive(message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'command')
        host.send({ type: 'reply', id: message.id, value: output ? output.command(message.request || {}) : { error: 'Piyano bağlı değil.' } });
      else if (message.type === 'close') close();
    });

    return {
      // Called with a user gesture (executeJavaScript(code, true)); requestDevice needs one.
      request(id) { searching = searching.then(() => search(id)).catch(() => {}); },
    };
  }

  const api = { SERVICE, CHARACTERISTIC, createDecoder, encode, createOutput, propertyMask, start };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.rach3BluetoothHost) root.rach3BluetoothPage = start(root.rach3BluetoothHost, root.navigator.bluetooth);
})(typeof globalThis === 'object' ? globalThis : this);
