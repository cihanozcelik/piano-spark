'use strict';
// Process and IPC ownership only. CoreBluetooth discovery, GATT, decoding, output
// scheduling and confirmed disconnect all remain in bluetooth-connection/main.m.
const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');
const { spawn } = require('child_process');

const ADDRESS_PREFIX = '00000000-0000-0000-0000-';
const SOURCES = ['main.m', 'BLEMIDI.m', 'BLEMIDI.h', 'BLEMIDIOutput.m', 'BLEMIDIOutput.h', 'Info.plist', 'build.sh'];

function createNativeConnection({ identifier, timeoutSeconds, identifierOf, addressOf, emit, exited }) {
  const { app } = require('electron');
  const source = path.resolve(__dirname, '../bluetooth-connection');
  const bundle = app.isPackaged
    ? path.resolve(process.resourcesPath, '../Helpers/rach3 Bluetooth.app')
    : path.join(source, 'build/rach3 Bluetooth.app');
  const binary = path.join(bundle, 'Contents/MacOS/rach3-bluetooth');
  const runtime = path.join(app.getPath('userData'), 'BLE');
  const socketPath = path.join(runtime, 'control.sock');
  const devices = new Map(), sockets = new Set();
  let child = null, builder = null, stopping = false, finished = false, started = false;
  let pendingIdentifier = null, selecting = false, terminalEvent = false, failed = false;
  let stderr = '', queue = Promise.resolve();

  const deliver = event => emit({ time_unix: Date.now() / 1000, ...event });
  const publicIdentifier = uuid => identifierOf(addressOf(uuid));

  function finish(code) {
    if (finished) return;
    finished = true;
    for (const socket of sockets) socket.destroy();
    exited(code);
  }

  function fail(error) {
    if (failed || finished) return;
    failed = true;
    deliver({ event: 'connection_issue', diagnostic: { code: 'service_failed', detail: error.message } });
    stop();
  }

  function send(request) {
    if (stopping || finished || !started) return Promise.reject(new Error('Mac’in Bluetooth servisi hazır değil.'));
    const body = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) return Promise.reject(new Error('Ders MIDI çıkışı için çok büyük veya geçersiz.'));
    return new Promise((resolve, reject) => {
      let reply = '', settled = false;
      const socket = net.createConnection(socketPath);
      sockets.add(socket);
      const timer = setTimeout(() => done(new Error('Piyano çalma komutuna yanıt alınamadı.')), 3000);
      function done(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer); sockets.delete(socket); socket.destroy();
        if (error) reject(error); else resolve(value);
      }
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(body));
      socket.on('error', error => done(error));
      socket.on('data', chunk => {
        reply += chunk;
        if (reply.length > 65536) { done(new Error('Geçersiz MIDI çıkış yanıtı')); return; }
        if (!reply.includes('\n')) return;
        try { done(null, JSON.parse(reply)); } catch (error) { done(error); }
      });
      socket.on('close', () => done(new Error('Piyano çalma komutuna yanıt alınamadı.')));
    });
  }

  // Serialize commands just like the Python host. BLE timing never runs in Node.
  function enqueue(request) {
    const result = queue.then(() => send(request));
    queue = result.catch(() => {});
    return result;
  }

  async function select(uuid) {
    selecting = true;
    const reply = await enqueue({ command: 'connect', uuid });
    if (reply.error) throw new Error(reply.error);
    pendingIdentifier = null;
  }

  function receive(event) {
    if (!event || typeof event.event !== 'string') return;
    if (event.event === 'started') {
      started = true;
      if (stopping) child.kill('SIGTERM');
    }
    if (event.event === 'connection_issue') failed = true;
    if (event.event === 'stopped') terminalEvent = true;
    if (stopping && !['stopped', 'connection_issue', 'error', 'output_error'].includes(event.event)) return;
    if (event.uuid) {
      const uuid = event.uuid.toUpperCase(), visible = publicIdentifier(uuid);
      devices.set(uuid, uuid); devices.set(visible, uuid);
      event = { ...event, uuid: visible };
      // Older Electron versions saved the hash of a CoreBluetooth UUID. Preserve
      // those IDs and all WorkspaceState preferences; resolve them through actual
      // discovery, including peripherals already connected to macOS.
      if (event.event === 'discovered' && pendingIdentifier) {
        if (!selecting && (pendingIdentifier === visible || pendingIdentifier === uuid))
          select(uuid).catch(error => { if (!stopping) fail(error); });
        return;
      }
    }
    if (pendingIdentifier && event.event === 'scanning') event = { ...event, browsing: false };
    if (pendingIdentifier && event.event === 'scan_complete') {
      failed = true;
      deliver({ event: 'connection_issue', diagnostic: {
        code: 'piano_unreachable', stage: 'scanning', deviceSeen: false, linkEstablished: false,
      } });
      stop(); return;
    }
    deliver(event);
  }

  async function command(request) {
    if (request.command === 'scan') {
      pendingIdentifier = null; selecting = false; devices.clear();
    } else if (request.command === 'connect') {
      const uuid = devices.get(request.uuid);
      if (uuid || !request.uuid.startsWith(ADDRESS_PREFIX)) {
        pendingIdentifier = null; selecting = false;
        return enqueue({ ...request, uuid: uuid || request.uuid });
      }
      pendingIdentifier = request.uuid; selecting = false;
      return enqueue({ command: 'scan' });
    }
    return enqueue(request);
  }

  function stop() {
    if (stopping || finished) return;
    stopping = true;
    // Wait for 'started': SIGTERM before the native signal handler is installed
    // would bypass cleanup. The helper's parent watchdog also covers host crashes.
    if (child) { if (started) child.kill('SIGTERM'); }
    else if (!builder) setImmediate(() => finish(failed ? 1 : 0));
  }

  async function launch() {
    if (stopping || finished) { finish(failed ? 1 : 0); return; }
    if (!app.isPackaged) {
      const built = fs.existsSync(binary) ? fs.statSync(binary).mtimeMs : 0;
      if (SOURCES.some(name => fs.statSync(path.join(source, name)).mtimeMs > built)) {
        await new Promise((resolve, reject) => {
          builder = spawn('/bin/bash', [path.join(source, 'build.sh')], { stdio: ['ignore', 'ignore', 'pipe'] });
          let output = '';
          builder.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
          builder.on('error', reject);
          builder.on('close', code => { builder = null; if (code === 0) resolve(); else reject(new Error(output || 'Bluetooth build failed')); });
        });
      }
    }
    if (stopping) { finish(failed ? 1 : 0); return; }
    fs.accessSync(binary, fs.constants.X_OK);
    if (Buffer.byteLength(socketPath) >= 104) throw new Error('Bluetooth control socket path is too long.');
    const args = [runtime, 'start', '--timeout', String(timeoutSeconds), '--duration', '0', '--parent-pid', String(process.pid)];
    if (identifier) {
      if (identifier.startsWith(ADDRESS_PREFIX)) pendingIdentifier = identifier;
      else args.push('--uuid', identifier);
    }
    child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      try { receive(JSON.parse(line)); } catch (error) { fail(error); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { fail(error); });
    child.on('close', (code, signal) => {
      lines.close();
      if (!terminalEvent && !failed) {
        failed = true;
        deliver({ event: 'connection_issue', diagnostic: { code: 'service_failed',
          detail: stderr || `Bluetooth helper exited (${signal || code}) before confirming cleanup.` } });
      }
      finish(failed ? 1 : code || 0);
    });
  }

  // Defer events until createBluetooth has installed this connection as its owner.
  setImmediate(() => launch().catch(error => { fail(error); if (!child) finish(1); }));
  return { command, stop };
}

module.exports = { createNativeConnection };
