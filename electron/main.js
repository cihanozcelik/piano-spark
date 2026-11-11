'use strict';
// rach3's one shell for Mac and Windows: a window around the same offline page, with the
// Customize panel beside it. What the page and the panel ask of the computer is in the
// modules next to this file; this file is the window and what happens in it.
const { app, BaseWindow, WebContentsView, ipcMain, protocol, session, Menu, dialog, shell, screen, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { locate } = require('./files');
const { fileSettings, macSettings } = require('./settings');
const { createLocalization } = require('./localization');
const { createLessons } = require('./lessons');
const { createBluetooth } = require('./bluetooth');
const { createCustomize } = require('./customize');
const { createUpdates } = require('./updates');
const { captureOptions, runCapture, selfTestUpdate } = require('./self-test');
const { createEarlierState, readMac, readWindows } = require('./earlier-state');

const MAC = process.platform === 'darwin';
const INSTALLED = app.isPackaged;
// Checks the app runs on itself when asked from the command line (self-test.js).
// "--capture": screenshots from a throwaway data folder; nothing of the person's is read or written.
const capture = captureOptions(process.argv);
// "--self-test-update FOLDER KEY RESULT": only in a test build, which carries the file "self-test".
const updateTestAt = process.argv.indexOf('--self-test-update');
const updateTest = updateTestAt > 0 && process.argv.length > updateTestAt + 3 && INSTALLED && !MAC &&
  fs.existsSync(path.join(process.resourcesPath, 'self-test')) ? process.argv.slice(updateTestAt + 1, updateTestAt + 4) : null;
// Velopack's install, update and uninstall hooks run first on Windows, and exit.
if (!MAC && INSTALLED) require('./updates-windows').runHooks(updateTest ? updateTest[2] + '.log' : null);

// ---- Folders ---------------------------------------------------------------------------
// The person's data stays where rach3 always kept it. RACH3_SUPPORT moves it, for tests.
const support = capture ? path.join(app.getPath('temp'), 'Rach3Capture') : process.env.RACH3_SUPPORT
  || (MAC ? path.join(app.getPath('appData'), 'Rach3') : path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Rach3'));
app.setName('rach3');
app.setPath('userData', path.join(support, 'Electron'));
const files = locate({ packaged: INSTALLED, resources: process.resourcesPath });
if (process.env.RACH3_CODEX_ROOT) files.codex = process.env.RACH3_CODEX_ROOT;
const release = JSON.parse(fs.readFileSync(files.release, 'utf8'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'rach3-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// The app's own defaults exist only for the installed Mac app; a copy run from the
// repository keeps its settings in the data folder.
const settings = capture ? fileSettings(path.join(support, `capture-${process.pid}.json`))
  : MAC && INSTALLED ? macSettings(systemPreferences) : fileSettings(path.join(support, 'settings.json'));
if (capture) settings.set('Rach3Language', capture.language);
const localization = createLocalization({ settings, systemLocale: () => app.getPreferredSystemLanguages()[0] || app.getLocale() });
const text = source => localization.text(source);

// What the page had saved in the rach3 before this shell (earlier-state.js), for an
// installed copy using the person's own data folder. RACH3_EARLIER names another place to
// read it from, for tests.
const earlier = capture || updateTest || !(INSTALLED ? !process.env.RACH3_SUPPORT || process.env.RACH3_EARLIER : process.env.RACH3_EARLIER) ? null
  : createEarlierState({ file: path.join(support, 'Electron', 'earlier-page-state.json'),
    read: () => MAC ? readMac(process.env.RACH3_EARLIER || undefined) : readWindows(process.env.RACH3_EARLIER || support, require('electron')) });

// ---- State -----------------------------------------------------------------------------
let window, pageView, panelView, video;        // video: { view, full }
let pageURL = null, pageReady = false, reloadPending = false, pendingSeed = null;
let panelOpen = false, toggleWidth = 110, roomStyle = null;
let pendingLesson = null, pendingVideo = null;
let pageInput = 0;                             // the last real click or key press on the page
let quitting = false, savingWorkspace = false, uninstalling = false, leaving = false;
let lessons, bluetooth, customize, updates;

const pageSession = () => session.fromPartition(capture ? 'rach3-capture' : 'persist:rach3');
const alive = view => view && !view.webContents.isDestroyed();

function publish(event) {
  if (!pageReady || quitting || !alive(pageView)) return;
  const localized = localization.localizedStatus(event);
  if (event.status) localized.status = localization.localizedStatus(event.status);
  pageView.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('rach3-native-event', { detail: ${JSON.stringify(localized)} }));`)
    .catch(error => console.error('rach3 arayüz aktarımı:', error.message));
}

const snapshot = () => ({ event: 'snapshot', language: localization.language(), status: localization.localizedStatus(bluetooth.state),
  held: bluetooth.held(), fullscreen: window.isFullScreen() });

// ---- Services --------------------------------------------------------------------------
function startServices() {
  lessons = createLessons({
    engine: files.engine, support, tools: path.join(support, 'Tools', '1'), text, logs: path.join(support, 'Logs'),
    onEvent: event => { publish(event); customize.ask('lesson-progress', { snapshot: event }).catch(() => {}); },
    onIdle: () => setImmediate(finishTermination),
  });
  bluetooth = createBluetooth({ text, settings, publish, onStopped: () => setImmediate(finishTermination) });
  customize = createCustomize({
    source: files.source, scripts: files.scripts, codexRoot: files.codex, support, version: release.version,
    language: () => localization.language(), text,
    toCore: message => { if (alive(panelView)) panelView.webContents.executeJavaScript(`window.rach3Core?.receive(${JSON.stringify(message)});`).catch(() => {}); },
    onShow: showDesign,
    onPanel: (open, toggle) => {
      panelOpen = Boolean(open);
      toggleWidth = Math.max(60, Math.min(240, Number(toggle) || 0));
      layout();
      (panelOpen ? panelView : pageView).webContents.focus();
    },
    // The "With AI" tab of Create a Lesson: lessons come from rach3's own import.
    onDeskEvent: publish,
    missingTools: kind => lessons.missingToolBytes(kind),
    importLesson: async request => {
      try {
        let job = null;
        if (request.kind === 'youtube' && typeof request.link === 'string') job = await lessons.importYouTube(request.link, request.title);
        else if (typeof request.file === 'string') job = await lessons.importFile(request.file, request.kind, request.title);
        if (!job) return { error: text('Ders başlatılamadı.') };
        setImmediate(() => publish(lessons.snapshot()));
        return { job };
      } catch (error) { return { error: error.message || text('Ders başlatılamadı.') }; }
    },
    previewBridge,
    // Opens a lesson ChatGPT made, once the version saved with it is on screen.
    onLessonChanged: lesson => {
      pendingLesson = { event: 'lesson-progress', phase: 'complete', progress: 1, message: '', id: lesson.id, title: lesson.title || '', noteCount: lesson.noteCount || 0 };
      if (pageReady && !reloadPending) openPendingLesson();
    },
  });
  updates = createUpdates({ release, settings, installed: INSTALLED, resources: process.resourcesPath, onChange: publish,
    language: () => localization.language(), text });
}

function openPendingLesson() {
  const event = pendingLesson;
  pendingLesson = null;
  if (event) publish(event);
}

// What the hidden preview may ask the native side: reading only.
async function previewBridge(body) {
  customize.previewSize = pageSize();
  switch (body?.command) {
    case 'get-language': return { language: localization.language() };
    case 'subscribe': return snapshot();
    case 'update-state': return updates.snapshot();
    case 'lesson-state': return lessons.snapshot();
    case 'lesson-tools': return lessons.tools();
    case 'lesson-list': return customize.ask('lesson-list', { preview: true }).catch(() => []);
    case 'lesson-load': return customize.ask('lesson-load', { id: body.id ?? '', preview: true }).then(result => parsedLesson(result) || {}, () => ({}));
    default: return {};
  }
}

// core.js hands a lesson over as its saved JSON text.
function parsedLesson(result) {
  if (!result || typeof result.json !== 'string') return null;
  try { const lesson = JSON.parse(result.json); return lesson && typeof lesson === 'object' && !Array.isArray(lesson) ? lesson : null; } catch { return null; }
}

// ---- What the page asks ----------------------------------------------------------------
const gesture = ['desk-send', 'desk-make', 'desk-clear', 'desk-play', 'desk-sign-in'];
const pageCommands = {
  'get-language': () => ({ language: localization.language() }),
  'set-language': body => {
    if (!['en', 'tr'].includes(body.language)) throw new Error(text('Desteklenmeyen dil.'));
    localization.setLanguage(body.language);
    makeMenus();
    setImmediate(() => {
      publish({ event: 'language', language: localization.language() });
      publish(snapshot()); publish(updates.snapshot()); publish(lessons.snapshot());
      customize.ask('language', { language: localization.language() }).catch(() => {});
    });
    return { language: localization.language() };
  },
  subscribe: () => {
    pageReady = true;
    console.log('rach3 arayüzü hazır');
    makeRoomForToggle();
    customize.markSeeded(new URL(pageURL).host);
    earlier?.taken(new URL(pageURL).host);
    if (pendingLesson) setTimeout(openPendingLesson, 800);
    if (capture && !capture.started) {
      capture.started = true;
      runCapture(capture, { run: inPage, shot: () => pageView.webContents.capturePage() }, code => { leaving = true; app.exit(code); });
    }
    return snapshot();
  },
  unsubscribe: () => { pageReady = false; return {}; },
  'update-state': () => updates.snapshot(),
  'update-check': () => { setImmediate(() => updates.check()); return {}; },
  'update-read': () => { updates.acknowledge(); return {}; },
  connect: body => bluetooth.command(body),
  scan: body => bluetooth.command(body),
  disconnect: body => bluetooth.command(body),
  'output-start': body => bluetooth.command(body),
  'output-stop': body => bluetooth.command(body),
  'output-heartbeat': body => bluetooth.command(body),
  // On the Mac the header is the title bar and the system moves the window (see windowStyle).
  'drag-window': () => ({}),
  'title-double-click': () => ({}),
  fullscreen: () => { window.setFullScreen(!window.isFullScreen()); return {}; },
  'page-error': body => {
    console.error('rach3 JavaScript:', body.message);
    if (capture) capture.errors.push(String(body.message));
    customize.ask('page-error', { error: body }).catch(() => {});
    return {};
  },
  'lesson-state': () => lessons.snapshot(),
  'lesson-tools': () => lessons.tools(),
  'lesson-list': () => customize.ask('lesson-list', { preview: false }).catch(() => []),
  // Changed code may run on this page, so it can delete only what is visible here,
  // and the person's own lessons only from the original rach3.
  'lesson-delete': async body => {
    const id = body.id ?? '';
    let result;
    try { result = await customize.ask('lesson-delete', { id }); }
    catch (refusal) { throw new Error(text(refusal.message === 'original-only' ? 'Kendi derslerini orijinal rach3’ten silebilirsin.' : 'Bu ders burada yok.')); }
    if (!result?.personal) return {};
    return { ok: Boolean(await lessons.deleteLesson(id)) };
  },
  'lesson-load': async body => {
    const lesson = parsedLesson(await customize.ask('lesson-load', { id: body.id ?? '', preview: false }).catch(() => null));
    if (!lesson) throw new Error(text('Bu ders burada yok.'));
    return lesson;
  },
  'lesson-begin': body => lessons.begin(body),
  'lesson-chunk': async body => ({ ok: Boolean(await lessons.append(body.data, body.id)) }),
  'lesson-start': async body => ({ ok: Boolean(await lessons.start(body.id)) }),
  'lesson-cancel': () => { lessons.cancel(); return {}; },
  'desk-state': () => customize.ask('desk-state', {}),
  'desk-stop': () => customize.ask('desk-stop', {}),
  'desk-video-place': body => { placeVideo(body); return {}; },
  'desk-video-close': () => { closeVideo(); return {}; },
  'desk-send': body => {
    const message = typeof body.text === 'string' ? body.text : '';
    if (!message.trim()) throw new Error('empty');
    return customize.ask('desk-send', { text: message });
  },
  'desk-make': body => customize.ask('desk-make', { card: body.card ?? '' }),
  'desk-clear': () => customize.ask('desk-clear', {}),
  'desk-play': body => {
    const card = customize.deskCard(body.card);
    if (typeof card?.link !== 'string') throw new Error('missing');
    if (card.embeddable === false) {
      // Its owner does not let it play inside other apps; it opens on YouTube.
      let link; try { link = new URL(card.link); } catch {}
      if (link?.protocol === 'https:' && link.host === 'www.youtube.com') shell.openExternal(link.href);
      return { external: true };
    }
    playVideo(card.link);
    return {};
  },
  'desk-sign-in': () => { if (!panelOpen) toggleCustomize(); return {}; },
};

async function answerPage(event, body) {
  const frame = event.senderFrame;
  let origin; try { origin = new URL(frame.url); } catch {}
  const current = pageURL && new URL(pageURL);
  if (!alive(pageView) || event.sender !== pageView.webContents || frame !== pageView.webContents.mainFrame || !current ||
      origin?.protocol !== current.protocol || origin.host !== current.host || !body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Unknown page');
  const handler = Object.hasOwn(pageCommands, body.command) ? pageCommands[body.command] : null;
  if (!handler) throw new Error('Unknown command');
  // Code ChatGPT changed runs on this page, so commands that spend the person's
  // ChatGPT plan or start work need a real click or key press on the page first.
  if (gesture.includes(body.command)) {
    if (Date.now() - pageInput > 2000) throw new Error(text('Bunu bir tıklamayla ya da Enter’la yap.'));
    pageInput = 0;
  }
  return handler(body);
}

const answer = handler => async (event, body) => {
  try { return { value: (await handler(event, body)) ?? null }; }
  catch (error) { return { error: String(error?.message ?? error) }; }
};

// ---- The page --------------------------------------------------------------------------
// The scripts every page of rach3 starts with, before its own.
const mark = (key, value) => `(() => { const mark = () => { if (!document.documentElement) return false; document.documentElement.dataset.${key} = ${JSON.stringify(value)}; return true; };` +
  ` if (!mark()) new MutationObserver((changes, observer) => { if (mark()) observer.disconnect(); }).observe(document, { childList: true }); })();`;
function pageScripts(address) {
  const scripts = [customize.errorScript];
  // On the Mac the page's header is the title bar: it leaves room for the window buttons.
  if (MAC) { if (!capture) scripts.push(mark('windowControls', 'mac')); }
  // Windows's wording for the page's strings that name the Mac.
  else { try { scripts.push(`window.PianoPlatformText = ${JSON.stringify(JSON.parse(fs.readFileSync(files.platformText, 'utf8')))};`); } catch {} }
  // Only a copy that carries Codex offers the "With AI" tab.
  if (customize.available) scripts.push(mark('lessonChat', '1'));
  let host; try { host = new URL(address).host; } catch {}
  // What this page had saved in the rach3 before this shell, once.
  const before = host && earlier?.script(host);
  if (before) scripts.push(before);
  // First visit to a branch: it starts with the settings of the page it was opened from.
  if (pendingSeed && host === pendingSeed.host)
    scripts.push(`(() => { if (location.host !== ${JSON.stringify(pendingSeed.host)}) return; try {` +
      ` if (localStorage.getItem('rach3.seeded')) return;` +
      ` for (const [key, value] of Object.entries(${JSON.stringify(pendingSeed.values)})) if (typeof value === 'string') localStorage.setItem(key, value);` +
      ` localStorage.setItem('rach3.seeded', '1'); } catch {} })();`);
  return scripts;
}

const samePage = address => {
  let target, current;
  try { target = new URL(address); current = new URL(pageURL); } catch { return false; }
  return target.protocol === current.protocol && target.host === current.host && (target.pathname.length <= 1 || target.pathname === current.pathname);
};

function makePage() {
  const pages = pageSession();
  pages.protocol.handle('rach3-app', request => customize.serve(request));
  // Pages, including ones Codex changed, may only load rach3's own files.
  pages.webRequest.onBeforeRequest((details, done) => done({ cancel: /^(https?|wss?|ftp):/i.test(details.url) }));
  pages.setPermissionRequestHandler((contents, permission, done) => done(false));
  pages.setPermissionCheckHandler(() => false);
  pages.on('will-download', (event, item) => {
    item.setSaveDialogOptions({ title: text('Kaydet'), buttonLabel: text('Kaydet'), defaultPath: item.getFilename() });
    item.once('done', (done, state) => {
      if (state === 'interrupted') dialog.showMessageBox(window, { type: 'error', message: text('Dosya kaydedilemedi'), buttons: [text('Tamam')] });
    });
  });

  pageView = new WebContentsView({ webPreferences: { session: pages, preload: path.join(__dirname, 'preload-page.js'),
    contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
  pageView.setBackgroundColor('#131417');
  const contents = pageView.webContents;
  contents.on('will-navigate', (event, address) => { if (!samePage(address)) event.preventDefault(); });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('input-event', (event, input) => {
    if ((input.type === 'mouseDown' && input.button === 'left') || input.type === 'rawKeyDown' || input.type === 'keyDown') pageInput = Date.now();
  });
  contents.on('before-input-event', shortcuts);
  contents.on('did-fail-load', (event, code, description, address, mainFrame) => {
    if (!mainFrame || code === -3) return;
    dialog.showMessageBox(window, { type: 'error', message: text('rach3 açılamadı'), detail: description, buttons: [text('Tamam')] });
  });
  contents.on('render-process-gone', () => { pageReady = false; bluetooth.stop(); if (!quitting) contents.reload(); });
  contents.on('did-finish-load', () => { pendingSeed = null; windowStyle(); });
  window.contentView.addChildView(pageView);
}

function loadPage(address, seed) {
  closeVideo();
  let values = null;
  if (seed) { try { const parsed = JSON.parse(seed); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed; } catch {} }
  pendingSeed = seed ? { host: new URL(address).host, values: values || {} } : null;
  reloadPending = false; pageReady = false;
  pageURL = address;
  roomStyle = null;
  pageView.webContents.loadURL(address).catch(() => {});
}

// core.js put a design on screen. When the panel has just (re)loaded, a page that
// already shows that design stays as it is.
function showDesign(start) {
  const next = customize.pageURL;
  if (!pageURL) { loadPage(next, null); return; }
  if (start && next === pageURL) return;
  reloadDesign();
}

const inPage = code => pageView.webContents.executeJavaScript(`(async () => { ${code} })()`);

// Shows the design that just became active. Waits while a lesson video is being handed over.
async function reloadDesign() {
  closeVideo();
  if (reloadPending) return;
  reloadPending = true;
  const busy = await inPage(`return document.documentElement.dataset.lessonPhase === 'upload';`).catch(() => false);
  if (busy) { setTimeout(() => { reloadPending = false; reloadDesign(); }, 1000); return; }
  await inPage(`window.dispatchEvent(new Event('rach3-save-state'));`).catch(() => {});
  const next = customize.pageURL, host = new URL(next).host;
  if (host === new URL(pageURL).host || !customize.needsSeed(host)) { loadPage(next, null); return; }
  // First visit to this branch: it starts with this page's settings.
  const stored = await inPage(`return JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));`).catch(() => null);
  loadPage(next, typeof stored === 'string' ? stored : '{}');
}

// The page's own look that belongs to the window, kept out of reach of changed code.
function windowStyle() {
  if (!MAC || capture) return;
  // The header is the title bar: an empty part of it moves the window, a double click
  // zooms or minimizes it as the Mac is set to, exactly like a title bar.
  pageView.webContents.insertCSS('.app-bar { -webkit-app-region: drag; }' +
    ' .app-bar :is(button,a,input,select,textarea,label,summary,[role=tab],.popover-content,[contenteditable]) { -webkit-app-region: no-drag; }' +
    ' html[data-fullscreen=true] .app-bar { -webkit-app-region: no-drag; }').catch(() => {});
}

// ---- The Customize panel ---------------------------------------------------------------
// A separate web view beside the page, so a version changed by ChatGPT has no way to
// reach it: not its DOM, its keys, or its commands.
function makePanel() {
  let core, script;
  try {
    core = fs.readFileSync(path.join(files.scripts, 'core.js'), 'utf8');
    script = fs.readFileSync(path.join(files.scripts, 'panel.js'), 'utf8');
  } catch { return; }
  panelView = new WebContentsView({ webPreferences: { session: session.fromPartition('rach3-panel'), preload: path.join(__dirname, 'preload-panel.js'),
    contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, transparent: true } });
  panelView.setBackgroundColor('#00000000');
  const contents = panelView.webContents, view = panelView;
  // The panel never leaves its own page.
  contents.on('will-navigate', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('before-input-event', shortcuts);
  contents.once('dom-ready', async () => {
    try { await contents.executeJavaScript(core + '\n;0'); await contents.executeJavaScript(script + '\n;0'); }
    catch (error) { console.error('rach3 panel:', error.message); }
  });
  contents.on('render-process-gone', () => {
    if (panelView !== view || quitting) return;
    window.contentView.removeChildView(view);
    panelView = null; panelOpen = false;
    customize.coreRestarted();
    makePanel(); layout();
  });
  toggleWidth = 110;
  contents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body></body></html>'));
  window.contentView.addChildView(panelView);
}

const pageSize = () => { const bounds = pageView.getBounds(); return { width: bounds.width, height: bounds.height }; };

// Open, the panel takes the right side of the window and the page gets the rest.
// Closed, only its button shows, at the end of the page's header.
function layout() {
  if (!window || window.isDestroyed()) return;
  const { width, height } = window.getContentBounds();
  if (!alive(panelView)) pageView.setBounds({ x: 0, y: 0, width, height });
  else if (panelOpen) {
    const panel = Math.min(400, Math.max(300, width - 480));
    pageView.setBounds({ x: 0, y: 0, width: width - panel, height });
    panelView.setBounds({ x: width - panel, y: 0, width: panel, height });
  } else {
    const button = Math.round(toggleWidth + 28);
    pageView.setBounds({ x: 0, y: 0, width, height });
    panelView.setBounds({ x: width - button, y: 0, width: button, height: 48 });
  }
  if (customize) customize.previewSize = pageSize();
  makeRoomForToggle();
}

// Keeps the end of the page's header clear for the button while the panel is closed.
async function makeRoomForToggle() {
  if (!pageReady || !alive(panelView)) return;
  const room = panelOpen ? 0 : toggleWidth + 28, previous = roomStyle, contents = pageView.webContents;
  roomStyle = room ? contents.insertCSS(`.app-bar { padding-right: ${room}px !important; }`) : null;
  if (previous) previous.then(key => contents.removeInsertedCSS(key)).catch(() => {});
}

function toggleCustomize() {
  if (alive(panelView)) panelView.webContents.executeJavaScript('window.rach3Customize?.toggle();').catch(() => {});
}
const restoreOriginalDesign = () => customize.ask('restore-original', {}).catch(() => {});

// Windows has no menu bar, so its two shortcuts are read from the keys themselves.
function shortcuts(event, input) {
  if (MAC || input.type !== 'keyDown') return;
  if (input.key === 'F11') { event.preventDefault(); window.setFullScreen(!window.isFullScreen()); }
  else if (input.key.toLowerCase() === 'k' && input.control && !input.alt && !input.shift) { event.preventDefault(); toggleCustomize(); }
}

// ---- A YouTube video ChatGPT showed ----------------------------------------------------
// It plays over its card. The page itself stays offline, so the player is a separate view
// the page only positions. YouTube plays only when told which site embeds it, so the
// player's request names rach3's website, as the earlier apps did.
const EMBEDDER = 'https://rach3.com/';
function playVideo(link) {
  let identifier = null;
  try { identifier = new URL(link).searchParams.get('v'); } catch {}
  if (!identifier || !/^[A-Za-z0-9_-]{11}$/.test(identifier)) return;
  if (!video) {
    const players = session.fromPartition('rach3-video');
    players.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/embed/*'] },
      (details, done) => done({ requestHeaders: { ...details.requestHeaders, Referer: EMBEDDER } }));
    const view = new WebContentsView({ webPreferences: { session: players, contextIsolation: true, sandbox: true, nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required' } });
    view.setBackgroundColor('#000000');
    video = { view, full: false };
    const contents = view.webContents;
    // The player keeps its YouTube frame; links that would replace it open in the browser.
    contents.on('will-navigate', (event, address) => {
      event.preventDefault();
      if (address.startsWith('https://')) shell.openExternal(address);
    });
    contents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
    contents.on('enter-html-full-screen', () => { if (video?.view === view) { video.full = true; placeVideo(video.place); } });
    contents.on('leave-html-full-screen', () => { if (video?.view === view) { video.full = false; placeVideo(video.place); } });
    contents.on('render-process-gone', () => { if (video?.view === view) closeVideo(); });
    window.contentView.addChildView(view);
  }
  video.view.setVisible(false);   // until the page says where the card is
  video.place = null;
  video.view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta name=viewport content="width=device-width">' +
    '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;position:absolute;left:0;top:0;width:100%;height:100%;display:block}</style>' +
    `<iframe src="https://www.youtube-nocookie.com/embed/${identifier}?autoplay=1&rel=0&playsinline=1" ` +
    'allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>')).catch(() => {});
}
// The page reports the card's frame and the part of it that is visible, in its own pixels.
function placeVideo(body) {
  if (!video) return;
  video.place = body;
  const { view } = video;
  if (video.full) {
    const { width, height } = window.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height }); view.setVisible(true);
    view.webContents.executeJavaScript(`document.querySelector('iframe').style.cssText = '';`).catch(() => {});
    return;
  }
  const box = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    ? { x: value[0], y: value[1], width: Math.max(0, value[2]), height: Math.max(0, value[3]) } : null;
  const outer = box(body?.clip), inner = box(body?.frame);
  if (!outer || !inner || outer.width < 1 || outer.height < 1) { view.setVisible(false); return; }
  const origin = pageView.getBounds();
  view.setBounds({ x: Math.round(origin.x + outer.x), y: Math.round(origin.y + outer.y), width: Math.round(outer.width), height: Math.round(outer.height) });
  // The view shows only the visible part; the player inside keeps the card's full size.
  view.webContents.executeJavaScript(`document.querySelector('iframe').style.cssText = ` +
    `'left:${inner.x - outer.x}px;top:${inner.y - outer.y}px;width:${inner.width}px;height:${inner.height}px';`).catch(() => {});
  view.setVisible(true);
}
function closeVideo() {
  if (!video) return;
  const { view } = video;
  video = null;
  if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

// ---- Menus -----------------------------------------------------------------------------
function makeMenus() {
  if (!MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'rach3', submenu: [
      { label: text('rach3 Hakkında'), role: 'about' },
      { label: text('Güncellemeleri denetle…'), click: () => updates.check() },
      { type: 'separator' },
      { label: text('rach3’ü Gizle'), role: 'hide', accelerator: 'Command+H' },
      { label: text('rach3’ü kaldır…'), click: uninstall },
      { type: 'separator' },
      { label: text('rach3’ü değiştir…'), accelerator: 'Command+K', click: toggleCustomize },
      { label: text('Orijinal rach3’ü etkinleştir'), click: restoreOriginalDesign },
      { type: 'separator' },
      { label: text('rach3’ten Çık'), accelerator: 'Command+Q', click: () => app.quit() },
    ] },
    { label: text('Düzenle'), submenu: [
      { label: text('Kopyala'), role: 'copy', accelerator: 'Command+C' },
      { label: text('Yapıştır'), role: 'paste', accelerator: 'Command+V' },
      { label: text('Tümünü Seç'), role: 'selectAll', accelerator: 'Command+A' },
    ] },
    { label: text('Görünüm'), submenu: [
      { label: text('Tam Ekran'), accelerator: 'Control+Command+F', click: () => window.setFullScreen(!window.isFullScreen()) },
    ] },
  ]));
}

function showError(message) {
  dialog.showMessageBox(window, { type: 'none', message: 'rach3', detail: text(message) || text('İşlem tamamlanamadı.'), buttons: [text('Tamam')] });
}

// ---- Opening a video with rach3 --------------------------------------------------------
async function openVideo(file) {
  if (!lessons) { pendingVideo = file; return; }
  try { await lessons.openVideo(file); } catch (error) { showError(error.message); }
}
app.on('open-file', (event, file) => { event.preventDefault(); openVideo(file); });
// A video handed to rach3 on its command line (Windows "Open with"): a file, never a
// folder, an option or an option's value; none while the app checks itself.
function fileArgument(argv) {
  if (capture || updateTest) return null;
  const isFile = value => { try { return fs.statSync(value).isFile(); } catch { return false; } };
  return argv.slice(INSTALLED ? 1 : 2).find((value, index, values) =>
    !value.startsWith('-') && !(values[index - 1] || '').startsWith('--') && path.isAbsolute(value) && isFile(value)) || null;
}

// ---- Leaving ---------------------------------------------------------------------------
function saveWindow() {
  if (!window || window.isDestroyed()) return;
  const bounds = window.getNormalBounds();
  settings.set('Window', { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized: window.isMaximized() });
}
// Where the Mac app kept its window before this shell: "x y width height …", measured
// from the bottom of the main screen. Read once, so the first launch opens in the same place.
function earlierMacWindow() {
  if (!MAC || !INSTALLED) return null;
  const [x, y, width, height] = String(systemPreferences.getUserDefault('NSWindow Frame Rach3MainWindow', 'string') || '').split(' ').map(Number);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y: screen.getPrimaryDisplay().bounds.height - y - height, width, height, maximized: false };
}
function restoreWindow() {
  const saved = settings.get('Window') || earlierMacWindow();
  if (!saved || typeof saved !== 'object' || !(saved.width >= 820) || !(saved.height >= 620)) return null;
  const visible = screen.getAllDisplays().some(display => {
    const area = display.workArea;
    return saved.x < area.x + area.width && saved.x + saved.width > area.x && saved.y < area.y + area.height && saved.y + saved.height > area.y;
  });
  return visible ? saved : null;
}

// Quitting waits for the page to save where the person was, and for the piano
// connection and a running lesson to stop.
function beginQuit() {
  if (quitting) return;
  if (uninstalling) updates.stop();
  quitting = true; savingWorkspace = true;
  saveWindow();
  const saved = () => { if (savingWorkspace) { savingWorkspace = false; finishTermination(); } };
  if (alive(pageView)) inPage(`window.dispatchEvent(new Event('rach3-save-state'));`).then(saved, saved); else saved();
  setTimeout(saved, 3000);
  bluetooth.stop(); lessons.cancel(); customize.stop();
}
function finishTermination() {
  if (!quitting || leaving || savingWorkspace || bluetooth.active || lessons.running) return;
  if (uninstalling && !launchUninstaller()) { quitting = false; uninstalling = false; return; }
  leaving = true;
  updates.leaving();
  app.quit();
}
app.on('before-quit', event => { if (!leaving) { event.preventDefault(); beginQuit(); } });
app.on('window-all-closed', () => app.quit());
process.on('SIGTERM', () => app.quit());

async function uninstall() {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning', message: text('rach3 kaldırılsın mı?'),
    detail: text('Uygulama, modeller, kayıtlı dersler ve rach3’ün geçici verileri kalıcı olarak silinecek. Orijinal videolar ve dışarı aktardığın MIDI dosyaları korunacak.'),
    buttons: [text('Vazgeç'), text('rach3’ü kaldır')], defaultId: 0, cancelId: 0,
  });
  if (response === 1) { uninstalling = true; app.quit(); }
}
// The Mac's uninstaller: this program again, as plain Node, once the app has quit.
function launchUninstaller() {
  try {
    const helper = spawn(process.execPath, [path.join(__dirname, 'uninstall.js'), String(process.pid), text('Bazı rach3 dosyaları silinemedi')],
      { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    helper.unref();
    return true;
  } catch (error) { uninstalling = false; showError(error.message); return false; }
}

// ---- Development -----------------------------------------------------------------------
// Only with RACH3_DEV_DIR set by whoever launched the app: each time command.json changes
// there ({"world":"page"|"customize"|"video","js":"…","click":"selector","video":"link","snapshot":"name.png"}),
// it runs and result.json and the snapshot are written there. Without the variable nothing listens.
function startDevelopmentHook() {
  const folder = process.env.RACH3_DEV_DIR;
  if (!folder) return;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  fs.watchFile(path.join(folder, 'command.json'), { interval: 150 }, async () => {
    let command; try { command = JSON.parse(fs.readFileSync(path.join(folder, 'command.json'), 'utf8')); } catch { return; }
    // "video": a YouTube link played as a card's video would be, without sound.
    if (typeof command.video === 'string') { playVideo(command.video); video?.view.webContents.setAudioMuted(true); await wait(300); }
    const view = command.world === 'customize' ? panelView : command.world === 'video' && video ? video.view : pageView;
    const contents = view.webContents;
    let value = null, failure = null;
    try {
      if (typeof command.click === 'string') {
        // A CSS selector clicked with a real mouse event, as a person would.
        const center = await contents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(command.click)})?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
        if (!center) throw new Error('No such element');
        contents.focus();
        const [x, y] = center.map(Math.round);
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await wait(800);
      }
      // "frame": part of the address of a frame inside the view, to run the code there instead.
      const target = typeof command.frame === 'string' ? contents.mainFrame.framesInSubtree.find(frame => frame.url.includes(command.frame)) : contents;
      if (!target) throw new Error('No such frame');
      value = await target.executeJavaScript(`(async () => { ${command.js || 'return null;'} })()`);
    } catch (error) { failure = error.message; }
    if (typeof command.snapshot === 'string') {
      await wait(600);
      try {
        const image = command.window ? await captureWindow() : await contents.capturePage();
        fs.writeFileSync(path.join(folder, command.snapshot), image.toPNG());
      } catch (error) { failure = failure || error.message; }
    }
    const result = { value: value ?? null, error: failure,
      video: video ? { view: video.view.getBounds(), hidden: !video.view.getVisible(), page: pageView.getBounds() } : null,
      panel: alive(panelView) ? { open: panelOpen, bounds: panelView.getBounds() } : null, page: { url: pageURL, ready: pageReady } };
    let json; try { json = JSON.stringify(result); } catch { json = JSON.stringify({ value: String(value), error: failure }); }
    fs.writeFileSync(path.join(folder, 'result.pending'), json);
    fs.renameSync(path.join(folder, 'result.pending'), path.join(folder, 'result.json'));
  });
}
// The whole window as the person sees it: the page with the panel and the video over it.
async function captureWindow() {
  const { nativeImage } = require('electron');
  const page = await pageView.webContents.capturePage();
  if (!alive(panelView)) return page;
  const size = page.getSize(), scale = size.width / pageView.getBounds().width;
  const canvas = Buffer.from(page.toBitmap());
  const paste = async view => {
    const image = await view.webContents.capturePage(), part = image.toBitmap(), from = image.getSize(), at = view.getBounds();
    const left = Math.round((at.x - pageView.getBounds().x) * scale), top = Math.round(at.y * scale);
    for (let y = 0; y < from.height; y++) for (let x = 0; x < from.width; x++) {
      const tx = left + x, ty = top + y;
      if (tx < 0 || ty < 0 || tx >= size.width || ty >= size.height) continue;
      const s = (y * from.width + x) * 4, d = (ty * size.width + tx) * 4, alpha = part[s + 3] / 255;
      for (let c = 0; c < 3; c++) canvas[d + c] = Math.round(part[s + c] + canvas[d + c] * (1 - alpha));
      canvas[d + 3] = 255;
    }
  };
  if (!panelOpen) await paste(panelView);
  if (video && video.view.getVisible()) await paste(video.view);
  return nativeImage.createFromBitmap(canvas, { width: size.width, height: size.height });
}

// ---- Start -----------------------------------------------------------------------------
if (updateTest) selfTestUpdate(...updateTest).finally(() => app.exit(0));
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  // One window per person. A second launch brings the first forward.
  app.on('second-instance', (event, argv) => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
    const file = fileArgument(argv);
    if (file) openVideo(file);
  });
  app.on('activate', () => { if (window && !window.isDestroyed()) window.show(); });

  app.whenReady().then(async () => {
    // The earlier app's saved page state is read before the first page opens (a moment, once).
    if (earlier) await Promise.race([earlier.ready, new Promise(done => setTimeout(done, 5000))]);
    startServices();
    ipcMain.handle('rach3', answer(answerPage));
    ipcMain.handle('rach3-native', answer((event, body) => {
      if (!alive(panelView) || event.sender !== panelView.webContents || event.senderFrame !== panelView.webContents.mainFrame ||
          !body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unknown page');
      return customize.native(body);
    }));
    ipcMain.on('rach3-page-setup', (event, address) => {
      event.returnValue = alive(pageView) && event.sender === pageView.webContents ? pageScripts(address) : [];
    });

    const area = screen.getPrimaryDisplay().workAreaSize, saved = restoreWindow();
    window = new BaseWindow({
      width: Math.min(1340, area.width), height: Math.min(920, area.height), ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}),
      minWidth: 820, minHeight: 620, backgroundColor: '#131417', title: 'rach3', show: false, useContentSize: !saved,
      // One bar at the top, like other Mac apps: the page runs up under a see-through title
      // bar and the window buttons sit inside the page's own header, which is 48 points tall.
      ...(MAC && !capture ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 16 } } : {}),
    });
    if (saved?.maximized) window.maximize();
    makePage();
    makePanel();
    layout();
    window.on('resize', layout);
    window.on('enter-full-screen', () => publish({ event: 'fullscreen', active: true }));
    window.on('leave-full-screen', () => { publish({ event: 'fullscreen', active: false }); if (video?.full) { video.full = false; placeVideo(video.place); } });
    window.on('close', event => { if (!leaving) { event.preventDefault(); app.quit(); } });
    makeMenus();
    if (!capture) updates.start();
    // The page loads once core.js says which design is on screen; without the panel,
    // or if it never answers, the original rach3 loads.
    setTimeout(() => { if (!pageURL) loadPage(customize.pageURL, null); }, 6000);
    if (!alive(panelView)) loadPage(customize.pageURL, null);
    // Under the development hook the window opens behind whatever the person is doing.
    if (process.env.RACH3_DEV_DIR) window.showInactive(); else window.show();
    startDevelopmentHook();
    const file = pendingVideo || fileArgument(process.argv);
    pendingVideo = null;
    if (file) openVideo(file);

    // Development: RACH3_SHOT=<file.png> saves what the window shows and quits.
    if (process.env.RACH3_SHOT) setTimeout(async () => {
      fs.writeFileSync(process.env.RACH3_SHOT, (await captureWindow()).toPNG());
      leaving = true; app.exit(0);
    }, Number(process.env.RACH3_SHOT_AFTER || 8000));
  });
}
