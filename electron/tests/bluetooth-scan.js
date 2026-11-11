// Electron: npx electron electron/tests/bluetooth-scan.js
// Starts the real Bluetooth service, scans, and prints every event it publishes, so the
// hidden window, the user gesture and select-bluetooth-device can be seen working without a piano.
//   SCAN_SECONDS=8      how long to scan before disconnecting (default 8)
//   SCAN_TIMEOUT=45     the service's own deadline; below SCAN_SECONDS it shows scan_complete
//   SCAN_CONNECT=<uuid> connect to that device instead of browsing
//   SCAN_AGAIN=5        send a second scan command after that many seconds
//   RACH3_BLUETOOTH_DEBUG=1  also print the chooser lists and the hidden window's messages
'use strict';
const { app, BrowserWindow } = require('electron');
const { createBluetooth } = require('../bluetooth');

const seconds = Number(process.env.SCAN_SECONDS || 8);
const started = Date.now();
const stored = {};
const log = (...values) => console.log(`[${((Date.now() - started) / 1000).toFixed(2)}s]`, ...values);

app.whenReady().then(async () => {
  const bluetooth = createBluetooth({
    text: source => source,
    settings: { get: key => stored[key] ?? null, set: (key, value) => { stored[key] = value; log('settings.set', key, JSON.stringify(value)); } },
    timeoutSeconds: Number(process.env.SCAN_TIMEOUT || 45),
    publish: event => {
      if (event.event !== 'status') { log('publish', JSON.stringify(event)); return; }
      const { phase, message, active, browsing, devices, diagnostic, uuid, device } = event.status;
      log('status', JSON.stringify({ phase, active, browsing, message, uuid, device, devices, diagnostic }));
    },
    onStopped: () => { log('onStopped; active =', bluetooth.active, '; windows left =', BrowserWindow.getAllWindows().length); app.quit(); },
  });
  log('initial state', JSON.stringify(bluetooth.state));
  const request = process.env.SCAN_CONNECT ? { command: 'connect', uuid: process.env.SCAN_CONNECT } : { command: 'scan' };
  log('command', JSON.stringify(request), '->', JSON.stringify(await bluetooth.command(request)), '; active =', bluetooth.active);

  // The hidden window: is it there, hidden, a secure page with Web Bluetooth, ticking at 5 ms?
  setTimeout(async () => {
    const [hidden] = BrowserWindow.getAllWindows();
    if (!hidden) { log('no hidden window'); return; }
    const facts = await hidden.webContents.executeJavaScript(`(async () => {
      const ticks = []; let last = performance.now();
      await new Promise(done => { const timer = setInterval(() => { const now = performance.now(); ticks.push(now - last); last = now;
        if (ticks.length === 400) { clearInterval(timer); done(); } }, 5); });
      ticks.sort((a, b) => a - b);
      return { url: location.href, secure: isSecureContext, bluetooth: typeof navigator.bluetooth, page: typeof rach3BluetoothPage,
        available: await navigator.bluetooth.getAvailability(), visibility: document.visibilityState,
        tick_ms: { median: +ticks[200].toFixed(2), p99: +ticks[395].toFixed(2), max: +ticks[399].toFixed(2) } };
    })()`).catch(error => ({ error: error.message }));
    log('hidden window', JSON.stringify({ visible: hidden.isVisible(), ...facts }));
  }, 1000);

  if (process.env.SCAN_AGAIN) setTimeout(() => {
    bluetooth.command({ command: 'scan' }).then(reply => log('command scan (again) ->', JSON.stringify(reply)), error => log('command scan (again) refused:', error.message));
  }, Number(process.env.SCAN_AGAIN) * 1000);

  setTimeout(async () => {
    log('command disconnect ->', JSON.stringify(await bluetooth.command({ command: 'disconnect' })));
  }, seconds * 1000);
});
app.on('window-all-closed', () => {});
