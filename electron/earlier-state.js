'use strict';
// What the page itself had saved (where the person was, their practice choices) in the
// rach3 that came before this shell. The page keeps it in its browser storage, and each
// earlier app had its own browser: WKWebView on the Mac, WebView2 on Windows. It is read
// once, kept in a file, and handed to each page address the first time that page opens
// here; the earlier app's own storage is never changed.
//
//   const earlier = createEarlierState({ file, read });
//   earlier.script(host)   the script that hands a page its earlier storage, or null
//   earlier.taken(host)    that page now has it
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- Mac: ~/Library/WebKit/<bundle id>/WebsiteData/Default/<x>/<x>/ holds one page
// address each: "origin" names it, LocalStorage/localstorage.sqlite3 holds its storage.
function readMac(root = path.join(os.homedir(), 'Library', 'WebKit', 'com.rach3.app', 'WebsiteData', 'Default')) {
  const { DatabaseSync } = require('node:sqlite');
  const states = {};
  let folders = [];
  try { folders = fs.readdirSync(root); } catch { return states; }
  for (const name of folders) {
    const folder = path.join(root, name, name);
    try {
      const [scheme, host] = originStrings(fs.readFileSync(path.join(folder, 'origin')));
      if (scheme !== 'rach3-app' || !host) continue;
      const database = new DatabaseSync(path.join(folder, 'LocalStorage', 'localstorage.sqlite3'), { readOnly: true });
      try {
        const values = {};
        for (const row of database.prepare('SELECT key, value FROM ItemTable').all())
          if (typeof row.key === 'string') values[row.key] = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf16le');
        if (Object.keys(values).length) states[host] = values;
      } finally { database.close(); }
    } catch { /* not a page of rach3, or nothing saved there */ }
  }
  return states;
}

// WebKit writes an address as strings, each a length, a one-byte-characters mark and its text.
function originStrings(data) {
  const strings = [];
  for (let at = 0; strings.length < 2 && at + 5 <= data.length;) {
    const length = data.readUInt32LE(at), narrow = data[at + 4] === 1, bytes = narrow ? length : length * 2;
    if (at + 5 + bytes > data.length) break;
    strings.push(data.subarray(at + 5, at + 5 + bytes).toString(narrow ? 'latin1' : 'utf16le'));
    at += 5 + bytes;
  }
  return strings;
}

// ---- Windows: WebView2 kept a Chromium profile in <data folder>\WebView\EBWebView\Default,
// and the page ran as https://rach3.example. Chromium reads Chromium: a copy of that
// profile's storage is opened as a session of its own and the page address is asked what it holds.
async function readWindows(support, { session, BrowserWindow }) {
  const storage = path.join(support, 'WebView', 'EBWebView', 'Default', 'Local Storage');
  if (!fs.existsSync(path.join(storage, 'leveldb'))) return {};
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'rach3-earlier-'));
  let window = null;
  try {
    fs.cpSync(storage, path.join(copy, 'Local Storage'), { recursive: true });
    fs.rmSync(path.join(copy, 'Local Storage', 'leveldb', 'LOCK'), { force: true });
    const profile = session.fromPath(copy);
    // Nothing is fetched: the address answers with an empty page.
    profile.protocol.handle('https', () => new Response('<!doctype html><title>rach3</title>', { headers: { 'content-type': 'text/html' } }));
    window = new BrowserWindow({ show: false, webPreferences: { session: profile, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await window.loadURL('https://rach3.example/index.html');
    const values = JSON.parse(await window.webContents.executeJavaScript(
      'JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))'));
    return values && typeof values === 'object' && Object.keys(values).length ? { app: values } : {};
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    // The copy goes when rach3 ends; Chromium keeps the session open until then.
    process.once('exit', () => { try { fs.rmSync(copy, { recursive: true, force: true }); } catch {} });
  }
}

// file: where what was read is kept until every page has taken its part; its presence
// also says the earlier storage has been read. read: () => { host: { key: value } },
// or a promise of it, called once.
function createEarlierState({ file, read }) {
  let states = {};
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.pending', JSON.stringify(states));
      fs.renameSync(file + '.pending', file);
    } catch (error) { console.error('rach3 earlier state:', error.message); }
  };
  const usable = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let ready;
  if (fs.existsSync(file)) {
    try { states = usable(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { states = {}; }
    ready = Promise.resolve();
  } else {
    ready = Promise.resolve().then(read).then(found => { states = usable(found); }, error => { console.error('rach3 earlier state:', error.message); })
      .then(save);
  }
  return {
    ready,
    script(host) {
      const values = states[host];
      if (!values) return null;
      // Only what the page has not already saved here, and only once for this address.
      return `(() => { if (location.host !== ${JSON.stringify(host)}) return; try {` +
        ` if (localStorage.getItem('rach3.earlier') === location.host) return;` +
        ` for (const [key, value] of Object.entries(${JSON.stringify(values)})) if (typeof value === 'string' && localStorage.getItem(key) === null) localStorage.setItem(key, value);` +
        ` localStorage.setItem('rach3.earlier', location.host); } catch {} })();`;
    },
    taken(host) { if (states[host]) { delete states[host]; save(); } },
  };
}

module.exports = { createEarlierState, readMac, readWindows, originStrings };
