'use strict';
// One lesson job at a time: a port of desktop/LessonService.m for Mac and Windows.
// The page uploads the input in chunks (or a file on disk is copied in), then the bundled
// Python worker (Engine/worker.py) makes the lesson and reports progress as JSON lines.
//
//   const lessons = createLessons({ engine, support, tools, onEvent, onIdle, text });
//
// Synchronous, as on the Mac:
//   running, snapshot(), tools(), lessons(), lesson(id), begin(request), append(base64, id),
//   start(id), missingToolBytes(kind), importYouTube(link, title), cancel()
// Asynchronous (they return a Promise):
//   deleteLesson(id)                    moving to the Trash / Recycle Bin is asynchronous in Electron
//   importFile(filePath, kind, title)   the input is copied without blocking the window
//   openVideo(filePath)                 calls importFile
// Where the Mac sets an NSError these throw (or reject with) an Error whose message is
// already translated by `text`.
//
// Optional settings beyond the six above:
//   trash(filePath) -> Promise   how a deleted lesson is put in the Trash. Inside Electron this
//                                defaults to shell.trashItem; plain Node has no Trash, so pass one.
//   logs                         a folder; the worker's diagnostics (stderr) go to <logs>/lesson.log,
//                                as in the Windows shell. Without it they are dropped, as on the Mac.
//
// Files under `support` (unchanged from the Mac):
//   LastJob.json                 the last published state
//   Jobs/<ID>/owner.pid, request.json, input.<kind>, tmp/     one running job, removed when it ends
//   Lessons/<ID>.json, Lessons/<ID>.assets/                   the library the worker writes
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localizeStatus } = require('./localization');

const WINDOWS = process.platform === 'win32';
const INTEL_MAC = !WINDOWS && process.arch === 'x64';

// Each platform has its own tool catalog; Intel Macs are pinned to the last PyTorch
// with Intel wheels (the same choice lesson-engine/tools_manager.py makes).
const CATALOG = WINDOWS ? 'tools-win_amd64.json' : INTEL_MAC ? 'tools-x86_64.json' : 'tools.json';

// tools_manager.artifact_path(): Windows keeps artifact folders short to stay under MAX_PATH.
const artifactFolder = (tools, hash) => WINDOWS ? path.join(tools, 'a', hash.slice(0, 24)) : path.join(tools, 'artifacts', hash);

// ---- Where the engine is -------------------------------------------------------------
// `code` holds worker.py and the catalogs; `home` is the portable Python.
// Packaged (desktop/build.py bundle_engine, windows/engine.py stage_engine):
//   Mac      Engine/python (Apple silicon) or Engine/python-x86_64 (Intel), bin/python3.12 inside
//   Windows  Engine/python/python.exe
const packagedEngine = engine => ({ code: engine, home: path.join(engine, INTEL_MAC ? 'python-x86_64' : 'python') });
const pythonOf = layout => WINDOWS ? path.join(layout.home, 'python.exe') : path.join(layout.home, 'bin', 'python3.12');
const complete = layout => fs.existsSync(path.join(layout.code, 'worker.py')) && fs.existsSync(pythonOf(layout));

// ---- Development only ----------------------------------------------------------------
// Run from the repository when `engine` is not a built Engine folder: the sources in
// lesson-engine/ and the pinned runtime the build scripts keep in build/lesson-python/.
// A packaged app has neither folder, so this never applies there.
function developmentEngine() {
  const root = path.resolve(__dirname, '..');
  const runtime = WINDOWS ? 'cpython-3.12.12-windows-x86_64-none'
    : `cpython-3.12.12-macos-${INTEL_MAC ? 'x86_64' : 'aarch64'}-none`;
  return { code: path.join(root, 'lesson-engine'), home: path.join(root, 'build', 'lesson-python', runtime) };
}
function locateEngine(engine) {
  const packaged = packagedEngine(engine);
  if (complete(packaged)) return packaged;
  const development = developmentEngine();
  return complete(development) ? development : packaged;
}
// ---------------------------------------------------------------------------------------

function workerEnvironment(layout, temp) {
  const environment = { ...process.env };
  const set = (name, value) => {
    // Windows ignores the case of names ("Path"); keep one spelling so ours is the one used.
    if (WINDOWS) for (const key of Object.keys(environment)) if (key.toUpperCase() === name) delete environment[key];
    environment[name] = value;
  };
  set('PYTHONHOME', layout.home);
  set('PYTHONPATH', layout.code);
  set('PYTHONNOUSERSITE', '1');
  set('PYTHONDONTWRITEBYTECODE', '1');
  if (WINDOWS) {
    const system = process.env.SystemRoot || 'C:\\Windows';
    // JSON events and lesson files are UTF-8, not the ANSI code page.
    set('PYTHONUTF8', '1');
    set('PYTHONIOENCODING', 'utf-8');
    set('PATH', path.join(system, 'System32') + ';' + system);
    set('TEMP', temp);
    set('TMP', temp);
  } else {
    set('PATH', '/usr/bin:/bin');
    set('TMPDIR', temp);
  }
  return environment;
}

// Ends the worker and everything it started (ffmpeg, the PDF reader).
function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (WINDOWS) {
    // The whole process tree, at once.
    const system = process.env.SystemRoot || 'C:\\Windows';
    const killer = spawn(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill());
    killer.on('exit', code => { if (code && child.exitCode === null) child.kill(); });
    return;
  }
  // The worker leads its own process group (os.setsid in worker.py). Until it has done
  // that there is no such group and only the worker itself is asked to stop.
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeAtomic(file, text) {
  const pending = `${file}.${process.pid}.pending`;
  fs.writeFileSync(pending, text);
  fs.renameSync(pending, file);
}

function remove(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 }); } catch { /* cleared at the next launch */ }
}

// Calls onLine with each complete line (a Buffer) of a stream delivered in chunks.
function lineReader(onLine) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      onLine(line);
    }
    if (buffer.length > 1024 * 1024) buffer = Buffer.alloc(0);
  };
}

// The Trash on the Mac, the Recycle Bin on Windows.
async function defaultTrash(file) {
  const electron = process.versions.electron ? require('electron') : null;
  if (!electron || !electron.shell) throw new Error('Plain Node has no Trash: pass `trash` to createLessons.');
  await electron.shell.trashItem(file);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CHUNK = 2 * 1024 * 1024;
const LARGEST = 4 * 1024 * 1024 * 1024;
const ENDED = ['complete', 'error'];
const progress = (phase, message, extra) => ({ event: 'lesson-progress', phase, message, progress: 0, ...extra });

function createLessons({ engine, support, tools, onEvent, onIdle, text, trash, logs }) {
  const translate = text || (source => source);
  const fail = message => new Error(translate(message));
  const library = path.join(support, 'Lessons');
  const layout = locateEngine(engine);
  const putInTrash = trash || defaultTrash;

  let state = progress('idle', '');
  let identifier = null, job = null, upload = null, task = null;
  let cancelling = false, expectedSize = 0, uploadedSize = 0;

  // Jobs left behind by an app that is no longer running.
  const jobs = path.join(support, 'Jobs');
  let leftovers = [];
  try { leftovers = fs.readdirSync(jobs); } catch { /* no jobs yet */ }
  for (const name of leftovers) {
    const old = path.join(jobs, name);
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(path.join(old, 'owner.pid'), 'utf8'), 10) || 0; } catch { /* no owner */ }
    if (pid <= 1 || !alive(pid)) remove(old);
  }

  const snapshot = () => localizeStatus(state, translate);

  function publish(next) {
    state = next;
    try {
      fs.mkdirSync(support, { recursive: true });
      writeAtomic(path.join(support, 'LastJob.json'), JSON.stringify(next));
    } catch { /* the page still gets the event */ }
    if (onEvent) onEvent(snapshot());
  }

  function closeUpload() {
    if (upload === null) return;
    try { fs.closeSync(upload); } catch { /* already closed */ }
    upload = null;
  }

  function toolCatalog() {
    const catalog = JSON.parse(fs.readFileSync(path.join(layout.code, CATALOG), 'utf8'));
    const artifacts = {};
    for (const [key, entry] of Object.entries(catalog.artifacts)) {
      const artifact = { ...entry };
      const hash = artifact.sha256;
      let installed = null;
      try { installed = fs.readFileSync(path.join(artifactFolder(tools, hash), '.ready'), 'utf8'); } catch { /* not installed */ }
      artifact.ready = installed === hash;
      let partial = 0;
      try { partial = fs.statSync(path.join(tools, 'downloads', `${hash}.part`)).size; } catch { /* nothing downloaded */ }
      artifact.received = Math.min(partial, Number(artifact.size) || 0);
      artifacts[key] = artifact;
    }
    return { groups: catalog.groups, artifacts };
  }

  function list() {
    const found = [];
    let names = [];
    try { names = fs.readdirSync(library); } catch { /* no lessons yet */ }
    for (const name of names) {
      if (path.extname(name) !== '.json') continue;
      let lesson = null;
      try { lesson = JSON.parse(fs.readFileSync(path.join(library, name), 'utf8')); } catch { /* not a lesson */ }
      if (lesson && typeof lesson === 'object' && !Array.isArray(lesson) && lesson.id != null && lesson.title != null)
        found.push({ id: lesson.id, title: lesson.title, noteCount: lesson.noteCount ?? 0 });
    }
    return found.sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'accent' }));
  }

  function lessonFile(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw fail('Geçersiz ders kimliği');
    return path.join(library, `${id}.json`);
  }

  const load = id => JSON.parse(fs.readFileSync(lessonFile(id), 'utf8'));

  async function deleteLesson(id) {
    const lesson = lessonFile(id);
    // Deleted lessons go to the Trash, so a mistaken delete can be undone.
    await putInTrash(lesson);
    const assets = path.join(library, `${id}.assets`);
    if (fs.existsSync(assets)) await putInTrash(assets);
    if (state.id === id) publish(progress('idle', ''));
    return true;
  }

  function begin(request) {
    if (identifier !== null) throw fail('Önce mevcut işlemi tamamla veya iptal et.');
    request = request && typeof request === 'object' ? request : {};
    const name = typeof request.name === 'string' ? request.name : 'video.mp4';
    const extension = path.extname(name);
    const title = typeof request.title === 'string' ? request.title : extension ? name.slice(0, -extension.length) : name;
    const url = typeof request.url === 'string' ? request.url : '';
    if (url.length) {
      // Exactly https://www.youtube.com/watch…, with no sign-in part and no port. The link
      // is handed to the downloader as written, so its spelling is checked, not only its parts.
      let parts = null;
      try { parts = new URL(url); } catch { /* not a link */ }
      if (!parts || !/^https:\/\/www\.youtube\.com\/watch(?:[?#]|$)/.test(url) || parts.protocol !== 'https:' ||
          parts.hostname !== 'www.youtube.com' || parts.pathname !== '/watch' || parts.username || parts.password || parts.port)
        throw fail('Geçerli bir YouTube bağlantısı seç.');
    }
    const size = typeof request.size === 'number' && Number.isFinite(request.size) ? Math.trunc(request.size) : 0;
    if (size > LARGEST || size < 0) throw fail('En fazla 4 GB video seçebilirsin.');
    identifier = crypto.randomUUID().toUpperCase();
    job = path.join(support, 'Jobs', identifier);
    cancelling = false; expectedSize = size; uploadedSize = 0;
    try { fs.mkdirSync(job, { recursive: true }); } catch (error) { identifier = null; job = null; throw error; }
    try { fs.writeFileSync(path.join(job, 'owner.pid'), String(process.pid)); } catch { /* the job still runs */ }
    const kind = request.kind === 'pdf' ? 'pdf' : request.kind === 'midi' ? 'midi' : 'video';
    const input = `input.${kind}`;
    const description = { id: identifier, title, input, kind, sourceName: name, tempo: request.tempo ?? 60, url, separate: request.separate ?? true };
    try {
      writeAtomic(path.join(job, 'request.json'), JSON.stringify(description));
      if (!url.length) upload = fs.openSync(path.join(job, input), 'w');
    } catch (error) { cancel(); throw error; }
    publish(progress('upload', 'Dosya hazırlanıyor…', { title }));
    return { id: identifier };
  }

  function append(encoded, id) {
    if (id !== identifier || identifier === null || upload === null) throw fail('Video aktarımı kapalı.');
    // Strict base64, as NSData reads it: no stray characters, correct padding.
    const valid = typeof encoded === 'string' && encoded.length <= Math.ceil(CHUNK / 3) * 4 && BASE64.test(encoded);
    const data = valid ? Buffer.from(encoded, 'base64') : null;
    if (!data || data.length > CHUNK || uploadedSize + data.length > expectedSize) throw fail('Video aktarım boyutu geçersiz.');
    fs.writeSync(upload, data);
    uploadedSize += data.length;
    return true;
  }

  function start(id) {
    if (id !== identifier || identifier === null || task) throw fail('Ders işlemi bulunamadı.');
    if (upload !== null && uploadedSize !== expectedSize) throw fail('Video aktarımı tamamlanmadı.');
    closeUpload();
    const temp = path.join(job, 'tmp');
    let child = null;
    if (fs.existsSync(pythonOf(layout))) {
      try {
        fs.mkdirSync(temp, { recursive: true });
        child = spawn(pythonOf(layout), ['-u', path.join(layout.code, 'worker.py'), '--job', job, '--tools', tools,
          '--library', library, '--parent', String(process.pid)],
        { cwd: job, env: workerEnvironment(layout, temp), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch { child = null; }
    }
    if (child) child.on('error', () => {});   // a worker that could not start is handled just below
    if (!child || !child.pid) {
      cancel();
      throw fail('Ders motoru bu bilgisayarda bulunamadı. rach3’ü yeniden yükle.');
    }
    if (WINDOWS) {
      // Lessons never slow down playback. What the worker starts inherits this priority.
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* it runs at normal priority */ }
    }
    let log = null;
    if (logs) {
      try {
        fs.mkdirSync(logs, { recursive: true });
        log = fs.createWriteStream(path.join(logs, 'lesson.log'));
        log.on('error', () => {});
      } catch { log = null; }
    }
    if (log) child.stderr.pipe(log); else child.stderr.resume();

    task = child;
    publish(progress('starting', 'Ders motoru başlatılıyor…'));
    child.stdout.on('data', lineReader(line => {
      let event = null;
      try { event = JSON.parse(line.toString('utf8')); } catch { /* not an event */ }
      if (!event || typeof event !== 'object' || Array.isArray(event) || event.event !== 'lesson-progress') return;
      if (task !== child || cancelling) return;
      // The end is announced once the worker has really gone.
      if (ENDED.includes(event.phase)) state = event; else publish(event);
    }));
    // 'close' comes after the worker has exited and its output has been read to the end.
    child.on('close', () => finished(child));
    return true;
  }

  function finished(child) {
    if (task !== child) return;
    const finishedID = identifier;
    task = null; identifier = null;
    remove(job); job = null;
    if (cancelling) {
      remove(path.join(library, `${finishedID}.json`));
      publish(progress('cancelled', 'İşlem iptal edildi'));
    } else if (ENDED.includes(state.phase)) publish(state);
    else publish(progress('error', 'Ders oluşturulamadı. İşlem beklenmedik şekilde kapandı.'));
    if (onIdle) onIdle();
  }

  function missingToolBytes(kind) {
    const catalog = toolCatalog();
    const groups = ['notation'];
    if (kind === 'pdf') groups.push('pdf');
    // Videos are made with the voice separated from the piano, as in Create a Lesson.
    if (kind === 'video' || kind === 'youtube') groups.push('transcription', 'separation');
    if (kind === 'youtube') groups.push('youtube');
    const keys = new Set();
    for (const group of groups) for (const key of catalog.groups[group] || []) keys.add(key);
    let missing = 0;
    for (const key of keys) {
      const artifact = catalog.artifacts[key];
      if (artifact && !artifact.ready) missing += Math.max(0, (Number(artifact.size) || 0) - artifact.received);
    }
    return missing;
  }

  function importYouTube(link, title) {
    const request = { name: 'YouTube', url: link || '', separate: true };
    if (title) request.title = title;
    const started = begin(request);
    start(started.id);
    return started.id;
  }

  async function importFile(filePath, kind, title) {
    const size = fs.statSync(filePath).size;
    const request = { name: path.basename(filePath), size, separate: true, kind };
    if (title) request.title = title;
    const started = begin(request);
    closeUpload();
    const folder = job;
    const input = path.join(folder, `input.${kind === 'pdf' || kind === 'midi' ? kind : 'video'}`);
    try {
      fs.rmSync(input, { force: true });
      // Copy-on-write where the disk offers it (APFS), an ordinary copy elsewhere.
      await fs.promises.copyFile(filePath, input, fs.constants.COPYFILE_FICLONE);
    } catch (error) {
      if (identifier === started.id) cancel(); else remove(folder);
      throw error;
    }
    // Cancelled while the file was being copied: the copy may have outlived its folder.
    if (identifier !== started.id) remove(folder);
    else uploadedSize = size;
    start(started.id);
    return started.id;
  }

  function cancel() {
    cancelling = true;
    if (task) {
      stopWorker(task);
      publish(progress('cancelling', 'İşlem durduruluyor…'));
    } else if (identifier !== null) {
      closeUpload();
      remove(job);
      identifier = null; job = null;
      publish(progress('cancelled', 'İşlem iptal edildi'));
      if (onIdle) onIdle();
    }
  }

  return {
    get running() { return identifier !== null; },
    snapshot,
    tools: toolCatalog,
    lessons: list,
    lesson: load,
    deleteLesson,
    begin,
    append,
    start,
    openVideo: async filePath => { await importFile(filePath, 'video', null); return true; },
    missingToolBytes,
    importFile,
    importYouTube,
    cancel,
  };
}

module.exports = { createLessons };
