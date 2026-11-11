// Electron: npx electron electron/tests/bluetooth-ids.js
// Lists every Bluetooth LE device Chromium can see for a few seconds (not only MIDI ones), to
// show what select-bluetooth-device calls a device on this system. With IDENTIFIERS set to
// CoreBluetooth identifiers (comma separated), it also prints the address each should hash to.
'use strict';
const { app, BrowserWindow, session } = require('electron');
const { hashedAddress, plainIdentifier } = require('../bluetooth');

app.whenReady().then(async () => {
  const ses = session.fromPartition('rach3-bluetooth-ids');
  ses.protocol.handle('https', () => new Response('<!doctype html><title>ids</title>', { headers: { 'content-type': 'text/html' } }));
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'rach3-bluetooth-ids', sandbox: true, contextIsolation: true } });
  const seen = new Map();
  let cancel = null;
  window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    cancel = callback;
    for (const device of devices) seen.set(device.deviceId, device.deviceName);
  });
  await window.loadURL('https://ids.rach3.invalid/');
  window.webContents.executeJavaScript(
    `navigator.bluetooth.requestDevice({ acceptAllDevices: true }).then(() => 'chosen', error => error.name + ': ' + error.message)`, true)
    .then(result => console.log('requestDevice ended:', result));
  setTimeout(() => {
    console.log(`${seen.size} devices`);
    for (const [deviceId, name] of seen) console.log(JSON.stringify({ deviceId, name, pageId: plainIdentifier(deviceId) }));
    for (const identifier of (process.env.IDENTIFIERS || '').split(',').filter(Boolean))
      console.log(JSON.stringify({ identifier, hashedAddress: hashedAddress(identifier), listed: seen.has(hashedAddress(identifier)), name: seen.get(hashedAddress(identifier)) }));
    if (cancel) cancel('');
    setTimeout(() => app.quit(), 300);
  }, Number(process.env.SCAN_SECONDS || 6) * 1000);
});
app.on('window-all-closed', () => {});
