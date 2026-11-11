'use strict';
// Checks the real app runs on itself when asked from the command line, on Mac and Windows:
//
//   --capture FOLDER [en|tr] [--self-test-midi FILE]
//       Draws the website's screenshots (practice.png, create-lesson.png) from a throwaway
//       data folder. With a MIDI file it also creates a lesson through the page's bridge,
//       exactly as the interface does (self-test.json, lesson-created.png).
//       Anything wrong is written to capture-error.txt and page-errors.txt and exits 1.
//   --self-test-update FOLDER KEY RESULT          (test builds on Windows only)
//       A real installed update from FOLDER, accepted only with a feed signature from KEY.
const fs = require('fs');
const path = require('path');

const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));

function captureOptions(argv) {
  const at = argv.indexOf('--capture');
  if (at < 0 || !argv[at + 1]) return null;
  const midi = argv.indexOf('--self-test-midi');
  return { folder: path.resolve(argv[at + 1]), language: argv[at + 2] === 'tr' ? 'tr' : 'en',
    midi: midi > 0 && argv[midi + 1] ? path.resolve(argv[midi + 1]) : null, started: false, errors: [] };
}

// page: { run(code) -> value of an async function body, shot() -> image of the page }
async function capture(options, page) {
  const { folder, language } = options;
  const shot = async name => {
    fs.writeFileSync(path.join(folder, name), (await page.shot()).resize({ width: 1600, quality: 'best' }).toPNG());
    console.log('Saved application screenshot:', name);
  };
  const ready = `return window.PianoI18n?.language === ${JSON.stringify(language)} && !!document.querySelector('#sheet-paper svg') && !document.getElementById('sheet-paper').hidden;`;
  for (let attempt = 0; ; attempt++) {
    if (await page.run(ready).catch(() => false)) break;
    if (attempt >= 60) throw new Error('The score was not ready: ' + await page.run(`return document.getElementById('sheet-loading-text')?.textContent;`).catch(error => error.message));
    await wait(1000);
  }
  // Plain falling bars on the website: no staff badges, no note names.
  await page.run(`document.getElementById('tab-practice').click(); const staff=document.getElementById('staff'); staff.checked=false; staff.dispatchEvent(new Event('change',{bubbles:true})); const names=document.getElementById('notation'); names.value='none'; names.dispatchEvent(new Event('change',{bubbles:true})); const seek=document.getElementById('seek'); seek.value=25; seek.dispatchEvent(new Event('input',{bubbles:true}));`);
  await wait(2000);
  await shot('practice.png');
  const banner = await page.run(`const e = document.getElementById('error'); return e && !e.hidden ? e.textContent : '';`);
  if (banner) throw new Error('The page shows an error: ' + banner);
  await page.run(`document.getElementById('tab-create').click();`);
  await wait(1500);
  await shot('create-lesson.png');
  if (process.platform === 'win32') {
    const mac = await page.run(`return (document.body.innerText.match(/[^\\n]*(\\bMac\\b|Mac’|macOS)[^\\n]*/) || [''])[0];`);
    if (mac) throw new Error('Mac wording on Windows: ' + mac);
  }
  if (options.midi) await lesson(options, page, shot);
}

// Creates a lesson from a MIDI file through the page bridge, exactly as the interface does.
async function lesson(options, page, shot) {
  const data = fs.readFileSync(options.midi), chunks = [], title = 'Şarkı ğüşıöç';
  for (let offset = 0; offset < data.length; offset += 1024 * 1024) chunks.push(data.subarray(offset, offset + 1024 * 1024).toString('base64'));
  const request = { command: 'lesson-begin', name: path.basename(options.midi), kind: 'midi', size: data.length, title, tempo: 60, separate: false };
  const result = await page.run(`
  const native = window.webkit.messageHandlers.rach3;
  try {
    const finished = new Promise(resolve => {
      const listener = event => {
        const detail = event.detail;
        if (detail.event === 'lesson-progress' && ['complete', 'error', 'cancelled'].includes(detail.phase)) {
          window.removeEventListener('rach3-native-event', listener); resolve(detail);
        }
      };
      window.addEventListener('rach3-native-event', listener);
    });
    const job = await native.postMessage(${JSON.stringify(request)});
    for (const data of ${JSON.stringify(chunks)}) await native.postMessage({ command: 'lesson-chunk', id: job.id, data });
    await native.postMessage({ command: 'lesson-start', id: job.id });
    const done = await finished;
    if (done.phase !== 'complete') throw new Error(done.message);
    const list = await native.postMessage({ command: 'lesson-list' });
    const lesson = await native.postMessage({ command: 'lesson-load', id: done.id });
    let rejected = false;
    try { await native.postMessage({ command: 'lesson-load', id: 'not-a-lesson' }); } catch (error) { rejected = true; }
    return { ok: true, noteCount: lesson.noteCount, title: lesson.title, listed: list.some(item => item.id === done.id), rejectsInvalid: rejected };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }`);
  fs.writeFileSync(path.join(options.folder, 'self-test.json'), JSON.stringify(result));
  if (!result.ok || !result.listed || !result.rejectsInvalid || result.title !== title || !(result.noteCount > 0))
    throw new Error('Self-test failed: ' + JSON.stringify(result));
  await page.run(`document.getElementById('tab-practice').click();`);
  await wait(1500);
  await shot('lesson-created.png');
}

// Runs the capture and ends the app: exit code 0 only when nothing went wrong.
async function runCapture(options, page, exit) {
  let code = 1;
  fs.mkdirSync(options.folder, { recursive: true });
  try { await capture(options, page); code = 0; }
  catch (error) { console.error('Capture failed:', error.message); fs.writeFileSync(path.join(options.folder, 'capture-error.txt'), String(error.stack || error)); }
  fs.writeFileSync(path.join(options.folder, 'page-errors.txt'), options.errors.join('\n'));
  if (options.errors.length) { console.error('Page errors:\n' + options.errors.join('\n')); code = 1; }
  exit(code);
}

// A real installed update (Windows test builds). Writes what happened to RESULT; when a
// correctly signed update was downloaded, it installs once this process has ended.
async function selfTestUpdate(folder, key, resultPath) {
  const { UpdateManager } = require('velopack');
  const { signedAssets, requireSigned } = require('./updates-windows');
  const result = {};
  try {
    const manager = new UpdateManager(folder);
    result.current = manager.getCurrentVersion();
    result.installed = true;
    const info = await manager.checkForUpdatesAsync();
    result.available = info ? String(info.TargetFullRelease.Version) : null;
    if (info) {
      result.deltas = (info.DeltasToTarget || []).length;
      result.base = info.BaseRelease ? String(info.BaseRelease.Version) : null;
      try {
        requireSigned(signedAssets(Buffer.from(key, 'base64'), fs.readFileSync(path.join(folder, 'releases.win.json')),
          fs.readFileSync(path.join(folder, 'releases.win.json.sig'), 'utf8')), info);
      } catch (error) { result.rejected = error.message; }
      if (!('rejected' in result)) {
        await manager.downloadUpdateAsync(info);
        result.applying = String(info.TargetFullRelease.Version);
        fs.writeFileSync(resultPath, JSON.stringify(result));
        manager.waitExitThenApplyUpdate(info.TargetFullRelease, true, false);
        return;
      }
    }
  } catch (error) { result.error = String(error.stack || error); }
  fs.writeFileSync(resultPath, JSON.stringify(result));
}

module.exports = { captureOptions, runCapture, selfTestUpdate };
