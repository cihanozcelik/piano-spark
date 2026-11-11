'use strict';
// Plain Node check of electron/lessons.js and electron/localization.js:
//   node electron/tests/lessons.test.js
// Everything is written under a temporary folder. The installed lesson tools of this
// machine, if any, are only read (linked into the temporary tools folder), and a real
// import runs only when nothing would have to be downloaded.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLessons } = require('../lessons');
const { createLocalization, nativeStrings } = require('../localization');
const { fileSettings } = require('../settings');

const ROOT = path.resolve(__dirname, '..', '..');
const WINDOWS = process.platform === 'win32';
const INTEL_MAC = !WINDOWS && process.arch === 'x64';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rach3-lessons-'));
const runtime = path.join(ROOT, 'build', 'lesson-python', WINDOWS ? 'cpython-3.12.12-windows-x86_64-none'
  : `cpython-3.12.12-macos-${INTEL_MAC ? 'x86_64' : 'aarch64'}-none`);
const python = WINDOWS ? path.join(runtime, 'python.exe') : path.join(runtime, 'bin', 'python3.12');
const catalogName = WINDOWS ? 'tools-win_amd64.json' : INTEL_MAC ? 'tools-x86_64.json' : 'tools.json';

let passed = 0, skipped = 0;
const ok = name => { passed += 1; console.log(`ok - ${name}`); };
const skip = (name, why) => { skipped += 1; console.log(`skipped - ${name}: ${why}`); };
const throws = (action, message) => assert.throws(action, error => { assert.strictEqual(error.message, message); return true; });
const rejects = (promise, message) => assert.rejects(promise, error => { assert.strictEqual(error.message, message); return true; });
const sleep = time => new Promise(resolve => setTimeout(resolve, time));
async function until(condition, what, limit = 60000) {
  const end = Date.now() + limit;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// A service on its own support folder, recording what it reports.
function service(name, engine, tools, { create = createLessons, ...extra } = {}) {
  const support = path.join(work, name);
  const localization = createLocalization({ settings: fileSettings(path.join(support, 'settings.json')), systemLocale: 'en-US' });
  const events = [], trashed = [];
  let idle = 0;
  const lessons = create({
    engine, support, tools: tools || path.join(support, 'Tools', '1'), text: localization.text,
    onEvent: event => events.push(event), onIdle: () => { idle += 1; },
    trash: async file => { if (!fs.existsSync(file)) throw new Error(`Nothing to trash: ${path.basename(file)}`); trashed.push(path.basename(file)); fs.rmSync(file, { recursive: true }); },
    logs: path.join(support, 'Logs'), ...extra,
  });
  return { lessons, support, localization, events, trashed, idle: () => idle, phases: () => events.map(event => event.phase) };
}

function localization() {
  const pairs = nativeStrings();
  assert(Object.keys(pairs).length >= 80);
  assert.strictEqual(pairs['Geçersiz ders kimliği'], 'Invalid lesson ID');
  console.log(`   ${Object.keys(pairs).length} strings read from desktop/Localization.m`);
  const file = path.join(work, 'language', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ other: 7 }));
  const english = createLocalization({ settings: fileSettings(file), systemLocale: 'en-US' });
  assert.strictEqual(english.language(), 'en');
  assert.strictEqual(createLocalization({ settings: fileSettings(file), systemLocale: () => 'tr-TR' }).language(), 'tr');
  assert.strictEqual(english.text('Ders hazır'), 'Your lesson is ready');
  assert.strictEqual(english.text('Nota bölümleri hazırlanıyor: 3/8'), 'Preparing note sections: 3/8');
  assert.strictEqual(english.text('Für Elise'), 'Für Elise');
  assert.strictEqual(english.text(null), null);
  assert.strictEqual(english.text('Ders motoru bu bilgisayarda bulunamadı. rach3’ü yeniden yükle.'), 'The lesson engine is missing. Reinstall rach3.');
  assert.deepStrictEqual(
    english.localizedStatus({ message: 'Ders hazır', title: 'Ders hazır', progress: 1, diagnostic: { detail: 'İşlem iptal edildi', error: 5 } }),
    { message: 'Your lesson is ready', title: 'Ders hazır', progress: 1, diagnostic: { detail: 'Cancelled', error: 5 } });
  english.setLanguage('tr');
  assert.deepStrictEqual(json(file), { other: 7, Rach3Language: 'tr' });
  const turkish = createLocalization({ settings: fileSettings(file), systemLocale: 'en-US' });
  assert.strictEqual(turkish.language(), 'tr');
  assert.strictEqual(turkish.text('Your lesson is ready'), 'Ders hazır');
  assert.strictEqual(turkish.text('Ders hazır'), 'Ders hazır');
  assert.strictEqual(turkish.text('Preparing note sections: 3/8'), 'Nota bölümleri hazırlanıyor: 3/8');
  ok('localization: language, saved file, both directions, status');
}

async function withoutWorker() {
  const support = path.join(work, 'plain');
  // Leftovers of earlier runs: one whose owner is gone, one whose owner (this process) is alive.
  const gone = path.join(support, 'Jobs', 'GONE'), mine = path.join(support, 'Jobs', 'MINE');
  for (const folder of [gone, mine]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(gone, 'owner.pid'), '999999999');
  fs.writeFileSync(path.join(mine, 'owner.pid'), String(process.pid));
  fs.writeFileSync(path.join(support, 'Jobs', '.DS_Store'), '');
  const tools = path.join(support, 'Tools', '1');
  const { lessons, events, trashed, idle, localization } = service('plain', path.join(work, 'no-engine-here'), tools);
  assert.deepStrictEqual(fs.readdirSync(path.join(support, 'Jobs')), ['MINE']);
  fs.rmSync(mine, { recursive: true });
  ok('start-up removes jobs whose owner is gone and keeps a live owner’s');

  assert.strictEqual(lessons.running, false);
  assert.deepStrictEqual(lessons.snapshot(), { event: 'lesson-progress', phase: 'idle', message: '', progress: 0 });
  ok('snapshot is idle');

  if (fs.existsSync(path.join(ROOT, 'lesson-engine', catalogName)) && fs.existsSync(python)) {
    const catalog = json(path.join(ROOT, 'lesson-engine', catalogName));
    const [first, second] = catalog.groups.notation;
    const one = catalog.artifacts[first], two = catalog.artifacts[second];
    const folder = WINDOWS ? path.join(tools, 'a', one.sha256.slice(0, 24)) : path.join(tools, 'artifacts', one.sha256);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.ready'), one.sha256);
    fs.mkdirSync(path.join(tools, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(tools, 'downloads', `${two.sha256}.part`), Buffer.alloc(1000));
    const report = lessons.tools();
    assert.deepStrictEqual(Object.keys(report), ['groups', 'artifacts']);
    assert.deepStrictEqual(report.groups, catalog.groups);
    assert.deepStrictEqual(report.artifacts[first], { ...one, ready: true, received: 0 });
    assert.deepStrictEqual(report.artifacts[second], { ...two, ready: false, received: 1000 });
    const all = keys => keys.reduce((sum, key) => sum + catalog.artifacts[key].size, 0);
    const notation = all(catalog.groups.notation) - one.size - 1000;
    assert.strictEqual(lessons.missingToolBytes('midi'), notation);
    const video = new Set([...catalog.groups.notation, ...catalog.groups.transcription, ...catalog.groups.separation]);
    assert.strictEqual(lessons.missingToolBytes('video'), all([...video]) - one.size - 1000);
    assert(lessons.missingToolBytes('youtube') > lessons.missingToolBytes('video'));
    assert(lessons.missingToolBytes('pdf') > notation);
    console.log(`   ${catalogName}: ${Object.keys(report.artifacts).length} artifacts, ${lessons.missingToolBytes('midi')} bytes missing for midi here`);
    ok('tools and missingToolBytes (development engine from the repository)');
  } else skip('tools', 'no lesson-engine catalog or runtime in this repository');

  assert.deepStrictEqual(lessons.lessons(), []);
  const library = path.join(support, 'Lessons');
  fs.mkdirSync(library, { recursive: true });
  const a = '0A0A0A0A-1111-2222-3333-444444444444', b = '0b0b0b0b-1111-2222-3333-444444444444', c = '0C0C0C0C-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(library, `${a}.json`), JSON.stringify({ id: a, title: 'çiçek', noteCount: 12, notes: [1, 2] }));
  fs.writeFileSync(path.join(library, `${b}.json`), JSON.stringify({ id: b, title: 'Bach' }));
  fs.writeFileSync(path.join(library, `${c}.json`), JSON.stringify({ id: c, title: 'adagio', noteCount: 3 }));
  fs.writeFileSync(path.join(library, 'broken.json'), '{');
  fs.writeFileSync(path.join(library, 'untitled.json'), JSON.stringify({ id: 'x' }));
  fs.writeFileSync(path.join(library, `${a}.pending`), JSON.stringify({ id: a, title: 'pending' }));
  fs.mkdirSync(path.join(library, `${a}.assets`));
  assert.deepStrictEqual(lessons.lessons(), [{ id: c, title: 'adagio', noteCount: 3 }, { id: b, title: 'Bach', noteCount: 0 }, { id: a, title: 'çiçek', noteCount: 12 }]);
  assert.deepStrictEqual(lessons.lesson(a), { id: a, title: 'çiçek', noteCount: 12, notes: [1, 2] });
  throws(() => lessons.lesson('../../etc/passwd'), 'Invalid lesson ID');
  throws(() => lessons.lesson(undefined), 'Invalid lesson ID');
  assert.throws(() => lessons.lesson('0D0D0D0D-1111-2222-3333-444444444444'), /ENOENT/);
  ok('lessons list (sorted, only real lessons) and lesson load');

  await rejects(lessons.deleteLesson('nope'), 'Invalid lesson ID');
  assert.strictEqual(await lessons.deleteLesson(a), true);
  assert.deepStrictEqual(trashed, [`${a}.json`, `${a}.assets`]);
  assert.strictEqual(await lessons.deleteLesson(b), true);
  await assert.rejects(lessons.deleteLesson(b), /Nothing to trash/);
  assert.deepStrictEqual(lessons.lessons().map(lesson => lesson.id), [c]);
  ok('deleteLesson puts the lesson and its assets in the trash');

  throws(() => lessons.begin({ url: 'https://evil.example/watch?v=1' }), 'Choose a valid YouTube link.');
  for (const url of ['http://www.youtube.com/watch?v=1', 'https://youtube.com/watch?v=1', 'https://www.youtube.com/watch/x', 'https://user@www.youtube.com/watch?v=1',
    'https://www.youtube.com:444/watch?v=1', 'https://www.youtube.com:443/watch?v=1', 'HTTPS://www.youtube.com/watch?v=1', ' https://www.youtube.com/watch?v=1', 'not a link'])
    throws(() => lessons.begin({ url }), 'Choose a valid YouTube link.');
  throws(() => lessons.begin({ size: 4 * 1024 * 1024 * 1024 + 1 }), 'Choose a video no larger than 4 GB.');
  assert.strictEqual(lessons.running, false);
  assert.strictEqual(events.length, 0);
  ok('begin refuses other links and files over 4 GB');

  const bytes = Buffer.from('rach3 lesson upload, twelve bytes and more');
  const started = lessons.begin({ name: 'My Song.final.mp4', size: bytes.length, tempo: 72 });
  assert.match(started.id, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.strictEqual(lessons.running, true);
  const job = path.join(support, 'Jobs', started.id);
  assert.deepStrictEqual(fs.readdirSync(job).sort(), ['input.video', 'owner.pid', 'request.json']);
  assert.strictEqual(fs.readFileSync(path.join(job, 'owner.pid'), 'utf8'), String(process.pid));
  assert.deepStrictEqual(json(path.join(job, 'request.json')),
    { id: started.id, title: 'My Song.final', input: 'input.video', kind: 'video', sourceName: 'My Song.final.mp4', tempo: 72, url: '', separate: true });
  const upload = { event: 'lesson-progress', phase: 'upload', message: 'Preparing your file…', progress: 0, title: 'My Song.final' };
  assert.deepStrictEqual(events, [upload]);
  assert.deepStrictEqual(lessons.snapshot(), upload);
  assert.deepStrictEqual(json(path.join(support, 'LastJob.json')), { ...upload, message: 'Dosya hazırlanıyor…' });
  ok('begin: job id, Jobs/<id> files, request.json, upload event, LastJob.json');

  throws(() => lessons.begin({ name: 'again.mp4', size: 1 }), 'Finish or cancel the current task first.');
  throws(() => lessons.append(bytes.toString('base64'), 'someone-else'), 'The video transfer is closed.');
  throws(() => lessons.append('not base64!', started.id), 'The video transfer size is invalid.');
  throws(() => lessons.append('QUJD\n', started.id), 'The video transfer size is invalid.');
  throws(() => lessons.append(Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'), started.id), 'The video transfer size is invalid.');
  assert.strictEqual(lessons.append(bytes.subarray(0, 10).toString('base64'), started.id), true);
  throws(() => lessons.start(started.id), 'The video transfer is incomplete.');
  throws(() => lessons.start('someone-else'), 'The lesson task could not be found.');
  throws(() => lessons.append(bytes.toString('base64'), started.id), 'The video transfer size is invalid.');
  assert.strictEqual(lessons.append(bytes.subarray(10).toString('base64'), started.id), true);
  assert.deepStrictEqual(fs.readFileSync(path.join(job, 'input.video')), bytes);
  ok('append: strict base64, size limits, bytes land in input.video');

  localization.setLanguage('tr');
  assert.strictEqual(lessons.snapshot().message, 'Dosya hazırlanıyor…');
  throws(() => lessons.begin({}), 'Önce mevcut işlemi tamamla veya iptal et.');
  localization.setLanguage('en');
  ok('messages follow the language');

  lessons.cancel();
  assert.strictEqual(lessons.running, false);
  assert.strictEqual(fs.existsSync(job), false);
  assert.deepStrictEqual(events[events.length - 1], { event: 'lesson-progress', phase: 'cancelled', message: 'Cancelled', progress: 0 });
  assert.strictEqual(idle(), 1);
  lessons.cancel();
  assert.strictEqual(idle(), 1);
  throws(() => lessons.append('QUJD', started.id), 'The video transfer is closed.');
  ok('cancel before start: job folder removed, cancelled event, onIdle once');

  const pdf = lessons.begin({ name: 'score.pdf', kind: 'pdf', size: 0, title: 'Given', separate: false });
  assert.deepStrictEqual(json(path.join(support, 'Jobs', pdf.id, 'request.json')),
    { id: pdf.id, title: 'Given', input: 'input.pdf', kind: 'pdf', sourceName: 'score.pdf', tempo: 60, url: '', separate: false });
  lessons.cancel();
  const link = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const video = lessons.begin({ name: 'YouTube', url: link });
  assert.deepStrictEqual(fs.readdirSync(path.join(support, 'Jobs', video.id)).sort(), ['owner.pid', 'request.json']);
  assert.strictEqual(json(path.join(support, 'Jobs', video.id, 'request.json')).url, link);
  throws(() => lessons.append('QUJD', video.id), 'The video transfer is closed.');
  lessons.cancel();
  assert.deepStrictEqual(fs.readdirSync(path.join(support, 'Jobs')), []);
  ok('begin: kinds, given title, a YouTube link opens no upload');
}

// A worker that follows worker.py's contract without doing the work: an Engine folder in
// the packaged layout, with the repository's portable Python and a short stand-in worker.py.
const STAND_IN = String.raw`
import json, os, signal, subprocess, sys, time
from pathlib import Path
EVENTS = sys.stdout
sys.stdout = sys.stderr
def emit(phase, message, progress, **extra):
    print(json.dumps(dict(event='lesson-progress', phase=phase, message=message, progress=progress, **extra), ensure_ascii=False), file=EVENTS, flush=True)
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
job, library = Path(args['--job']), Path(args['--library'])
if os.name != 'nt' and os.getpgrp() != os.getpid(): os.setsid()
request = json.loads((job/'request.json').read_text(encoding='utf-8'))
mode = request['title']
print('diagnostics go to the log', file=sys.stderr, flush=True)
emit('starting', 'Ders motoru başlatılıyor…', 0, probe=dict(
    cwd=os.getcwd(), parent=int(args['--parent']), tools=args['--tools'], home=os.environ.get('PYTHONHOME'),
    code=os.environ.get('PYTHONPATH'), path=os.environ.get('PATH'), temp=os.environ.get('TEMP' if os.name == 'nt' else 'TMPDIR'),
    input=(job/request['input']).read_bytes().decode() if not request['url'] else None))
print('not json', file=EVENTS, flush=True)
print(json.dumps(dict(event='something-else', phase='complete')), file=EVENTS, flush=True)
print(json.dumps([1, 2]), file=EVENTS, flush=True)
if mode == 'crash': os._exit(3)
if mode == 'error':
    emit('error', 'Dosyada çalınabilir piyano notası bulunamadı.', 0, detail='Traceback: x')
    sys.exit(1)
library.mkdir(parents=True, exist_ok=True)
lesson = library/(request['id']+'.json')
if mode == 'hang':
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])
    lesson.write_text('{}')
    emit('transcribing', 'Piyano notaları çıkarılıyor…', .3, child=child.pid)
    time.sleep(600)
emit('saving', 'Ders kaydediliyor…', .98)
lesson.write_text(json.dumps(dict(id=request['id'], title=mode, noteCount=2)))
EVENTS.write('{"event":"lesson-progress","phase":"complete","message":"Ders hazır","progress":1,"id":"' + request['id'] + '","noteCount":2,')
EVENTS.flush(); time.sleep(.2)
EVENTS.write('"title":"' + mode + '"}\n'); EVENTS.flush()
time.sleep(.3)
`;

async function standInWorker() {
  if (!fs.existsSync(python)) return skip('worker lifecycle', `no portable Python at ${runtime}`);
  const engine = path.join(work, 'Engine');
  fs.mkdirSync(engine);
  fs.symlinkSync(runtime, path.join(engine, INTEL_MAC ? 'python-x86_64' : 'python'), 'junction');
  fs.writeFileSync(path.join(engine, 'worker.py'), STAND_IN);
  const { lessons, support, events, idle, phases } = service('stand-in', engine);
  const source = path.join(work, 'source.bin');
  fs.writeFileSync(source, 'the input file');
  const real = folder => fs.realpathSync(folder);

  // A job that completes.
  const id = await lessons.importFile(source, 'midi', 'complete');
  assert.strictEqual(lessons.running, true);
  assert.deepStrictEqual(phases(), ['upload', 'starting']);
  const job = path.join(support, 'Jobs', id);
  assert.deepStrictEqual(json(path.join(job, 'request.json')),
    { id, title: 'complete', input: 'input.midi', kind: 'midi', sourceName: 'source.bin', tempo: 60, url: '', separate: true });
  throws(() => lessons.start(id), 'The lesson task could not be found.');
  await until(() => idle() === 1, 'the worker to finish');
  assert.deepStrictEqual(phases(), ['upload', 'starting', 'starting', 'saving', 'complete']);
  const probe = events[2].probe;
  assert.strictEqual(probe.cwd, real(path.join(support, 'Jobs')) + path.sep + id);
  assert.strictEqual(probe.parent, process.pid);
  assert.strictEqual(probe.tools, path.join(support, 'Tools', '1'));
  assert.strictEqual(probe.home, path.join(engine, INTEL_MAC ? 'python-x86_64' : 'python'));
  assert.strictEqual(probe.code, engine);
  assert.strictEqual(probe.temp, path.join(job, 'tmp'));
  assert.strictEqual(probe.input, 'the input file');
  if (!WINDOWS) assert.strictEqual(probe.path, '/usr/bin:/bin');
  assert.strictEqual(events[3].message, 'Saving your lesson…');
  assert.deepStrictEqual(events[4], { event: 'lesson-progress', phase: 'complete', message: 'Your lesson is ready', progress: 1, id, noteCount: 2, title: 'complete' });
  assert.deepStrictEqual(lessons.snapshot(), events[4]);
  assert.strictEqual(json(path.join(support, 'LastJob.json')).message, 'Ders hazır');
  assert.strictEqual(lessons.running, false);
  assert.deepStrictEqual(fs.readdirSync(path.join(support, 'Jobs')), []);
  assert.deepStrictEqual(lessons.lessons(), [{ id, title: 'complete', noteCount: 2 }]);
  await until(() => /diagnostics go to the log/.test(fs.readFileSync(path.join(support, 'Logs', 'lesson.log'), 'utf8')), 'the worker’s diagnostics in lesson.log', 5000);
  ok('worker: arguments, environment, events in order, completion announced after exit, job folder removed');

  // Deleting the lesson the last state names returns the state to idle.
  assert.strictEqual(await lessons.deleteLesson(id), true);
  assert.deepStrictEqual(events[events.length - 1], { event: 'lesson-progress', phase: 'idle', message: '', progress: 0 });
  ok('deleting the lesson just made resets the state');

  // The worker reports an error, and one that dies without a word.
  events.length = 0;
  await lessons.importFile(source, 'pdf', 'error');
  await until(() => idle() === 2, 'the failing worker');
  assert.deepStrictEqual(events[events.length - 1], { event: 'lesson-progress', phase: 'error', message: 'No playable piano notes were found in this file.', progress: 0, detail: 'Traceback: x' });
  events.length = 0;
  assert.strictEqual(await lessons.openVideo(source), true);
  lessons.cancel();   // openVideo names the lesson after the file; run the crash under its own title instead
  await until(() => idle() === 3, 'the cancelled worker');
  events.length = 0;
  await lessons.importFile(source, 'video', 'crash');
  await until(() => idle() === 4, 'the crashing worker');
  assert.deepStrictEqual(events[events.length - 1], { event: 'lesson-progress', phase: 'error', message: 'The lesson could not be created. The process stopped unexpectedly.', progress: 0 });
  ok('worker error and unexpected exit');

  // Cancelling a running job ends the worker and what it started, and removes its lesson.
  events.length = 0;
  const hanging = await lessons.importFile(source, 'video', 'hang');
  await until(() => events.some(event => event.child), 'the worker to start its own process');
  const child = events.find(event => event.child).child;
  assert.strictEqual(alive(child), true);
  assert.strictEqual(fs.existsSync(path.join(support, 'Lessons', `${hanging}.json`)), true);
  const before = Date.now();
  lessons.cancel();
  assert.strictEqual(lessons.running, true);
  assert.deepStrictEqual(events[events.length - 1], { event: 'lesson-progress', phase: 'cancelling', message: 'Cancelling…', progress: 0 });
  throws(() => lessons.begin({}), 'Finish or cancel the current task first.');
  await until(() => idle() === 5, 'the cancelled worker to go', 15000);
  assert.deepStrictEqual(events[events.length - 1], { event: 'lesson-progress', phase: 'cancelled', message: 'Cancelled', progress: 0 });
  await until(() => !alive(child), 'the worker’s own process to end', 5000);
  assert.strictEqual(lessons.running, false);
  assert.strictEqual(fs.existsSync(path.join(support, 'Lessons', `${hanging}.json`)), false);
  assert.deepStrictEqual(fs.readdirSync(path.join(support, 'Jobs')), []);
  console.log(`   cancelled in ${Date.now() - before} ms; the worker’s child process ${child} is gone`);
  ok('cancel while running: cancelling, then cancelled; the whole process group ends');

  // A YouTube job starts without an upload.
  events.length = 0;
  const link = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  lessons.importYouTube(link, 'error');
  await until(() => idle() === 6, 'the YouTube stand-in');
  assert.deepStrictEqual(events.map(event => event.phase), ['upload', 'starting', 'starting', 'error']);
  assert.strictEqual(events[2].probe.input, null);
  ok('importYouTube starts the worker with the link');

  // An Engine folder without its Python. The modules are loaded from a copy outside the
  // repository, as in a packaged app, so the development engine cannot answer instead.
  const copy = path.join(work, 'packaged', 'electron');
  fs.mkdirSync(copy, { recursive: true });
  for (const name of ['lessons.js', 'localization.js', 'settings.js']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(copy, name));
  const broken = path.join(work, 'BrokenEngine');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'worker.py'), '');
  const missing = service('missing', broken, null, { create: require(path.join(copy, 'lessons.js')).createLessons });
  await rejects(missing.lessons.importFile(source, 'midi', 'x'), 'The lesson engine is missing. Reinstall rach3.');
  assert.deepStrictEqual(missing.phases(), ['upload', 'cancelled']);
  assert.strictEqual(missing.lessons.running, false);
  assert.strictEqual(missing.idle(), 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(missing.support, 'Jobs')), []);
  assert.throws(() => missing.lessons.tools(), /ENOENT/);
  ok('a missing engine cancels the job and says so');
}

// The real thing: lesson-engine/worker.py makes a lesson from the sample MIDI file.
async function realImport() {
  const sample = path.join(ROOT, 'a-small-measure-of-peace-video.mid');
  const installed = path.join(os.homedir(), WINDOWS ? 'AppData/Local/Rach3/Tools/1' : 'Library/Application Support/Rach3/Tools/1');
  const from = WINDOWS ? path.join(installed, 'a') : path.join(installed, 'artifacts');
  if (!fs.existsSync(python) || !fs.existsSync(path.join(ROOT, 'lesson-engine', 'worker.py'))) return skip('real MIDI import', 'no engine or portable Python in this repository');
  if (!fs.existsSync(sample) || !fs.existsSync(from)) return skip('real MIDI import', 'no sample file or no installed lesson tools on this machine');
  // The installed tools are linked, never changed: new files go to the temporary folder.
  const tools = path.join(work, 'real', 'Tools', '1');
  const into = WINDOWS ? path.join(tools, 'a') : path.join(tools, 'artifacts');
  fs.mkdirSync(into, { recursive: true });
  for (const name of fs.readdirSync(from)) fs.symlinkSync(path.join(from, name), path.join(into, name), 'junction');
  const stamp = () => ['', 'artifacts', 'profiles', 'downloads', 'install.lock'].map(name => { try { return fs.statSync(path.join(installed, name)).mtimeMs; } catch { return null; } });
  const before = stamp();
  const { lessons, support, events, idle, phases } = service('real', path.join(work, 'packaged-engine-absent'), tools);
  const missing = lessons.missingToolBytes('midi');
  if (missing !== 0) return skip('real MIDI import', `${missing} bytes of tools would have to be downloaded`);

  const started = Date.now();
  const id = await lessons.importFile(sample, 'midi', 'Peace');
  await until(() => idle() === 1, 'the real worker', 180000);
  console.log(`   phases: ${phases().join(' → ')}`);
  const last = events[events.length - 1];
  console.log(`   last event: ${JSON.stringify(last)}`);
  if (last.phase !== 'complete') console.log(fs.readFileSync(path.join(support, 'Logs', 'lesson.log'), 'utf8'));
  assert.strictEqual(last.phase, 'complete');
  assert.strictEqual(last.id, id);
  assert.strictEqual(last.message, 'Your lesson is ready');
  const lesson = lessons.lesson(id);
  assert.strictEqual(lesson.id, id);
  assert.strictEqual(lesson.title, 'Peace');
  assert(lesson.noteCount > 0);
  assert.deepStrictEqual(lessons.lessons(), [{ id, title: 'Peace', noteCount: lesson.noteCount }]);
  assert.deepStrictEqual(fs.readdirSync(path.join(support, 'Lessons')).sort(), [`${id}.assets`, `${id}.json`]);
  assert.deepStrictEqual(fs.readFileSync(path.join(support, 'Lessons', `${id}.assets`, 'source.midi')), fs.readFileSync(sample));
  assert.deepStrictEqual(fs.readdirSync(path.join(support, 'Jobs')), []);
  assert.deepStrictEqual(stamp(), before);
  console.log(`   ${lesson.noteCount} notes in ${((Date.now() - started) / 1000).toFixed(1)} s; Lessons/: ${fs.readdirSync(path.join(support, 'Lessons')).sort().join(', ')}`);
  ok('real MIDI import, end to end, with the engine from the repository');

  // The lesson the Windows build check expects from this file (windows/build.py: 549 notes).
  const bach = path.join(ROOT, 'assets', 'example-lessons', 'bach-prelude', 'score.mid');
  if (!fs.existsSync(bach)) return skip('reference MIDI import', 'no bach-prelude example in this repository');
  const second = await lessons.importFile(bach, 'midi', null);
  await until(() => idle() === 2, 'the real worker', 180000);
  assert.strictEqual(events[events.length - 1].phase, 'complete');
  assert.deepStrictEqual(lessons.lessons().find(entry => entry.id === second), { id: second, title: 'score', noteCount: 549 });
  assert.deepStrictEqual(stamp(), before);
  console.log(`   ${JSON.stringify(lessons.lessons().find(entry => entry.id === second))}`);
  ok('reference MIDI import makes the same 549-note lesson the build check expects');
}

(async () => {
  console.log(`node ${process.version} on ${process.platform}-${process.arch}; working in ${work}`);
  try {
    localization();
    await withoutWorker();
    await standInWorker();
    await realImport();
    console.log(`\n${passed} passed, ${skipped} skipped`);
  } catch (error) {
    console.error(`\nFAILED after ${passed} passed:`, error);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left in the temporary folder */ }
    // Also runs as an Electron main process (`electron electron/tests/lessons.test.js`), which has to be told to end.
    if (process.versions.electron && require('electron').app) require('electron').app.exit(process.exitCode || 0);
  }
})();
