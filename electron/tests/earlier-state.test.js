// Electron: npx electron electron/tests/earlier-state.test.js
// The page state carried over from the apps before this shell (electron/earlier-state.js):
// a WebKit storage folder as the Mac app left it, and a Chromium profile as WebView2 left
// it on Windows. Both are made here in a temporary folder; the profile is written by
// Chromium itself in a first run of this file and read back in a second.
'use strict';
const { app, BrowserWindow, session } = require('electron');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEarlierState, readMac, readWindows, originStrings } = require('../earlier-state');

const making = process.env.EARLIER_MAKE;   // second role: write the Chromium profile and exit
const temp = making ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'rach3-earlier-test-'));
app.setPath('userData', path.join(making || temp, 'electron'));
const ok = name => console.log('ok - ' + name);

// A string as WebKit writes it in an "origin" file.
const webkitString = text => Buffer.concat([Buffer.from([text.length, 0, 0, 0, 1]), Buffer.from(text, 'latin1')]);
function webkitFolder(root, name, scheme, host, values) {
  const folder = path.join(root, name, name);
  fs.mkdirSync(path.join(folder, 'LocalStorage'), { recursive: true });
  const origin = Buffer.concat([webkitString(scheme), webkitString(host), Buffer.from([0])]);
  fs.writeFileSync(path.join(folder, 'origin'), Buffer.concat([origin, origin]));
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(path.join(folder, 'LocalStorage', 'localstorage.sqlite3'));
  database.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)');
  const insert = database.prepare('INSERT INTO ItemTable VALUES (?, ?)');
  for (const [key, value] of Object.entries(values)) insert.run(key, Buffer.from(value, 'utf16le'));
  database.close();
}

async function makeProfile(support) {
  const profile = session.fromPath(path.join(support, 'WebView', 'EBWebView', 'Default'));
  profile.protocol.handle('https', () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
  const window = new BrowserWindow({ show: false, webPreferences: { session: profile } });
  await window.loadURL('https://rach3.example/index.html');
  await window.webContents.executeJavaScript(`localStorage.setItem('rach3.workspace.v1', '{"lesson":"ğüşıöç"}'); localStorage.setItem('rach3-language', 'tr'); 1`);
  await profile.flushStorageData();
  await new Promise(done => setTimeout(done, 1500));
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  if (making) { await makeProfile(making); app.exit(0); return; }
  let failed = false;
  try {
    // ---- Mac
    const webkit = path.join(temp, 'WebKit');
    webkitFolder(webkit, 'aaa', 'rach3-app', 'app', { 'rach3.workspace.v1': '{"lesson":"ğüşıöç"}', 'rach3-language': 'tr' });
    webkitFolder(webkit, 'bbb', 'rach3-app', 'b20261110-143936-fdaa-0', { 'rach3.workspace.v1': '{"branch":true}' });
    webkitFolder(webkit, 'ccc', 'file', '', { other: 'x' });
    fs.mkdirSync(path.join(webkit, 'ddd', 'ddd'), { recursive: true });
    assert.deepStrictEqual(originStrings(fs.readFileSync(path.join(webkit, 'aaa', 'aaa', 'origin'))), ['rach3-app', 'app']);
    assert.deepStrictEqual(readMac(webkit), {
      app: { 'rach3.workspace.v1': '{"lesson":"ğüşıöç"}', 'rach3-language': 'tr' },
      'b20261110-143936-fdaa-0': { 'rach3.workspace.v1': '{"branch":true}' },
    });
    assert.deepStrictEqual(readMac(path.join(temp, 'nothing-here')), {});
    ok('Mac: every rach3 page address with its saved values; other folders ignored');

    // ---- kept in a file, handed over once per address
    const file = path.join(temp, 'data', 'earlier-page-state.json');
    let reads = 0;
    const first = createEarlierState({ file, read: () => { reads++; return readMac(webkit); } });
    await first.ready;
    assert(first.script('app').includes('rach3.workspace.v1') && first.script('nobody') === null);
    first.taken('app');
    assert.strictEqual(first.script('app'), null);
    const second = createEarlierState({ file, read: () => { reads++; return {}; } });
    await second.ready;
    assert.strictEqual(reads, 1);
    assert(second.script('app') === null && second.script('b20261110-143936-fdaa-0').includes('"branch'));
    second.taken('b20261110-143936-fdaa-0');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
    const failing = createEarlierState({ file: path.join(temp, 'data2', 'state.json'), read: () => { throw new Error('unreadable'); } });
    await failing.ready;
    assert(failing.script('app') === null && fs.existsSync(path.join(temp, 'data2', 'state.json')));
    ok('read once, kept until each address has taken its part; a failed read is not retried');

    // ---- the script in a real page: fills only what is missing, once
    const pages = session.fromPartition('earlier-test');
    pages.protocol.handle('https', () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    const window = new BrowserWindow({ show: false, webPreferences: { session: pages } });
    await window.loadURL('https://app/piano.html');
    const script = createEarlierState({ file: path.join(temp, 'data3', 'state.json'), read: () => ({ app: { a: '1', b: '2' } }) });
    await script.ready;
    const run = code => window.webContents.executeJavaScript(code);
    await run(`localStorage.setItem('b', 'mine'); ${script.script('app')}; 1`);
    assert.deepStrictEqual(await run(`[localStorage.getItem('a'), localStorage.getItem('b'), localStorage.getItem('rach3.earlier')]`), ['1', 'mine', 'app']);
    await run(`localStorage.removeItem('a'); ${script.script('app')}; 1`);
    assert.strictEqual(await run(`localStorage.getItem('a')`), null);
    window.destroy();
    ok('the page gets only what it had not saved itself, and only once');

    // ---- Windows: a Chromium profile written by another run, as WebView2 would leave it
    const support = path.join(temp, 'Rach3');
    const made = spawnSync(process.execPath, [__filename], { env: { ...process.env, EARLIER_MAKE: support }, encoding: 'utf8' });
    assert.strictEqual(made.status, 0, made.stderr);
    assert(fs.existsSync(path.join(support, 'WebView', 'EBWebView', 'Default', 'Local Storage', 'leveldb')), 'no profile was written');
    const before = execFileSync('find', [path.join(support, 'WebView'), '-type', 'f'], { encoding: 'utf8' });
    assert.deepStrictEqual(await readWindows(support, { session, BrowserWindow }), { app: { 'rach3.workspace.v1': '{"lesson":"ğüşıöç"}', 'rach3-language': 'tr' } });
    assert.strictEqual(execFileSync('find', [path.join(support, 'WebView'), '-type', 'f'], { encoding: 'utf8' }), before);
    assert.deepStrictEqual(await readWindows(path.join(temp, 'nothing-here'), { session, BrowserWindow }), {});
    ok('Windows: the earlier Chromium profile is read through a copy and left as it was');
  } catch (error) { failed = true; console.log('FAIL', error.stack || error); }
  console.log(failed ? 'FAILED' : 'ALL PASSED');
  app.exit(failed ? 1 : 0);
});
