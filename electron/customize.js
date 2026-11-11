// The computer's side of rach3's ChatGPT features, the same code on Mac and Windows.
// What the features do, for changing rach3 and for the "With AI" tab, is
// desktop/customize/core.js; it runs in the Customize panel's web view and asks this
// module for what only the computer can do: files in rach3's own folders, Codex,
// Sign in with ChatGPT, the hidden preview and serving the page.
//
// The page is served from a "design": the original files in the app, or a saved copy
// in <support>/Customize/designs.
'use strict';
const electron = require('electron');
const { app, BrowserWindow, ipcMain, session } = electron;
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const WINDOWS = process.platform === 'win32';

// Sign in with ChatGPT, direct flow for open-source apps
// (developers.openai.com/siwc/token-sharing-open-source).
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const REVOKE_URL = 'https://auth.openai.com/api/accounts/oauth/revoke';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const SCHEME = 'rach3-app';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const base64URL = data => data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const randomToken = bytes => base64URL(crypto.randomBytes(bytes));
function claims(jwt) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length < 2) return null;
  try { const value = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return isObject(value) ? value : null; }
  catch { return null; }
}
const percent = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const formBody = fields => Object.entries(fields).map(([key, value]) => `${key}=${percent(value)}`).join('&');
const tomlString = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// What core.js may reach in Customize: its records, the saved versions, the scratch
// copy and the lessons ChatGPT made. Not the sign-in, not Codex's home.
const DATA_ENTRIES = new Set(['designs.json', 'usage.json', 'designs', 'workspace', 'lessons']);
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', mid: 'audio/midi',
  wasm: 'application/wasm', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8' };
const mimeType = file => TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

// Files

function isLink(file) { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } }
function kindOf(file) { try { return fs.statSync(file).isDirectory() ? 'folder' : 'file'; } catch { return null; } }
function readData(file) { try { return file ? fs.readFileSync(file) : null; } catch { return null; } }
// Text as UTF-8, or null when the file is missing or is not text.
function readText(file) {
  const data = readData(file);
  try { return data ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) : null; } catch { return null; }
}
function readObject(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return isObject(value) ? value : null; } catch { return null; }
}
function makeFolder(folder, mode) { try { fs.mkdirSync(folder, { recursive: true, ...(mode ? { mode } : {}) }); return true; } catch { return false; } }
function remove(file) { try { fs.rmSync(file, { recursive: true, force: true, maxRetries: 2 }); } catch { /* still there */ } }
// Writes the whole file or leaves the old one: a copy beside it, then renamed over it.
function writeAtomic(file, data, mode) {
  const copy = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(copy, data, mode ? { mode } : undefined);
    fs.renameSync(copy, file);
    return true;
  } catch { try { fs.rmSync(copy, { force: true }); } catch { /* nothing to clean */ } return false; }
}

// Names Windows reads differently from how they are written ("a.", "NUL.txt", "C:x").
const WINDOWS_DEVICES = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(number => [`COM${number}`, `LPT${number}`])]);
function plainName(part) {
  if (part.includes('\0')) return false;
  if (!WINDOWS) return true;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f:\\/*?"<>|]/.test(part) && !part.endsWith(' ') && !part.endsWith('.') &&
    !WINDOWS_DEVICES.has(part.split('.')[0].trimEnd().toUpperCase());
}

// A relative path ("a/b.js") inside root, or null when it would leave it: no "..", no
// hidden names, and no link on the way, since a link could lead anywhere on the computer.
function inside(root, relative) {
  if (typeof relative !== 'string' || relative.startsWith('/')) return null;
  if (!relative.length) return root;
  let current = root;
  for (const part of relative.split('/')) {
    if (!part.length || part.startsWith('.') || !plainName(part)) return null;
    current = path.join(current, part);
    if (isLink(current)) return null;
  }
  return current;
}

// Regular files under folder, as "/" paths relative to it. Links are skipped, never
// followed. (A folder itself reached through a link, like /var for /private/var, still lists.)
function relativeFiles(folder) {
  const paths = [];
  const walk = (directory, prefix) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) paths.push(prefix + entry.name);
    }
  };
  walk(folder, '');
  return paths;
}

function copyFrom(from, to) {
  if (!from || !to || isLink(from)) return false;
  const kind = kindOf(from);
  if (!kind) return false;
  try {
    if (kind === 'file') {
      remove(to);
      makeFolder(path.dirname(to));
      fs.copyFileSync(from, to);
      return true;
    }
    makeFolder(to);
    for (const relative of relativeFiles(from)) {
      const target = path.join(to, ...relative.split('/'));
      remove(target);
      makeFolder(path.dirname(target));
      fs.copyFileSync(path.join(from, ...relative.split('/')), target);
    }
    return true;
  } catch { return false; }
}

function move(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  makeFolder(path.dirname(to));
  try { fs.renameSync(from, to); return true; } catch { /* below */ }
  // Windows does not rename a folder a running program stands in, and the scratch copy
  // is where Codex stands. There the files are copied and the scratch copy emptied.
  if (!WINDOWS) return false;
  if (!copyFrom(from, to)) { remove(to); return false; }
  remove(from);
  return true;
}

function summaries(folder) {
  const list = [];
  let names;
  try { names = fs.readdirSync(folder); } catch { return list; }
  for (const name of names) {
    const file = path.join(folder, name);
    if (path.extname(name) !== '.json' || isLink(file)) continue;
    const lesson = readObject(file);
    if (!lesson || lesson.id === undefined || lesson.title === undefined) continue;
    list.push({ id: lesson.id, title: lesson.title, noteCount: lesson.noteCount ?? 0, duration: lesson.duration ?? 0 });
  }
  return list;
}

// PDF pages as pictures
//
// Chromium's own PDF viewer draws the page, in a window the person never sees, and the
// window's picture of that page is saved. Electron has no other PDF drawing, and this
// one is the same on Mac and Windows. The viewer's page is in a frame of its own.
const PDF_PARTITION = 'rach3-pdf';
const viewerFrame = contents => contents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith('chrome-extension://') && frame.url.includes('/index.html'));
const inViewer = async (contents, code) => {
  const frame = contents.isDestroyed() ? null : viewerFrame(contents);
  if (!frame) return null;
  try { return await frame.executeJavaScript(code); } catch { return null; }
};
let pdfQueue = Promise.resolve();
const pdfWindows = new Set();

// Opens a PDF and hands `work` a function that draws one page; one PDF at a time.
function withPDF(file, work) {
  const run = pdfQueue.then(async () => {
    const address = pathToFileURL(file).href;
    const store = session.fromPartition(PDF_PARTITION);
    // The viewer may load the PDF and its own parts; nothing from the internet.
    store.webRequest.onBeforeRequest((details, done) => {
      done({ cancel: !(details.url.split('#')[0] === address || /^(chrome-extension|chrome|devtools|data|blob):/.test(details.url)) });
    });
    store.setPermissionRequestHandler((contents, permission, done) => done(false));
    const window = new BrowserWindow({ show: false, width: 1060, height: 900, useContentSize: true, frame: false, skipTaskbar: true, focusable: false,
      enableLargerThanScreen: true, webPreferences: { session: store, plugins: true, offscreen: true, sandbox: true, contextIsolation: true,
        nodeIntegration: false, javascript: true } });
    pdfWindows.add(window);
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    try {
      let count = 0;
      try {
        await contents.loadURL(`${address}#toolbar=0&navpanes=0`);
        for (let attempt = 0; attempt < 100 && !count && !window.isDestroyed(); attempt++) {
          const state = await inViewer(contents, `(() => { const viewer = document.querySelector('#viewer'), view = viewer?.viewport;
            const state = String(viewer?.loadState_ ?? ''), pages = view?.pageDimensions_ ?? view?.documentDimensions_?.pageDimensions;
            return { count: state === 'loading' ? 0 : Number(pages?.length) || 0, failed: state === 'failed' || !!viewer?.shadowRoot?.querySelector('viewer-error-dialog') }; })()`);
          if (state?.failed) break;
          count = state?.count || 0;
          if (!count) await wait(100);
        }
      } catch { count = 0; }
      const draw = async (number, width) => {
        if (window.isDestroyed() || number < 1 || number > count) return null;
        const index = number - 1;
        const page = await inViewer(contents, `(() => { const size = document.querySelector('#viewer').viewport.getPageInsetDimensions(${index}); return { width: size.width, height: size.height }; })()`);
        if (!page || !(page.width > 0) || !(page.height > 0)) return null;
        // A little larger than asked, so the picture is cut from inside the page and none of
        // the viewer's own background is in it. The viewer zooms between a quarter and five
        // times; a page that needs more is scaled after.
        const zoom = Math.max(0.25, Math.min(5, (width + 6) / page.width));
        const tall = Math.max(1, Math.min(width * 4, Math.round(width * page.height / page.width)));
        window.setContentSize(Math.ceil(page.width * zoom) + 80, Math.ceil(Math.min(page.height * zoom, tall + 12)) + 40);
        const placed = `(() => { const view = document.querySelector('#viewer').viewport; view.setZoom(${zoom}); view.goToPage(${index});
          const area = view.getPageScreenRect(${index}); return { x: area.x, y: area.y, width: area.width, height: area.height }; })()`;
        await inViewer(contents, placed);
        // The page is drawn a moment after the viewer is told where to look; it is ready
        // once two pictures in a row are the same.
        let image = null, before = null;
        for (let attempt = 0; attempt < 40; attempt++) {
          await wait(150);
          const area = await inViewer(contents, placed);
          if (!area || window.isDestroyed()) return null;
          const view = window.getContentBounds();
          const inner = { x: Math.max(0, Math.ceil(area.x) + 2), y: Math.max(0, Math.ceil(area.y) + 2), width: Math.floor(area.width) - 4, height: Math.floor(area.height) - 4 };
          if (inner.width > width) { inner.x += Math.floor((inner.width - width) / 2); inner.width = width; }
          inner.width = Math.min(inner.width, view.width - inner.x); inner.height = Math.min(inner.height, tall, view.height - inner.y);
          if (inner.width < 1 || inner.height < 1) continue;
          const shot = await contents.capturePage(inner);
          if (shot.isEmpty()) continue;
          const pixels = shot.toBitmap();
          if (before && before.equals(pixels)) { image = shot; break; }
          before = pixels; image = shot;
        }
        if (!image) return null;
        if (image.getSize().width !== width) image = image.resize({ width, quality: 'best' });
        if (image.getSize().height > tall) image = image.crop({ x: 0, y: 0, width, height: tall });
        return inkOnly(image, width).toPNG();
      };
      return await work({ count, draw });
    } finally {
      pdfWindows.delete(window);
      if (!window.isDestroyed()) window.destroy();
    }
  });
  pdfQueue = run.catch(() => null);
  return run;
}

// The picture with the empty paper around the music cut away, so the notes fill it.
function inkOnly(image, width) {
  const { width: w, height: h } = image.getSize();
  const pixels = image.toBitmap();
  const stride = pixels.length / h;   // four bytes a pixel; the order does not matter here
  let top = h, bottom = 0, left = w, right = 0;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const pixel = row + x * 4;
      if (pixels[pixel] > 235 && pixels[pixel + 1] > 235 && pixels[pixel + 2] > 235) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (!(top < bottom && left < right)) return image;
  const margin = Math.floor(width * 0.02);
  const x0 = Math.max(0, left - margin), y0 = Math.max(0, top - margin);
  const x1 = Math.min(w, right + margin + 1), y1 = Math.min(h, bottom + margin + 1);
  const cropped = image.crop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  return cropped.isEmpty() ? image : cropped;
}

// The desk behind the "With AI" tab of Create a Lesson: the conversation with ChatGPT
// about which piece to learn, and the candidates it showed (a YouTube video, a MIDI
// file or a PDF score). rach3 itself fetches every candidate, so Codex never downloads
// anything. Kept in <support>/Customize/desk.
const FILE_LIMIT = 40 * 1024 * 1024;
const PREVIEW_PAGES = 3;
const CARD_NAME = /^[0-9a-f]{12}$/;

// The 11-character id of a YouTube video link, or null.
function youTubeID(text) {
  let parts;
  try { parts = new URL(String(text).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(parts.protocol) || parts.username || parts.password) return null;
  let host = parts.hostname.toLowerCase();
  for (const prefix of ['www.', 'm.', 'music.']) if (host.startsWith(prefix)) host = host.slice(prefix.length);
  const steps = parts.pathname.split('/').filter(Boolean);
  let identifier = null;
  if (host === 'youtu.be') identifier = steps[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (steps[0] === 'watch') { for (const [name, value] of parts.searchParams) if (name === 'v') identifier = value; }
    else if (steps.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(steps[0])) identifier = steps[1];
  }
  return typeof identifier === 'string' && /^[A-Za-z0-9_-]{11}$/.test(identifier) ? identifier : null;
}

function createLessonDesk(root, onProgress) {
  makeFolder(root, 0o700);
  const saved = readObject(path.join(root, 'desk.json'));
  const conversation = Array.isArray(saved?.entries) ? saved.entries : [];
  const cards = isObject(saved?.cards) ? saved.cards : {};
  // A lesson that was being made when rach3 quit is not being made any more.
  for (const card of Object.values(cards)) if (isObject(card) && card.state === 'making') card.state = 'shown';

  const now = () => Date.now();
  const save = () => writeAtomic(path.join(root, 'desk.json'), JSON.stringify({ entries: conversation, cards }), 0o600);
  const card = identifier => typeof identifier === 'string' && Object.prototype.hasOwnProperty.call(cards, identifier) ? cards[identifier] : null;
  // A card's own folder; only names rach3 itself gave are folders.
  const folderOf = identifier => typeof identifier === 'string' && CARD_NAME.test(identifier) ? path.join(root, identifier) : null;
  const report = progress => { try { onProgress?.(progress); } catch (error) { console.error(error); } };

  function fileOf(identifier) {
    const folder = folderOf(identifier), kind = card(identifier)?.kind;
    if (!folder) return null;
    if (kind === 'midi') return path.join(folder, 'source.mid');
    if (kind === 'pdf') return path.join(folder, 'source.pdf');
    return null;
  }

  // Downloads a link; with `progress`, tells the page how far the download is.
  // Answers {data, error, status}; only https, also after the site sends rach3 elsewhere.
  async function download(link, limit, progress) {
    const refused = { data: null, error: 'Only https links can be opened.', status: 0 };
    let url;
    try { url = link instanceof URL ? link : new URL(link); } catch { return refused; }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return refused;
    const host = url.host, stop = new AbortController();
    let late = false, received = 0, total = 0, quiet = null, ticker = null;
    const giveUp = () => { late = true; stop.abort(); };
    const whole = setTimeout(giveUp, 120000);
    const heard = () => { clearTimeout(quiet); quiet = setTimeout(giveUp, 15000); };
    if (progress) {
      report({ stage: 'download', host, received: 0 });
      ticker = setInterval(() => report({ stage: 'download', host, received, ...(total > 0 ? { total } : {}) }), 500);
    }
    try {
      heard();
      let answer;
      for (let hop = 0; ; hop++) {
        answer = await globalThis.fetch(url, { redirect: 'manual', signal: stop.signal, headers: { 'User-Agent': 'rach3' } });
        const next = [301, 302, 303, 307, 308].includes(answer.status) ? answer.headers.get('location') : null;
        if (!next) break;
        try { await answer.body?.cancel(); } catch { /* already closed */ }
        url = new URL(next, url);
        if (url.protocol !== 'https:' || hop >= 10) return refused;
        heard();
      }
      const status = answer.status;
      total = Number(answer.headers.get('content-length')) || 0;
      const chunks = [];
      if (answer.body) for await (const chunk of answer.body) {
        heard();
        received += chunk.length;
        if (received > limit) { stop.abort(); return { data: null, error: status >= 400 ? `The site answered ${status}.` : 'The file is too large.', status }; }
        chunks.push(chunk);
      }
      if (status >= 400) return { data: null, error: `The site answered ${status}.`, status };
      return { data: Buffer.concat(chunks), error: null, status };
    } catch (error) {
      return { data: null, error: late ? `${host} did not answer.` : String(error?.cause?.message || error?.message || error), status: 0 };
    } finally { clearTimeout(whole); clearTimeout(quiet); clearInterval(ticker); }
  }

  // The first pages of a PDF as pictures the card can show.
  async function renderPages(file, folder, identifier) {
    const pages = [];
    let count = 0;
    try {
      await withPDF(file, async pdf => {
        count = pdf.count;
        for (let number = 1; number <= Math.min(count, PREVIEW_PAGES); number++) {
          const png = await pdf.draw(number, 1000);
          const name = `page-${number}.png`;
          if (png && writeAtomic(path.join(folder, name), png)) pages.push(`_desk/${identifier}/${name}`);
        }
      });
    } catch (error) { console.error('rach3 pdf:', error?.message || error); }
    return { pages, count };
  }

  // Any page of a shown PDF, drawn the first time it is asked for: "page-N" for the
  // card, "large-N" sharp enough to zoom into.
  async function page(number, large, identifier) {
    const known = card(identifier), folder = folderOf(identifier);
    if (!folder || known?.kind !== 'pdf' || number < 1 || number > (Number(known.pageCount) || 0)) return null;
    const file = path.join(folder, `${large ? 'large' : 'page'}-${number}.png`);
    const kept = readData(file);
    if (kept) return kept;
    let png = null;
    try { png = await withPDF(fileOf(identifier), pdf => pdf.draw(number, large ? 2400 : 1000)); } catch (error) { console.error('rach3 pdf:', error?.message || error); }
    if (png) writeAtomic(file, png);
    return png;
  }

  return {
    card, fileOf,
    get entries() { return conversation.map(entry => entry.card ? { ...entry, card: card(entry.card) ?? null } : { ...entry }); },
    addEntry(entry) {
      const kept = { ...entry };
      if (isObject(kept.card)) kept.card = kept.card.id;
      kept.time = now();
      conversation.push(kept);
      save();
    },
    // Forgets the conversation and its candidates.
    clear() {
      for (const identifier of Object.keys(cards)) { const folder = folderOf(identifier); if (folder) remove(folder); }
      conversation.length = 0;
      for (const identifier of Object.keys(cards)) delete cards[identifier];
      save();
    },
    update(changed) {
      if (typeof changed.id !== 'string' || !changed.id) return;
      cards[changed.id] = { ...changed };
      save();
    },
    // Files the page may load, at "_desk/<card>/<name>". Answers {data, type} or null.
    async servedFile(relative) {
      const parts = relative.split('/');
      if (parts.length !== 3 || parts[0] !== '_desk' || !card(parts[1])) return null;
      const name = parts[2];
      const numbered = /^(page|large)-([0-9]{1,4})\.png$/.exec(name);
      if (numbered) { const data = await page(Number(numbered[2]), numbered[1] === 'large', parts[1]); return data ? { data, type: 'image/png' } : null; }
      const types = { jpg: 'image/jpeg', png: 'image/png', mid: 'audio/midi' };
      const type = types[path.extname(name).slice(1)], folder = folderOf(parts[1]);
      const file = type && folder ? inside(folder, name) : null;
      const data = readData(file);
      return data ? { data, type } : null;
    },
    // Fetches a candidate: `source` is a YouTube link or an https link to a MIDI or PDF
    // file. Answers {card} to show, or {error} for ChatGPT.
    async show(source, title, note) {
      const identifier = crypto.randomBytes(6).toString('hex');
      const folder = folderOf(identifier);
      const made = { id: identifier, title: title || '', note: note || '', source: source || '', state: 'shown', created: now() };
      const refuse = error => { remove(folder); return { error }; };
      const keep = () => { cards[identifier] = made; save(); return { card: made }; };
      makeFolder(folder, 0o700);
      const video = youTubeID(source || '');
      if (video) {
        const watch = `https://www.youtube.com/watch?v=${video}`;
        made.kind = 'youtube'; made.link = watch;
        report({ stage: 'video' });
        const described = await download(`https://www.youtube.com/oembed?url=${percent(watch)}&format=json`, 256 * 1024, false);
        let details = null;
        try { details = described.data ? JSON.parse(described.data.toString('utf8')) : null; } catch { details = null; }
        // YouTube answers 401 for a video that exists but may not play inside other apps.
        // It can still become a lesson; the card opens it on YouTube.
        if (described.status === 401) { made.embeddable = false; details = {}; }
        if (!isObject(details)) {
          return refuse(described.status === 404 || described.status === 400 ? 'There is no YouTube video at this link.' :
            described.error ? `YouTube could not be reached: ${described.error}` : 'YouTube did not describe this video.');
        }
        if (!title && typeof details.title === 'string') made.title = details.title;
        if (typeof details.author_name === 'string') made.author = details.author_name;
        const picture = await download(`https://i.ytimg.com/vi/${video}/hqdefault.jpg`, 2 * 1024 * 1024, false);
        if (picture.data && writeAtomic(path.join(folder, 'thumb.jpg'), picture.data)) made.thumb = `_desk/${identifier}/thumb.jpg`;
        return keep();
      }
      let url;
      try { url = new URL(String(source).trim()); } catch { return refuse('That is not a link.'); }
      const fetched = await download(url, FILE_LIMIT, true);
      const data = fetched.data;
      if (!data) return refuse(fetched.error || 'Nothing was downloaded.');
      if (!title) {
        let name = url.pathname.replace(/\/+$/, '').split('/').pop() || '';
        try { name = decodeURIComponent(name); } catch { /* kept as written */ }
        made.title = path.posix.parse(name).name;
      }
      made.size = data.length;
      if (data.length >= 4 && data.subarray(0, 4).toString('latin1') === 'MThd') {
        made.kind = 'midi';
        writeAtomic(path.join(folder, 'source.mid'), data);
        made.file = `_desk/${identifier}/source.mid`;
        return keep();
      }
      if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') {
        made.kind = 'pdf';
        const file = path.join(folder, 'source.pdf');
        writeAtomic(file, data);
        report({ stage: 'pages' });
        const drawn = await renderPages(file, folder, identifier);
        made.pages = drawn.pages; made.pageCount = drawn.count;
        if (!drawn.count) return refuse('The PDF could not be opened.');
        return keep();
      }
      return refuse('The link is not a MIDI or PDF file. Link the file itself, not the page about it.');
    },
  };
}

// The service

function createCustomize(options) {
  const source = options.source, codexRoot = options.codexRoot, support = options.support;
  const version = options.version || '';
  const root = path.join(support, 'Customize');
  makeFolder(path.join(root, 'designs'), 0o700);
  const workspace = path.join(root, 'workspace');
  const lessonsFolder = path.join(support, 'Lessons');
  const codexHome = path.join(root, 'codex');
  const hook = (name, ...values) => { try { return options[name]?.(...values); } catch (error) { console.error(`rach3 ${name}:`, error); return undefined; } };

  // Storage
  const load = name => readObject(path.join(root, name));
  const save = (value, name) => writeAtomic(path.join(root, name), JSON.stringify(value, null, 2), 0o600);
  let signIn = load('session.json') || {};
  const preferences = load('preferences.json') || {};
  const desk = createLessonDesk(path.join(root, 'desk'), progress => hook('onDeskEvent', { ...progress, event: 'desk-progress' }));

  // what is on screen, as core.js last said
  let pageHost = 'app', activeDesign = 'original';
  // core.js
  let coreReady = false, coreQueue = [], nextQuestion = 0;
  const answers = new Map();
  // sign-in
  let listener = null, signInError = null, signingIn = false, opening = false, refreshing = null;
  // Codex app-server
  let codex = null, codexToken = null, codexStarts = 0, ensuring = Promise.resolve();
  // hidden preview of the scratch copy, for Codex to check its work
  let previewSize = { width: 0, height: 0 }, previewWindow = null, previewErrors = [], previewing = Promise.resolve(), previewReady = false;

  function activeRoot() {
    if (activeDesign === 'original') return source;
    const folder = path.join(root, 'designs', activeDesign);
    return kindOf(folder) === 'folder' ? folder : source;
  }

  // Page files

  const answerWith = (data, type) => new Response(data ?? '', { status: data ? 200 : 404,
    headers: { 'Content-Type': data ? type : 'text/plain', 'Cache-Control': 'no-store', 'Content-Length': String(data ? data.length : 0) } });
  // The page's address as {host, path, document}; document: the page itself is being opened.
  function asked(request) {
    try {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
      // Electron does not say what a request is for. Opening a page asks for HTML first;
      // a script's fetch asks for anything.
      const wanted = String(request.headers?.get?.('accept') ?? '');
      return { host: url.hostname.toLowerCase(), path: relative || 'piano.html', document: wanted.startsWith('text/html') };
    } catch { return null; }
  }
  const isProtected = relative => relative === 'AGENTS.md' || relative.startsWith('assets/notation/') || relative.startsWith('assets/bravura/');
  async function fileAnswer(folder, relative) {
    const file = inside(folder, relative);
    let data = null;
    try { data = file ? await fs.promises.readFile(file) : null; } catch { data = null; }
    return answerWith(data, file ? mimeType(file) : '');
  }

  // The page and everything it loads: from the design on screen, at its branch's host.
  async function serve(request) {
    const target = asked(request);
    if (!target) return answerWith(null);
    const relative = target.path, ours = target.host === pageHost;
    if (relative.startsWith('_desk/')) {
      const served = ours ? await desk.servedFile(relative) : null;
      return answerWith(served?.data, served?.type);
    }
    if (relative === 'piano.html' && target.document) ask('page-loading', {}).catch(() => {});
    if (!ours) return answerWith(null);
    return fileAnswer(isProtected(relative) ? source : activeRoot(), relative);
  }
  // The same for the hidden preview, from the scratch copy.
  async function servePreview(request) {
    const target = asked(request);
    if (!target || target.path.startsWith('_desk/') || target.host !== 'app') return answerWith(null);
    return fileAnswer(isProtected(target.path) ? source : workspace, target.path);
  }

  // core.js

  const deliver = message => { hook('toCore', message); };
  function toCore(message) {
    if (!coreReady) { coreQueue.push(message); return; }
    deliver(message);
  }
  const toCoreIfReady = message => { if (coreReady) deliver(message); };

  function ask(command, body) {
    return new Promise((resolve, reject) => {
      const identifier = ++nextQuestion;
      answers.set(identifier, { resolve, reject });
      toCore({ request: identifier, command, body: body ?? {} });
    });
  }

  function coreRestarted() {
    coreReady = false;
    // Whatever core.js was doing is gone with it, Codex's conversation too.
    stopCodex(false);
    const waiting = [...answers.values()]; answers.clear();
    for (const answer of waiting) answer.reject(new Error('restarted'));
  }

  function authState() {
    let account = null;
    if (signIn.refresh_token) {
      const known = claims(signIn.id_token) || {};
      account = { email: known.email ?? '', name: known.name ?? '' };
    }
    return { signedIn: account != null, account, signingIn, signInError: signInError ?? null };
  }
  const publishAuth = () => toCoreIfReady({ auth: authState() });

  function location(place, write) {
    if (!isObject(place)) return null;
    const area = place.area, relative = place.path;
    if (typeof area !== 'string' || typeof relative !== 'string') return null;
    let folder = null;
    if (area === 'source' && !write) folder = source;
    else if (area === 'lessons') folder = lessonsFolder;
    else if (area === 'data') {
      if (!DATA_ENTRIES.has(relative.split('/')[0])) return null;
      folder = root;
    }
    return folder ? inside(folder, relative) : null;
  }

  const invalid = () => { throw new Error('invalid'); };
  const string = value => typeof value === 'string' ? value : '';

  // A binding core.js asked for ({op, ...}).
  async function native(body) {
    const op = isObject(body) ? body.op : null;
    if (typeof op !== 'string') invalid();
    switch (op) {
      case 'info':
        return { platform: process.platform === 'darwin' ? 'mac' : 'windows', version, language: hook('language') ?? 'en', available: available(), workspace };
      case 'preferences':
        return { welcomed: !!preferences.welcomed, open: !!preferences.open };
      case 'set-preference':
        if (!['welcomed', 'open'].includes(body.key)) invalid();
        preferences[body.key] = !!body.value; save(preferences, 'preferences.json');
        return {};
      case 'auth':
        return authState();
      case 'read':
        return readText(location(body, false));
      case 'write': {
        const file = location(body, true);
        if (!file || typeof body.text !== 'string') return false;
        makeFolder(path.dirname(file), 0o700);
        if (!body.exclusive) return writeAtomic(file, body.text);
        try { fs.writeFileSync(file, body.text, { flag: 'wx' }); return true; } catch { return false; }
      }
      case 'list': {
        const folder = location(body, false);
        return folder ? relativeFiles(folder) : [];
      }
      case 'exists': {
        const file = location(body, false);
        return file ? kindOf(file) : null;
      }
      case 'same': {
        const before = readData(location(body.a, false)), after = readData(location(body.b, false));
        return before === after || (!!before && !!after && before.equals(after));
      }
      case 'remove':
      case 'trash': {
        const file = location(body, true);
        if (file && file !== root && file !== lessonsFolder) {
          if (op === 'trash') { try { if (fs.existsSync(file)) await electron.shell.trashItem(file); } catch { /* stays where it is */ } }
          else remove(file);
        }
        return {};
      }
      case 'copy':
        return copyFrom(location(body.from, false), location(body.to, true));
      case 'move': {
        const from = location(body.from, true), to = location(body.to, true);
        if (!from || !to || to.startsWith(source + path.sep)) return false;
        return move(from, to);
      }
      case 'open-workspace':
        return makeFolder(workspace);
      case 'summaries': {
        const folder = location(body, false);
        return folder ? summaries(folder) : [];
      }
      case 'codex-ensure':
        return ensureCodex();
      case 'codex-write':
        if (typeof body.line === 'string') writeLine(body.line);
        return {};
      case 'sign-in': startSignIn(); return {};
      case 'cancel-sign-in': cancelSignIn(); return {};
      case 'sign-out': signOut(); return {};
      case 'open-usage': electron.shell.openExternal(USAGE_URL).catch(() => {}); return {};
      case 'preview':
        return preview(typeof body.script === 'string' ? body.script : null);
      case 'desk-entries': return desk.entries;
      case 'desk-add':
        if (isObject(body.entry)) desk.addEntry(body.entry);
        return {};
      case 'desk-clear': desk.clear(); return {};
      case 'desk-card': return desk.card(body.card) ?? null;
      case 'desk-update':
        if (isObject(body.card)) desk.update(body.card);
        return {};
      case 'desk-show': {
        const shown = await desk.show(string(body.source), string(body.title), string(body.note));
        return shown.card ? { card: shown.card } : { error: shown.error ?? '' };
      }
      case 'desk-event':
        if (isObject(body.event)) hook('onDeskEvent', body.event);
        return {};
      case 'missing-tools':
        return Number(hook('missingTools', string(body.kind))) || 0;
      case 'import-lesson': {
        const failed = () => ({ error: hook('text', 'Ders başlatılamadı.') ?? 'Ders başlatılamadı.' });
        if (typeof options.importLesson !== 'function') return failed();
        return hook('importLesson', { kind: body.kind ?? '', file: desk.fileOf(body.card) ?? null, link: body.link ?? null, title: body.title ?? '' }) ?? failed();
      }
      case 'open-lesson':
        if (isObject(body.lesson)) hook('onLessonChanged', body.lesson);
        return {};
      case 'panel':
        hook('onPanel', !!body.open, Number(body.toggle) || 0);
        return {};
      case 'show': {
        const host = body.host, design = body.design;
        if (typeof host !== 'string' || !host.length || /[^a-z0-9-]/.test(host.toLowerCase()) ||
            typeof design !== 'string' || inside(root, `designs/${design}`) == null) invalid();
        pageHost = host.toLowerCase(); activeDesign = design;
        hook('onShow', !!body.start);
        if (!coreReady) {
          coreReady = true;
          const queued = coreQueue; coreQueue = [];
          for (const message of queued) deliver(message);
        }
        return {};
      }
      case 'answer': {
        const answer = typeof body.id === 'number' ? answers.get(body.id) : null;
        if (answer) {
          answers.delete(body.id);
          if (typeof body.error === 'string') answer.reject(new Error(body.error)); else answer.resolve(body.value);
        }
        return {};
      }
      default: return invalid();
    }
  }

  // Sign in with ChatGPT

  function hostIdentifier() {
    if (!preferences.host) { preferences.host = `urn:uuid:${crypto.randomUUID().toLowerCase()}`; save(preferences, 'preferences.json'); }
    return preferences.host;
  }

  // The first free port of the ones ChatGPT lets rach3 answer on, with a server on it.
  async function openCallback() {
    for (let port = 1455; port < 1466; port++) {
      const server = http.createServer();
      const bound = await new Promise(resolve => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (bound) return { server, port };
    }
    return null;
  }

  async function startSignIn() {
    if (signingIn || opening) return;
    opening = true;
    const callbackServer = await openCallback().catch(() => null);
    opening = false;
    if (!callbackServer) { signInError = 'port'; publishAuth(); return; }
    const { server, port } = callbackServer;
    const verifier = randomToken(32), state = randomToken(16), nonce = randomToken(16);
    const redirect = `http://127.0.0.1:${port}/auth/callback`;
    const client = preferences.client || 'dynamic_agent_client';
    const query = { response_type: 'code', client_id: client, agent_name_hint: 'rach3', ext_agent_host_id: hostIdentifier(),
      redirect_uri: redirect, scope: SCOPE, resource: RESOURCE, state, nonce,
      code_challenge: base64URL(crypto.createHash('sha256').update(verifier, 'utf8').digest()), code_challenge_method: 'S256' };
    listener = server; signingIn = true; signInError = null; publishAuth();

    // The browser comes back to this computer with the answer; anything else gets "not found".
    const callback = new Promise(resolve => {
      server.on('request', (request, response) => {
        let target = null;
        try { target = new URL(request.url, 'http://127.0.0.1'); } catch { target = null; }
        const ours = target?.pathname === '/auth/callback';
        const page = ours ? '<!doctype html><meta charset=utf-8><title>rach3</title><body style="font:16px -apple-system,system-ui;background:#131416;color:#eee;display:grid;place-items:center;height:90vh"><p>rach3 ✓ — you can close this tab.</p>' : '';
        response.writeHead(ours ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page), Connection: 'close' });
        response.end(page, () => { if (ours) resolve(Object.fromEntries(target.searchParams)); });
      });
      server.on('close', () => resolve(null));
    });
    electron.shell.openExternal(`${AUTHORIZE_URL}?${formBody(query)}`).catch(() => {});

    const values = await callback;
    server.close(); server.closeAllConnections?.();
    if (listener === server) listener = null;
    if (!values) { signingIn = false; publishAuth(); return; }
    if (values.error || values.state !== state || !values.code) {
      signingIn = false; signInError = values.error === 'access_denied' ? 'denied' : 'failed';
      publishAuth(); return;
    }
    const issued = values.client_id || client;
    let { tokens, error } = await token({ grant_type: 'authorization_code', client_id: issued, code: values.code, code_verifier: verifier,
      redirect_uri: redirect, resource: RESOURCE });
    signingIn = false;
    const known = claims(tokens?.id_token);
    if (!error && (known?.nonce !== nonce || known?.iss !== 'https://auth.openai.com')) error = 'failed';
    if (!error && !String(tokens.scope ?? '').split(' ').includes(PLAN_SCOPE)) error = 'plan';
    if (error) { signInError = error; publishAuth(); return; }
    preferences.client = issued; save(preferences, 'preferences.json');
    storeTokens(tokens);
    try { app.focus({ steal: true }); } catch { /* the person brings rach3 forward */ }
    publishAuth();
  }

  function cancelSignIn() {
    const server = listener;
    listener = null;
    if (server) { server.close(); server.closeAllConnections?.(); }
    signingIn = false; publishAuth();
  }

  function storeTokens(tokens) {
    const next = { ...signIn };
    for (const key of ['access_token', 'refresh_token', 'id_token', 'scope']) if (tokens[key]) next[key] = tokens[key];
    next.expires_at = Date.now() / 1000 + (Number(tokens.expires_in) || 0);
    signIn = next; save(next, 'session.json');
  }

  // Answers {tokens} or {error}: offline, expired or failed.
  async function token(fields) {
    let status = 0, body = null;
    try {
      const answer = await globalThis.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody(fields), signal: AbortSignal.timeout(30000) });
      status = answer.status;
      const text = await answer.text();
      try { body = JSON.parse(text); } catch { body = null; }
    } catch { return { tokens: null, error: 'offline' }; }
    if (status !== 200 || !isObject(body) || !body.access_token) {
      const code = isObject(body) ? body.error : null;
      return { tokens: null, error: ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
        'refresh_token_invalidated', 'refresh_token_reused'].includes(code) ? 'expired' : 'failed' };
    }
    return { tokens: body, error: null };
  }

  // Hands back a token valid for at least ten more minutes; refreshes one at a time.
  function freshToken() {
    if (!signIn.refresh_token) return Promise.resolve({ error: 'signed-out' });
    if ((Number(signIn.expires_at) || 0) - Date.now() / 1000 > 600) return Promise.resolve({ token: signIn.access_token });
    if (!refreshing) {
      refreshing = token({ grant_type: 'refresh_token', client_id: preferences.client ?? '', refresh_token: signIn.refresh_token, resource: RESOURCE })
        .then(({ tokens, error }) => {
          refreshing = null;
          if (tokens) storeTokens(tokens);
          else if (error === 'expired') forgetSession();
          return tokens ? { token: signIn.access_token } : { error };
        });
    }
    return refreshing;
  }

  function forgetSession() {
    signIn = {};
    try { fs.rmSync(path.join(root, 'session.json'), { force: true }); } catch { /* nothing kept */ }
    stopCodex(true); publishAuth();
  }

  function signOut() {
    const refresh = signIn.refresh_token, client = preferences.client;
    if (refresh && client) {
      globalThis.fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ token: refresh, token_type_hint: 'refresh_token', client_id: client }) }).catch(() => {});
    }
    forgetSession();
  }

  // Codex

  const codexBinary = () => path.join(codexRoot || '', 'bin', WINDOWS ? 'codex.exe' : 'codex');
  function available() {
    if (!codexRoot) return false;
    try { fs.accessSync(codexBinary(), fs.constants.X_OK); return fs.statSync(codexBinary()).isFile(); } catch { return false; }
  }

  // Commands Codex runs may read the system's own tools and read and write the scratch
  // copy, nothing else: not the person's files, not rach3's other data, not the
  // network, and not the ChatGPT token. Codex itself may search the web (OpenAI runs
  // the search); rach3 fetches anything it shows the person. The same text on Mac and
  // Windows; Codex's own sandbox enforces it on each.
  function writeCodexConfiguration() {
    // TRIAL, development runs only: other settings to find what Windows can enforce.
    const trial = app.isPackaged ? {} : { profile: process.env.RACH3_CODEX_TRIAL_PROFILE, more: (process.env.RACH3_CODEX_TRIAL_MORE || '').replace(/\\n/g, '\n') };
    const config = '# Written by rach3 on every start.\n' +
      `default_permissions = "${trial.profile || 'rach3'}"\n` +
      'web_search = "live"\n\n' +
      '[shell_environment_policy]\n' +
      'ignore_default_excludes = false\n' +
      'exclude = ["ACCESS_TOKEN", "*TOKEN*", "*KEY*", "*SECRET*"]\n\n' +
      '[permissions.rach3.filesystem]\n' +
      '":minimal" = "read"\n' +
      `${tomlString(workspace)} = "write"\n` + (trial.more || '');
    writeAtomic(path.join(codexHome, 'config.toml'), config);
  }

  // What Codex is told about the computer: where its tools are, and no more of the
  // person's environment than a program needs to run.
  function codexEnvironment() {
    const inherited = process.env, environment = {};
    if (WINDOWS) {
      for (const key of ['SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
        'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'COMPUTERNAME',
        'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) if (inherited[key]) environment[key] = inherited[key];
      const system = inherited.SystemRoot || 'C:\\Windows';
      environment.PATH = [path.join(codexRoot, 'codex-path'), path.join(system, 'System32'), system,
        path.join(system, 'System32', 'Wbem'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
    } else {
      for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', '__CF_USER_TEXT_ENCODING']) if (inherited[key]) environment[key] = inherited[key];
      environment.PATH = `${path.join(codexRoot, 'codex-path')}:/usr/bin:/bin:/usr/sbin:/sbin`;
      environment.SHELL = '/bin/zsh';
    }
    environment.CODEX_HOME = codexHome;
    return environment;
  }

  // Codex's newer models send searches to a separate endpoint that ChatGPT sign-in
  // tokens may not use. The Responses API itself accepts its web search tool with
  // these tokens, so rach3 hands Codex its own bundled model list with that path on.
  function writeModelCatalog() {
    return new Promise(resolve => {
      execFile(codexBinary(), ['debug', 'models', '--bundled'], { env: codexEnvironment(), maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 60000 },
        (error, output) => {
          if (error) { resolve(null); return; }
          let catalog = null;
          try { catalog = JSON.parse(output); } catch { catalog = null; }
          if (!isObject(catalog) || !Array.isArray(catalog.models) || !catalog.models.length) { resolve(null); return; }
          for (const model of catalog.models) if (isObject(model)) model.use_responses_lite = false;
          const file = path.join(codexHome, 'models.json');
          resolve(writeAtomic(file, JSON.stringify(catalog)) ? file : null);
        });
    });
  }

  // Codex running with a sign-in valid for ten more minutes. fresh: a new Codex started,
  // which core.js then introduces itself to. One at a time.
  function ensureCodex() {
    const next = ensuring.then(async () => {
      const { token: access, error } = await freshToken();
      if (error) return { error };
      if (codex && codexToken === access) return { fresh: false };
      stopCodex(false);   // Codex reads the token at start
      const failure = await startCodex(access);
      return failure ? { error: failure } : { fresh: true };
    });
    ensuring = next.catch(() => null);
    return next;
  }

  async function startCodex(access) {
    if (!available()) return 'missing';
    const start = ++codexStarts;
    makeFolder(codexHome, 0o700);
    makeFolder(workspace);
    writeCodexConfiguration();
    const provider = 'model_providers.chatgpt_plan';
    // Development copies can talk to a stand-in for OpenAI, to try a whole change offline.
    const upstream = !app.isPackaged && process.env.RACH3_CODEX_UPSTREAM ? process.env.RACH3_CODEX_UPSTREAM : RESOURCE;
    const parameters = ['app-server', '--listen', 'stdio://',
      '-c', 'model_provider="chatgpt_plan"',
      '-c', `${provider}.name="ChatGPT plan"`,
      '-c', `${provider}.base_url=${tomlString(upstream)}`,
      '-c', `${provider}.env_key="ACCESS_TOKEN"`,
      '-c', `${provider}.wire_api="responses"`,
      '-c', `${provider}.requires_openai_auth=false`,
      '-c', `${provider}.supports_websockets=false`];
    const catalog = await writeModelCatalog();
    // core.js started over, or rach3 is closing, while the list was being read.
    if (start !== codexStarts) return 'codex';
    if (catalog) parameters.push('-c', `model_catalog_json=${tomlString(catalog)}`);
    let errors = 'ignore';
    if (!app.isPackaged) { try { errors = fs.openSync(path.join(codexHome, 'stderr.log'), 'w'); } catch { errors = 'ignore'; } }
    let task;
    try {
      task = spawn(codexBinary(), parameters, { cwd: workspace, env: { ...codexEnvironment(), ACCESS_TOKEN: access },
        stdio: ['pipe', 'pipe', errors], windowsHide: true });
    } catch { task = null; }
    if (typeof errors === 'number') { try { fs.closeSync(errors); } catch { /* Codex has its own handle */ } }
    if (!task) return 'missing';
    const launched = await new Promise(resolve => { task.once('spawn', () => resolve(true)); task.once('error', () => resolve(false)); });
    if (!launched) return 'missing';
    if (start !== codexStarts) { endTask(task); return 'codex'; }
    task.on('error', () => {});
    task.stdin.on('error', () => {});
    let buffer = Buffer.alloc(0);
    task.stdout.on('data', chunk => {
      if (task !== codex) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        let text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(line); } catch { text = null; }
        if (text != null) toCoreIfReady({ codex: 'line', text });
      }
    });
    task.on('close', () => {
      if (task !== codex) return;
      codex = null; codexToken = null;
      toCoreIfReady({ codex: 'exit' });
    });
    codex = task; codexToken = access;
    return null;
  }

  function endTask(task) {
    if (task.exitCode != null || task.signalCode != null) return;
    // On Windows ending Codex leaves the commands it started running; taskkill ends them with it.
    if (WINDOWS && task.pid) {
      try { spawn('taskkill', ['/pid', String(task.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => task.kill()); return; }
      catch { /* below */ }
    }
    task.kill();
  }

  // notify: core.js is told Codex stopped (it fails what was waiting on it). A restart
  // for a new sign-in does not tell it; it learns from codex-ensure.
  function stopCodex(notify) {
    const task = codex;
    codex = null; codexToken = null; codexStarts++;
    if (task) endTask(task);
    if (task && notify) toCoreIfReady({ codex: 'exit' });
  }

  function writeLine(line) {
    const input = codex?.stdin;
    if (!input || input.destroyed || !input.writable) return;
    try { input.write(`${line}\n`); } catch { /* Codex is gone */ }
  }

  // Hidden preview

  // desktop/customize/page-errors.js: reports runtime errors on the page so the person
  // and ChatGPT can see them.
  const errorScript = () => readText(path.join(options.scripts || '', 'page-errors.js')) ?? '';

  // The preview has its own storage, kept only while rach3 runs, and its own rule for
  // rach3-app addresses: there they are the scratch copy.
  function previewStore() {
    const store = session.fromPartition('rach3-preview');
    if (!previewReady) {
      previewReady = true;
      if (store.protocol.isProtocolHandled(SCHEME)) store.protocol.unhandle(SCHEME);
      store.protocol.handle(SCHEME, request => servePreview(request));
      // Pages, including ones Codex changed, may only load rach3's own files.
      store.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(rach3-app|data|blob|devtools):/.test(details.url) }));
      store.setPermissionRequestHandler((contents, permission, done) => done(false));
      store.setPermissionCheckHandler(() => false);
    }
    return store;
  }

  // The preview page talks to the same native commands as the real one, but only the
  // read-only ones are answered; nothing it does reaches the piano or lessons.
  ipcMain.removeHandler('rach3-preview');
  ipcMain.handle('rach3-preview', async (event, message) => {
    const contents = previewWindow && !previewWindow.isDestroyed() ? previewWindow.webContents : null;
    if (!contents || event.sender !== contents || !event.senderFrame || event.senderFrame.parent) return { value: {} };
    const body = isObject(message) ? message : {};
    if (body.command === 'page-error') {
      if (previewErrors.length < 30) previewErrors.push(body);
      return { value: {} };
    }
    if (typeof options.previewBridge !== 'function') return { value: {} };
    try { return { value: await options.previewBridge(body) ?? {} }; } catch { return { value: {} }; }
  });
  ipcMain.removeAllListeners('rach3-preview-script');
  ipcMain.on('rach3-preview-script', event => { event.returnValue = errorScript(); });

  // What a script handed back, as text for ChatGPT.
  const scriptRunner = script => `(async () => {
    const show = value => { if (value === undefined) return 'undefined'; if (typeof value === 'string') return value;
      try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; } catch { return String(value); } };
    try { return show(await (async () => {\n${script}\n})()); }
    catch (error) { return 'Error: ' + (error && error.message ? error.message : String(error)); }
  })()`;

  // Opens the scratch copy in a window the person never sees, runs script, and answers
  // {errors, scriptResult, image, snapshotError} or {timedOut, errors}.
  function preview(script) {
    const next = previewing.then(() => runPreview(script));
    previewing = next.catch(() => null);
    return next;
  }

  async function runPreview(script) {
    const size = previewSize.width > 0 && previewSize.height > 0 ? previewSize : { width: 1340, height: 900 };
    // Drawn without a window on screen: it renders like a real window but the person never sees it.
    const window = new BrowserWindow({ show: false, width: Math.round(size.width), height: Math.round(size.height), useContentSize: true, frame: false,
      skipTaskbar: true, focusable: false, enableLargerThanScreen: true, backgroundColor: '#131417',
      webPreferences: { session: previewStore(), preload: path.join(__dirname, 'preload-preview.js'), offscreen: true, contextIsolation: true,
        sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    previewWindow = window;
    previewErrors = [];
    const contents = window.webContents;
    const address = `${SCHEME}://app/piano.html`;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (!url.startsWith(`${SCHEME}://app/`)) event.preventDefault(); });
    contents.on('did-start-navigation', (event, url, inPlace, mainFrame) => { if (mainFrame && !inPlace) previewErrors = []; });
    let timer = null;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true, errors: [...previewErrors] }), 25000); });
    const shown = (async () => {
      await new Promise(resolve => {
        contents.once('did-finish-load', () => resolve());
        contents.loadURL(address).catch(() => {});   // a page that never loads runs into the 25 seconds
      });
      await wait(2500);
      let scriptResult;
      if (script != null) {
        let broken = null;
        // Only reads the script, to tell ChatGPT about a slip of the pen; it runs in the page.
        try { new (Object.getPrototypeOf(async () => {}).constructor)(script); } catch (error) { broken = `Error: ${error.message}`; }
        try { scriptResult = broken ?? await contents.executeJavaScript(scriptRunner(script), false); }
        catch (error) { scriptResult = `Error: ${error?.message || error}`; }
      }
      await wait(800);
      const result = { errors: [...previewErrors] };
      if (script != null) result.scriptResult = scriptResult ?? 'undefined';
      try {
        const image = await contents.capturePage();
        if (image.isEmpty()) result.snapshotError = 'unknown';
        else result.image = `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`;
      } catch (error) { result.snapshotError = error?.message || 'unknown'; }
      return result;
    })().catch(error => ({ errors: [...previewErrors], snapshotError: error?.message || 'unknown' }));
    try { return await Promise.race([shown, late]); }
    finally {
      clearTimeout(timer);
      if (previewWindow === window) previewWindow = null;
      if (!window.isDestroyed()) window.destroy();
    }
  }

  const needsSeed = host => host !== 'app' && !(Array.isArray(preferences.seeded) && preferences.seeded.includes(host));

  function stop() {
    cancelSignIn(); stopCodex(false);
    // Hidden windows would otherwise keep rach3 running after its window closed.
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
    for (const window of pdfWindows) if (!window.isDestroyed()) window.destroy();
  }

  return {
    // Whether this copy of rach3 carries Codex, so ChatGPT features can be offered.
    get available() { return available(); },
    // The page's address. Each branch has its own host, so its stored settings
    // (localStorage) are its own and can never reach main's.
    get pageURL() { return `${SCHEME}://${pageHost || 'app'}/piano.html`; },
    // A branch opened for the first time starts with the settings of the page it was
    // opened from, copied once.
    needsSeed,
    markSeeded(host) {
      if (!needsSeed(host)) return;
      preferences.seeded = [...(Array.isArray(preferences.seeded) ? preferences.seeded : []), host];
      save(preferences, 'preferences.json');
    },
    native,
    // A request for core.js: lesson-list, lesson-load, lesson-delete, page-error, desk-*,
    // lesson-progress, language, restore-original. Waits until core.js has started.
    ask,
    // The panel's web view was made again; core.js starts over in it.
    coreRestarted,
    stop,
    deskCard: identifier => desk.card(identifier) ?? null,
    serve,
    get errorScript() { return errorScript(); },
    get previewSize() { return previewSize; },
    set previewSize(size) { previewSize = { width: Number(size?.width) || 0, height: Number(size?.height) || 0 }; },
  };
}

module.exports = { createCustomize, scheme: SCHEME };
