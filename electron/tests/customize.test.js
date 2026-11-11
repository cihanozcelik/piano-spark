// Tries electron/customize.js against a temporary data folder: the file bindings, the
// page server, the lesson desk, the hidden preview, Sign in with ChatGPT against a
// stand-in, and, when a Codex and a stand-in for OpenAI are at hand, one whole change.
//
//   npx electron electron/tests/customize.test.js
//   RACH3_TEST_CODEX=<folder with bin/codex> adds the whole change (openai-stand-in.py, needs Python).
//
// Nothing here touches rach3's real data folder or a real ChatGPT account.
const electron = require('electron');
const { app, BrowserWindow, ipcMain, nativeImage, protocol, session } = electron;
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rach3-customize-test-')));
app.setPath('userData', path.join(temp, 'electron'));
protocol.registerSchemesAsPrivileged([{ scheme: 'rach3-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (process.env.RACH3_TEST_AS_WINDOWS) Object.defineProperty(process, 'platform', { value: 'win32' });
const { createCustomize } = require('../customize');

let failures = 0;
const check = (name, passed, detail) => {
  if (!passed) failures++;
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, passed, seconds = 30) {
  let value;
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await wait(250)) { value = await read(); if (passed(value)) return value; }
  return value;
}
const rejects = async promise => { try { await promise; return null; } catch (error) { return error.message; } };

// The interface as one flat folder, the list desktop/build.py uses.
const SOURCE = ['piano.html', 'i18n.js', 'i18n-messages.js', 'desktop.js', 'player.js', 'workspace-state.js', 'sheet-music.js', 'piano-input.js',
  'piano-output.js', 'practice-clock.js', 'practice-session.js', 'hand-reach.js', 'staff-notation.js', 'create-lesson.js', 'lesson-chat.js',
  'app-shell.js', 'assets/bravura/Bravura.woff2', 'assets/brand/rach3-wordmark-on-dark.png', 'assets/notation/verovio-toolkit-wasm.js'];
const MOVED = { 'bluetooth.js': 'bluetooth-connection/bluetooth.js', 'bluetooth-diagnostics.js': 'bluetooth-connection/bluetooth-diagnostics.js',
  'AGENTS.md': 'desktop/customize/AGENTS.md' };
const source = path.join(temp, 'Source'), support = path.join(temp, 'Support');
for (const [name, origin] of [...SOURCE.map(name => [name, name]), ...Object.entries(MOVED)]) {
  fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, origin), path.join(source, name));
}
const scripts = path.join(ROOT, 'desktop', 'customize');
const codexRoot = process.env.RACH3_TEST_CODEX || path.join(temp, 'no-codex');
const mock = process.env.RACH3_TEST_MOCK || path.join(__dirname, 'openai-stand-in.py');

// Stand-ins for the internet: every request rach3 itself makes goes through fetch.
const requests = [];
let tokenAnswer = null;
const realFetch = globalThis.fetch;
const pdf = fs.readFileSync(path.join(ROOT, 'assets/example-lessons/moonlight/complete-score.pdf'));
const midi = fs.readFileSync(path.join(ROOT, 'a-small-measure-of-peace-video.mid'));
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input.url || input);
  requests.push({ url, method: init.method || 'GET', body: typeof init.body === 'string' ? init.body : null });
  const answer = (body, status = 200, headers = {}) => new Response(body, { status, headers });
  if (url.startsWith('https://auth.openai.com/api/accounts/oauth/token')) return tokenAnswer(new URLSearchParams(init.body));
  if (url.startsWith('https://auth.openai.com/api/accounts/oauth/revoke')) return answer('{}');
  if (url.startsWith('https://www.youtube.com/oembed')) return answer(JSON.stringify({ title: 'Clair de lune', author_name: 'A pianist' }));
  if (url.startsWith('https://i.ytimg.com/')) return answer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 200, { 'content-type': 'image/jpeg' });
  if (url === 'https://scores.test/moved.pdf') return answer(null, 302, { location: 'https://scores.test/moonlight%20sonata.pdf' });
  if (url === 'https://scores.test/moonlight%20sonata.pdf') return answer(pdf, 200, { 'content-length': String(pdf.length) });
  if (url === 'https://scores.test/away.pdf') return answer(null, 302, { location: 'http://127.0.0.1:9/secret' });
  if (url === 'https://scores.test/peace.mid') return answer(midi);
  if (url === 'https://scores.test/broken.pdf') return answer('%PDF-1.7\nnot really a score');
  if (url === 'https://scores.test/page.html') return answer('<html>about the piece</html>');
  if (url === 'https://scores.test/missing.mid') return answer('no', 404);
  return realFetch(input, init);
};
const opened = [], trashed = [];
electron.shell.openExternal = async url => { opened.push(url); };
const realTrash = electron.shell.trashItem;
electron.shell.trashItem = async file => { trashed.push(file); fs.rmSync(file, { recursive: true, force: true }); };

const shown = [], deskEvents = [], lessons = [], panels = [], imports = [];
let panel = null, page = null, customize = null;
const toCore = message => { if (panel && !panel.isDestroyed()) panel.webContents.executeJavaScript(`window.rach3Core?.receive(${JSON.stringify(message)}); null`).catch(() => {}); };
const inPanel = body => panel.webContents.executeJavaScript(`(async () => { ${body} })()`);
const jwt = payload => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
const get = url => new Promise((resolve, reject) => http.get(url, answer => { let body = ''; answer.on('data', chunk => { body += chunk; }); answer.on('end', () => resolve({ status: answer.statusCode, body })); }).on('error', reject));

async function files(native) {
  const info = await native({ op: 'info' });
  check('info', info.platform === (process.platform === 'darwin' ? 'mac' : 'windows') && info.version === '9.9.9' && info.language === 'en' &&
    info.workspace === path.join(support, 'Customize', 'workspace'), info);
  check('unknown op is refused', await rejects(native({ op: 'nope' })) === 'invalid' && await rejects(native({})) === 'invalid');
  await native({ op: 'set-preference', key: 'welcomed', value: true });
  check('preferences', (await native({ op: 'preferences' })).welcomed === true && JSON.parse(fs.readFileSync(path.join(support, 'Customize/preferences.json'))).welcomed === true &&
    await rejects(native({ op: 'set-preference', key: 'host', value: 'x' })) === 'invalid');

  check('write + read', await native({ op: 'write', area: 'data', path: 'designs.json', text: '{"a":"ğ"}' }) === true &&
    await native({ op: 'read', area: 'data', path: 'designs.json' }) === '{"a":"ğ"}');
  check('read source', (await native({ op: 'read', area: 'source', path: 'AGENTS.md' })).startsWith('# rach3 interface'));
  check('source is read-only', await native({ op: 'write', area: 'source', path: 'x.js', text: 'x' }) === false && !fs.existsSync(path.join(source, 'x.js')));
  check('only rach3\'s own entries in data', await native({ op: 'write', area: 'data', path: 'session.json', text: '{}' }) === false &&
    await native({ op: 'read', area: 'data', path: 'preferences.json' }) === null && await native({ op: 'write', area: 'data', path: 'codex/config.toml', text: '' }) === false);
  check('no way out of the folder', await native({ op: 'write', area: 'data', path: 'designs/../../out.txt', text: 'x' }) === false &&
    await native({ op: 'write', area: 'data', path: 'designs/.hidden', text: 'x' }) === false && await native({ op: 'write', area: 'lessons', path: '/tmp/x', text: 'x' }) === false &&
    await native({ op: 'read', area: 'lessons', path: '../Customize/preferences.json' }) === null);
  fs.mkdirSync(path.join(support, 'Customize/designs/d1'), { recursive: true });
  fs.symlinkSync(os.homedir(), path.join(support, 'Customize/designs/d1/link'));
  check('links are not followed', await native({ op: 'exists', area: 'data', path: 'designs/d1/link' }) === null &&
    (await native({ op: 'list', area: 'data', path: 'designs/d1/link' })).length === 0 &&
    await native({ op: 'write', area: 'data', path: 'designs/d1/link/rach3-test.txt', text: 'x' }) === false);
  check('exclusive write', await native({ op: 'write', area: 'lessons', path: 'a.json', text: '{"id":"A","title":"One","noteCount":3}', exclusive: true }) === true &&
    await native({ op: 'write', area: 'lessons', path: 'a.json', text: 'again', exclusive: true }) === false &&
    (await native({ op: 'read', area: 'lessons', path: 'a.json' })).includes('One'));
  fs.writeFileSync(path.join(support, 'Lessons/broken.json'), 'not json');
  check('summaries', JSON.stringify(await native({ op: 'summaries', area: 'lessons', path: '' })) === '[{"id":"A","title":"One","noteCount":3,"duration":0}]');
  check('exists', await native({ op: 'exists', area: 'source', path: '' }) === 'folder' && await native({ op: 'exists', area: 'source', path: 'piano.html' }) === 'file' &&
    await native({ op: 'exists', area: 'data', path: 'workspace' }) === null);
  check('open-workspace + copy', await native({ op: 'open-workspace' }) === true &&
    await native({ op: 'copy', from: { area: 'source', path: '' }, to: { area: 'data', path: 'workspace' } }) === true);
  const listed = await native({ op: 'list', area: 'data', path: 'workspace' });
  check('list', listed.length === SOURCE.length + 3 && listed.includes('assets/bravura/Bravura.woff2') && listed.includes('piano.html'), listed.length);
  check('same', await native({ op: 'same', a: { area: 'source', path: 'player.js' }, b: { area: 'data', path: 'workspace/player.js' } }) === true &&
    await native({ op: 'same', a: { area: 'source', path: 'player.js' }, b: { area: 'data', path: 'workspace/i18n.js' } }) === false &&
    await native({ op: 'same', a: { area: 'source', path: 'nothing.js' }, b: { area: 'data', path: 'workspace/nothing.js' } }) === true &&
    await native({ op: 'same', a: { area: 'source', path: 'player.js' }, b: { area: 'data', path: 'workspace/nothing.js' } }) === false);
  check('copy one file over another', await native({ op: 'copy', from: { area: 'source', path: 'i18n.js' }, to: { area: 'data', path: 'workspace/sub/copy.js' } }) === true &&
    await native({ op: 'same', a: { area: 'source', path: 'i18n.js' }, b: { area: 'data', path: 'workspace/sub/copy.js' } }) === true &&
    await native({ op: 'copy', from: { area: 'data', path: 'workspace' }, to: { area: 'source', path: 'stolen' } }) === false);
  check('move', await native({ op: 'move', from: { area: 'data', path: 'workspace' }, to: { area: 'data', path: 'designs/d2' } }) === true &&
    await native({ op: 'exists', area: 'data', path: 'workspace' }) === null && await native({ op: 'exists', area: 'data', path: 'designs/d2/sub/copy.js' }) === 'file' &&
    await native({ op: 'move', from: { area: 'data', path: 'designs/d2' }, to: { area: 'data', path: 'designs/d1' } }) === false &&
    await native({ op: 'move', from: { area: 'source', path: 'piano.html' }, to: { area: 'data', path: 'designs/p.html' } }) === false);
  await native({ op: 'remove', area: 'data', path: 'designs/d2/sub' });
  await native({ op: 'remove', area: 'lessons', path: '' });
  await native({ op: 'remove', area: 'data', path: '' });
  check('remove', await native({ op: 'exists', area: 'data', path: 'designs/d2/sub' }) === null && fs.existsSync(path.join(support, 'Lessons/a.json')) &&
    fs.existsSync(path.join(support, 'Customize/designs.json')));
  await native({ op: 'trash', area: 'lessons', path: 'broken.json' });
  check('trash asks the system', trashed.length === 1 && trashed[0] === path.join(support, 'Lessons', 'broken.json'), trashed);
  if (process.platform !== 'win32') check('private files', (fs.statSync(path.join(support, 'Customize/preferences.json')).mode & 0o777) === 0o600 &&
    (fs.statSync(path.join(support, 'Customize')).mode & 0o777) === 0o700);
}

async function serving(native) {
  const fetched = async (address, headers) => { const answer = await customize.serve(new Request(address, { headers })); return { status: answer.status, type: answer.headers.get('content-type'), cache: answer.headers.get('cache-control'), body: Buffer.from(await answer.arrayBuffer()) }; };
  let answer = await fetched('rach3-app://app/piano.html');
  check('serve the page', answer.status === 200 && answer.type === 'text/html; charset=utf-8' && answer.cache === 'no-store' && answer.body.equals(fs.readFileSync(path.join(source, 'piano.html'))));
  answer = await fetched('rach3-app://app/');
  check('serve "/" as the page', answer.status === 200 && answer.type === 'text/html; charset=utf-8');
  check('serve refuses other hosts and ways out', (await fetched('rach3-app://other/piano.html')).status === 404 && (await fetched('rach3-app://app/..%2F..%2FSupport/Customize/preferences.json')).status === 404 &&
    (await fetched('rach3-app://app/%2e%2e/Support/Lessons/a.json')).status === 404 && (await fetched('rach3-app://app/nothing.js')).status === 404);
  // A saved version on a branch: its own files, but never its own protected ones.
  fs.writeFileSync(path.join(support, 'Customize/designs/d2/player.js'), '// changed');
  fs.writeFileSync(path.join(support, 'Customize/designs/d2/AGENTS.md'), 'changed guide');
  check('show refuses bad names', await rejects(native({ op: 'show', host: 'Bad Host', design: 'd2' })) === 'invalid' && await rejects(native({ op: 'show', host: 'b1', design: '../x' })) === 'invalid');
  await native({ op: 'show', host: 'B20260101-test', design: 'd2', start: false });
  check('show', customize.pageURL === 'rach3-app://b20260101-test/piano.html' && shown.at(-1) === false, customize.pageURL);
  check('serve the design on screen', (await fetched('rach3-app://b20260101-test/player.js')).body.toString() === '// changed' &&
    (await fetched('rach3-app://b20260101-test/AGENTS.md')).body.toString().startsWith('# rach3 interface') &&
    (await fetched('rach3-app://app/player.js')).status === 404);
  check('seed once', customize.needsSeed('b20260101-test') === true && customize.needsSeed('app') === false &&
    (customize.markSeeded('b20260101-test'), customize.needsSeed('b20260101-test')) === false);
  await native({ op: 'show', host: 'app', design: 'original', start: true });
  check('back to the original', customize.pageURL === 'rach3-app://app/piano.html' && shown.at(-1) === true && (await fetched('rach3-app://app/player.js')).body.length > 1000);
  check('error script', customize.errorScript.includes("command: 'page-error'"));
}

async function desk(native) {
  const fetched = async address => { const answer = await customize.serve(new Request(address)); return { status: answer.status, type: answer.headers.get('content-type'), body: Buffer.from(await answer.arrayBuffer()) }; };
  const size = png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  let made = await native({ op: 'desk-show', source: 'https://youtu.be/dQw4w9WgXcQ?t=3', title: '', note: 'why' });
  check('desk: YouTube card', made.card?.kind === 'youtube' && made.card.link === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' && made.card.title === 'Clair de lune' &&
    made.card.author === 'A pianist' && made.card.thumb === `_desk/${made.card.id}/thumb.jpg` && made.card.state === 'shown', made);
  const video = made.card;
  check('desk: serves the thumbnail', (await fetched(`rach3-app://app/${video.thumb}`)).type === 'image/jpeg' && (await fetched(`rach3-app://other/${video.thumb}`)).status === 404);
  made = await native({ op: 'desk-show', source: 'https://scores.test/peace.mid', title: 'Peace', note: '' });
  check('desk: MIDI card', made.card?.kind === 'midi' && made.card.title === 'Peace' && made.card.size === midi.length && (await fetched(`rach3-app://app/${made.card.file}`)).body.equals(midi), made);
  const midiCard = made.card;
  const started = Date.now();
  made = await native({ op: 'desk-show', source: ' https://scores.test/moved.pdf ', title: '', note: '' });
  check('desk: PDF card', made.card?.kind === 'pdf' && made.card.pageCount === 23 && made.card.pages?.length === 3 && made.card.title === 'moved', { ...made, seconds: (Date.now() - started) / 1000 });
  const score = made.card;
  if (score) {
    const first = await fetched(`rach3-app://app/${score.pages[0]}`);
    const dimensions = first.status === 200 ? size(first.body) : null;
    check('desk: first page picture', first.type === 'image/png' && dimensions.width > 800 && dimensions.width <= 1000 && dimensions.height > 600, dimensions);
    fs.writeFileSync(path.join(temp, 'page-1.png'), first.body);
    const large = await fetched(`rach3-app://app/_desk/${score.id}/large-7.png`);
    const big = large.status === 200 ? size(large.body) : null;
    check('desk: any page, large', large.status === 200 && big.width > 2000 && big.width <= 2400 && fs.existsSync(path.join(support, 'Customize/desk', score.id, 'large-7.png')), big);
    if (large.status === 200) fs.writeFileSync(path.join(temp, 'large-7.png'), large.body);
    check('desk: no page past the end, no other files', (await fetched(`rach3-app://app/_desk/${score.id}/page-24.png`)).status === 404 &&
      (await fetched(`rach3-app://app/_desk/${score.id}/source.pdf`)).status === 404 && (await fetched(`rach3-app://app/_desk/${score.id}/..%2Fdesk.json`)).status === 404);
    check('desk: progress told', deskEvents.some(event => event.event === 'desk-progress' && event.stage === 'download' && event.host === 'scores.test') &&
      deskEvents.some(event => event.event === 'desk-progress' && event.stage === 'pages') && deskEvents.some(event => event.stage === 'video'));
    const request = await native({ op: 'import-lesson', kind: 'pdf', card: score.id, link: null, title: 'Moonlight' });
    check('desk: import gets the file', request.job === 'job-1' && imports[0].file === path.join(support, 'Customize/desk', score.id, 'source.pdf') && imports[0].title === 'Moonlight' && imports[0].kind === 'pdf', imports[0]);
  }
  for (const [link, expected] of [['https://scores.test/page.html', 'The link is not a MIDI or PDF file. Link the file itself, not the page about it.'],
    ['http://scores.test/peace.mid', 'Only https links can be opened.'], ['https://scores.test/away.pdf', 'Only https links can be opened.'],
    ['https://scores.test/missing.mid', 'The site answered 404.'], ['https://scores.test/broken.pdf', 'The PDF could not be opened.'], ['not a link', 'That is not a link.']]) {
    const began = Date.now();
    const refused = await native({ op: 'desk-show', source: link, title: '', note: '' });
    check(`desk: ${link}`, refused.error === expected && !refused.card, { ...refused, seconds: (Date.now() - began) / 1000 });
  }
  await native({ op: 'desk-add', entry: { role: 'user', text: 'something by Debussy' } });
  await native({ op: 'desk-add', entry: { role: 'card', card: video } });
  await native({ op: 'desk-update', card: { ...midiCard, state: 'made' } });
  const entries = await native({ op: 'desk-entries' });
  check('desk: conversation', entries.length === 2 && entries[0].text === 'something by Debussy' && typeof entries[0].time === 'number' && entries[1].card?.id === video.id &&
    (await native({ op: 'desk-card', card: midiCard.id })).state === 'made' && customize.deskCard(midiCard.id).state === 'made' && customize.deskCard('nobody') === null &&
    await native({ op: 'desk-card', card: 'nobody' }) === null);
  await native({ op: 'desk-event', event: { event: 'desk-card', card: video } });
  check('desk: events reach the page', deskEvents.at(-1).event === 'desk-card' && await native({ op: 'missing-tools', kind: 'pdf' }) === 1234);
  await native({ op: 'desk-clear' });
  check('desk: clear', (await native({ op: 'desk-entries' })).length === 0 && fs.readdirSync(path.join(support, 'Customize/desk')).join() === 'desk.json');
}

async function previewing(native) {
  await native({ op: 'remove', area: 'data', path: 'workspace' });
  await native({ op: 'copy', from: { area: 'source', path: '' }, to: { area: 'data', path: 'workspace' } });
  const file = path.join(support, 'Customize/workspace/desktop.js');
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\nconsole.error('rach3 test: a reported error'); setTimeout(() => { throw new Error('rach3 test: a thrown error'); }, 50);\n` +
    'document.body.insertAdjacentHTML("beforeend", "<img src=\\"https://example.com/x.png\\">");\n');
  fs.writeFileSync(path.join(support, 'Customize/workspace/AGENTS.md'), 'changed guide');
  // No larger than the page a small screen shows: Windows does not make a window larger than the screen.
  customize.previewSize = { width: 1000, height: 700 };
  const started = Date.now();
  const result = await native({ op: 'preview', script: `
    const online = await fetch('https://example.com/').then(() => 'reached', () => 'blocked');
    const language = (await window.webkit.messageHandlers.rach3.postMessage({ command: 'get-language' })).language;
    const guide = (await (await fetch('/AGENTS.md')).text()).slice(0, 17);
    const lessons = await window.webkit.messageHandlers.rach3.postMessage({ command: 'set-language', language: 'tr' });
    return { online, language, guide, lessons, address: location.href, mac: document.documentElement.dataset.windowControls ?? null, title: document.title };` });
  const image = result.image ? nativeImage.createFromDataURL(result.image) : null;
  if (image) fs.writeFileSync(path.join(temp, 'preview.jpg'), image.toJPEG(80));
  check('preview: screenshot', !!image && result.image.startsWith('data:image/jpeg;base64,') && image.getSize().width === 1000 && image.getSize().height === 700, { size: image?.getSize(), seconds: (Date.now() - started) / 1000, snapshotError: result.snapshotError, timedOut: result.timedOut });
  let said = {};
  try { said = JSON.parse(result.scriptResult); } catch { said = { raw: result.scriptResult }; }
  check('preview: script result, no internet, read-only bridge, protected files', said.online === 'blocked' && said.language === 'en' && said.guide === '# rach3 interface' &&
    JSON.stringify(said.lessons) === '{}' && said.address === 'rach3-app://app/piano.html' && said.mac === (process.platform === 'darwin' ? 'mac' : null), said);
  const kinds = (result.errors || []).map(error => `${error.kind}: ${String(error.message).slice(0, 60)}`);
  check('preview: errors collected', kinds.some(kind => kind.startsWith('console: rach3 test: a reported error')) && kinds.some(kind => kind.includes('rach3 test: a thrown error')) &&
    kinds.some(kind => kind.startsWith('resource: Could not load https://example.com/x.png')) && result.errors.every(error => error.command === 'page-error'), kinds);
  const broken = await native({ op: 'preview', script: 'return (' });
  check('preview: a script that does not parse', /^Error: /.test(broken.scriptResult) && !!broken.image, broken.scriptResult);
  const thrown = await native({ op: 'preview', script: 'document.querySelector("#nothing").click();' });
  check('preview: a script that throws', /^Error: .*null/.test(thrown.scriptResult), thrown.scriptResult);
  const plain = await native({ op: 'preview', script: null });
  check('preview: no script', !('scriptResult' in plain) && !!plain.image && Array.isArray(plain.errors));
  fs.rmSync(path.join(support, 'Customize/workspace/piano.html'));
}

async function signingIn(native) {
  check('auth: signed out', JSON.stringify(await native({ op: 'auth' })) === '{"signedIn":false,"account":null,"signingIn":false,"signInError":null}');
  check('codex-ensure signed out', (await native({ op: 'codex-ensure' })).error === 'signed-out');
  // Denied in the browser.
  await native({ op: 'sign-in' });
  await until(() => opened.length, count => count === 1, 5);
  let asked = new URL(opened.at(-1));
  const query = Object.fromEntries(asked.searchParams);
  check('sign-in: the address opened', asked.origin + asked.pathname === 'https://auth.openai.com/api/accounts/authorize' && query.response_type === 'code' && query.client_id === 'dynamic_agent_client' &&
    query.agent_name_hint === 'rach3' && /^urn:uuid:[0-9a-f-]{36}$/.test(query.ext_agent_host_id) && /^http:\/\/127\.0\.0\.1:14(5[5-9]|6[0-5])\/auth\/callback$/.test(query.redirect_uri) &&
    query.scope === 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' && query.resource === 'https://api.openai.com/v1' &&
    query.code_challenge_method === 'S256' && query.code_challenge.length === 43 && (await native({ op: 'auth' })).signingIn === true, query);
  check('sign-in: other addresses are not found', (await get(query.redirect_uri.replace('/auth/callback', '/'))).status === 404 && (await native({ op: 'auth' })).signingIn === true);
  await get(`${query.redirect_uri}?error=access_denied&state=${query.state}`);
  let auth = await until(() => native({ op: 'auth' }), state => !state.signingIn, 5);
  check('sign-in: denied', auth.signInError === 'denied' && auth.signedIn === false, auth);
  // Cancelled in rach3.
  await native({ op: 'sign-in' });
  await until(() => opened.length, count => count === 2, 5);
  const cancelled = new URL(opened.at(-1)).searchParams.get('redirect_uri');
  await native({ op: 'cancel-sign-in' });
  check('sign-in: cancelled', (await native({ op: 'auth' })).signingIn === false && await rejects(get(cancelled)) !== null);
  // Wrong state, then the real thing.
  await native({ op: 'sign-in' });
  await until(() => opened.length, count => count === 3, 5);
  asked = new URL(opened.at(-1));
  await get(`${asked.searchParams.get('redirect_uri')}?code=abc&state=someone-else`);
  auth = await until(() => native({ op: 'auth' }), state => !state.signingIn, 5);
  check('sign-in: an answer that is not ours', auth.signInError === 'failed' && !auth.signedIn, auth);
  let exchange = null;
  tokenAnswer = fields => {
    exchange = Object.fromEntries(fields);
    return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct',
      id_token: jwt({ iss: 'https://auth.openai.com', nonce: asked.searchParams.get('nonce'), email: 'person@example.com', name: 'A Person' }) }), { status: 200 });
  };
  await native({ op: 'sign-in' });
  await until(() => opened.length, count => count === 4, 5);
  asked = new URL(opened.at(-1));
  const page = await get(`${asked.searchParams.get('redirect_uri')}?code=the-code&state=${asked.searchParams.get('state')}&client_id=issued-client`);
  auth = await until(() => native({ op: 'auth' }), state => state.signedIn, 5);
  const crypto = require('crypto');
  check('sign-in: signed in', page.status === 200 && page.body.includes('rach3 ✓') && auth.account?.email === 'person@example.com' && auth.account.name === 'A Person' && auth.signInError === null && !auth.signingIn, auth);
  check('sign-in: the exchange', exchange.grant_type === 'authorization_code' && exchange.client_id === 'issued-client' && exchange.code === 'the-code' && exchange.redirect_uri === asked.searchParams.get('redirect_uri') &&
    exchange.resource === 'https://api.openai.com/v1' && crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url') === asked.searchParams.get('code_challenge'), exchange);
  const kept = JSON.parse(fs.readFileSync(path.join(support, 'Customize/session.json'), 'utf8'));
  check('sign-in: kept', kept.access_token === 'access-1' && kept.refresh_token === 'refresh-1' && kept.expires_at > Date.now() / 1000 + 3500 &&
    JSON.parse(fs.readFileSync(path.join(support, 'Customize/preferences.json'), 'utf8')).client === 'issued-client' &&
    (process.platform === 'win32' || (fs.statSync(path.join(support, 'Customize/session.json')).mode & 0o777) === 0o600), { ...kept, id_token: '…' });
  check('sign-in: core.js is told', (await inPanel('return (await window.rach3Core.postMessage({ action: "state" })).account?.email;')) === 'person@example.com');
}

// Refreshing and signing out, once nothing else needs the sign-in.
async function signingOut(native) {
  const file = path.join(support, 'Customize/session.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), expires_at: Date.now() / 1000 + 60 }));
  customize.stop(); customize = make();   // reads the nearly expired sign-in, as after a restart
  let refresh = null;
  tokenAnswer = fields => { refresh = Object.fromEntries(fields); return new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), { status: 200 }); };
  const [first, second] = await Promise.all([customize.native({ op: 'codex-ensure' }), customize.native({ op: 'codex-ensure' })]);
  check('refresh: one request, new token kept', refresh?.grant_type === 'refresh_token' && refresh.refresh_token === 'refresh-1' && refresh.client_id === 'issued-client' &&
    requests.filter(request => request.url.endsWith('/oauth/token') && request.body.includes('grant_type=refresh_token')).length === 1 &&
    JSON.parse(fs.readFileSync(file, 'utf8')).access_token === 'access-2' && JSON.parse(fs.readFileSync(file, 'utf8')).refresh_token === 'refresh-1', { first, second });
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), expires_at: 0 }));
  customize.stop(); customize = make();
  tokenAnswer = () => new Response(JSON.stringify({ error: 'refresh_token_reused' }), { status: 400 });
  check('refresh: an expired sign-in is forgotten', (await customize.native({ op: 'codex-ensure' })).error === 'expired' && !fs.existsSync(file) && (await customize.native({ op: 'auth' })).signedIn === false);
  fs.writeFileSync(file, JSON.stringify({ access_token: 'a', refresh_token: 'refresh-3', expires_at: Date.now() / 1000 + 3600 }));
  customize.stop(); customize = make();
  await customize.native({ op: 'sign-out' });
  await wait(100);
  const revoke = requests.find(request => request.url.endsWith('/oauth/revoke'));
  check('sign-out', !fs.existsSync(file) && revoke?.method === 'POST' && revoke.body === 'token=refresh-3&token_type_hint=refresh_token&client_id=issued-client', revoke);
  await customize.native({ op: 'open-usage' });
  check('open-usage', opened.at(-1) === 'https://chatgpt.com/settings/usage');
}

// core.js itself, in a web view like the panel's, driving this module.
async function withCore() {
  panel = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload-panel.js'), contextIsolation: true, sandbox: true, partition: 'test-panel' } });
  await panel.loadURL('data:text/html,<title>panel</title>');
  panel.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 'warning') console.log('  panel:', event.message); });
  await inPanel('window.events = []; window.rach3Customize = { receive: event => window.events.push(event) };');
  await panel.webContents.executeJavaScript(fs.readFileSync(path.join(scripts, 'core.js'), 'utf8'));
  // Asked before core.js has started: kept until it says what is on screen.
  const early = customize.ask('state', {});
  const state = await early;
  check('core.js started; a question asked early is answered', state.event === 'customize-state' && state.active === 'original' && state.branch === 'main' && shown.at(-1) === true, { active: state.active, branch: state.branch, available: state.available });
  check('ask: lesson-list', JSON.stringify(await customize.ask('lesson-list', { preview: false })) === '[{"id":"A","title":"One","noteCount":3,"duration":0}]');
  check('ask: an error from core.js', await rejects(customize.ask('lesson-load', { id: 'nobody' })) === 'missing' && await rejects(customize.ask('nonsense', {})) === 'invalid');
  await inPanel('return window.rach3Core.postMessage({ action: "panel", open: true, toggle: 132 });');
  check('panel op', (await until(() => panels.at(-1), value => !!value, 3))?.join() === 'true,132');
  check('page-error reaches core.js', (await customize.ask('page-error', { error: { kind: 'error', message: 'rach3-app://app/player.js broke' } }), (await customize.ask('state', {})).pageErrors[0].message === 'player.js broke'));
}

// The page in a real window, loaded through rach3-app://.
async function realPage() {
  protocol.handle('rach3-app', request => customize.serve(request));
  page = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { contextIsolation: true, sandbox: true } });
  await page.loadURL(customize.pageURL);
  await wait(500);
  const state = await customize.ask('state', {});
  const seen = await page.webContents.executeJavaScript(`(async () => ({ address: location.href, guide: (await (await fetch('/AGENTS.md')).text()).slice(0, 17), again: (await fetch('/piano.html')).status,
    fonts: (await fetch('/assets/bravura/Bravura.woff2')).headers.get('content-type') }))()`);
  check('the page loads through rach3-app://', seen.address === 'rach3-app://app/piano.html' && seen.guide === '# rach3 interface' && seen.fonts === 'font/woff2', seen);
  check('opening the page clears its errors in core.js', state.pageErrors.length === 0, state.pageErrors);
  await customize.ask('page-error', { error: { kind: 'error', message: 'still here' } });
  await page.webContents.executeJavaScript('fetch("/piano.html").then(answer => answer.status)');
  await wait(300);
  check('the page fetching its own file does not', (await customize.ask('state', {})).pageErrors.length === 1);
}

// One whole change: Codex, talking to a stand-in for OpenAI, writes a file in the
// scratch copy and core.js saves it as a new version on a new branch.
// What Codex is asked to do, as the JavaScript its "exec" tool runs: the work a change
// needs (read a file, edit with apply_patch, run a command that writes), then one command
// for each thing a command must not reach. Every step reports on a line of its own.
function probeScript() {
  const windows = process.platform === 'win32';
  const says = (word, test) => windows ? `try { ${test} | Out-Null; "${word}=open" } catch { "${word}=closed" }` : `(${test}) >/dev/null 2>&1 && echo ${word}=open || echo ${word}=closed`;
  const commands = windows ? {
    read: 'Get-Content -LiteralPath piano.html -TotalCount 1',
    list: 'Get-ChildItem -Name | Select-Object -First 3',
    write: 'Set-Content -LiteralPath written.txt -Value x; "write=" + (Test-Path written.txt)',
    where: '"cwd=" + (Get-Location).Path + " user=" + [Environment]::UserName',
    leak: '"leak=" + $(if ($env:ACCESS_TOKEN) { $env:ACCESS_TOKEN } else { "none" })',
    home: says('home', 'Get-Content -LiteralPath "$env:USERPROFILE\\rach3-probe-read.txt" -ErrorAction Stop'),
    homewrite: says('homewrite', 'Set-Content -LiteralPath "$env:USERPROFILE\\rach3-probe-written.txt" -Value x -ErrorAction Stop'),
    outside: says('outside', 'Set-Content -LiteralPath "..\\outside.txt" -Value x -ErrorAction Stop'),
    signin: says('signin', 'Get-Content -LiteralPath "..\\session.json" -ErrorAction Stop'),
    net: says('net', '(New-Object Net.Sockets.TcpClient).Connect("example.com", 443)'),
  } : {
    read: 'head -1 piano.html',
    list: 'ls | head -3',
    write: 'echo x > written.txt && echo write=True',
    where: 'echo cwd=$(pwd) user=$(id -un)',
    leak: 'echo leak=${ACCESS_TOKEN:-none}',
    home: says('home', 'cat ~/.zshrc'),
    homewrite: says('homewrite', 'echo x > ~/rach3-probe-written.txt'),
    outside: says('outside', 'echo x > ../outside.txt'),
    signin: says('signin', 'cat ../session.json'),
    net: says('net', 'curl -s -m 8 -o /dev/null https://example.com'),
  };
  return `const lines = [];
const short = value => (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\\s+/g, ' ').slice(0, 400);
const step = async (name, run) => { try { lines.push('STEP ' + name + ' ran ' + short(await run())); } catch (error) { lines.push('STEP ' + name + ' refused ' + short(String(error && error.message || error)).slice(-260)); } };
await step('patch-add', () => tools.apply_patch('*** Begin Patch\\n*** Add File: customize-test.txt\\n+made by codex\\n*** End Patch\\n'));
await step('patch-update', () => tools.apply_patch('*** Begin Patch\\n*** Update File: customize-test.txt\\n@@\\n-made by codex\\n+made by codex.\\n*** End Patch\\n'));
const commands = ${JSON.stringify(commands)};
for (const [name, cmd] of Object.entries(commands)) await step(name, () => tools.exec_command({ cmd, yield_time_ms: 20000 }));
text(lines.join('\\n'));
`;
}

async function wholeChange() {
  const windows = process.platform === 'win32';
  const port = 18700 + Math.floor(Math.random() * 200), log = path.join(temp, 'mock.log'), script = path.join(temp, 'probe.js');
  const homeRead = path.join(os.homedir(), 'rach3-probe-read.txt'), homeWritten = path.join(os.homedir(), 'rach3-probe-written.txt');
  if (windows) fs.writeFileSync(homeRead, 'the person\'s file');
  fs.writeFileSync(script, probeScript());
  const server = spawn(windows ? 'python' : 'python3', [mock, String(port), log, script], { stdio: 'ignore' });
  process.env.RACH3_CODEX_UPSTREAM = `http://127.0.0.1:${port}/v1`;
  try {
    await wait(700);
    check('whole change: Codex is there', customize.available === true && (await customize.ask('state', {})).signedIn === true);
    const sent = await inPanel('try { return await window.rach3Core.postMessage({ action: "send", text: "Add a test file" }); } catch (error) { return "error " + error.message; }');
    check('whole change: sent', typeof sent?.thread === 'string', sent);
    const config = fs.readFileSync(path.join(support, 'Customize/codex/config.toml'), 'utf8');
    check('whole change: Codex\'s own permissions, no sandbox-exec', (config.includes('default_permissions = "rach3"') || !!process.env.RACH3_CODEX_TRIAL_PROFILE) && config.includes('[permissions.rach3.filesystem]') &&
      config.includes(`${JSON.stringify(path.join(support, 'Customize/workspace'))} = "write"`) && !config.includes('danger-full-access') && fs.existsSync(path.join(support, 'Customize/codex/models.json')));
    console.log(config.split('\n').map(line => `    | ${line}`).join('\n'));
    const state = await until(() => customize.ask('state', {}), value => !value.turn && value.designs.length > 0, 150);
    const design = state.designs?.[0];
    const finished = await inPanel('return window.events.find(event => event.event === "customize-finished") ?? null;');
    check('whole change: a new version on a new branch', !!design && state.active === design.id && state.branch === design.branch && state.branches.length === 1 && design.files.includes('customize-test.txt'),
      { design: design?.id, branch: state.branch, files: design?.files, errors: design?.errors, finished: finished && { status: finished.status, error: finished.error, outside: finished.outside, tokens: finished.tokens } });
    const asked = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    // Each step's line, as Codex reported it back.
    const reported = JSON.stringify(asked.at(-1)?.outputs ?? []).replace(/\\+r|\\+n/g, ' ');
    const steps = Object.fromEntries([...reported.matchAll(/STEP ([a-z-]+) (ran|refused) (.*?)(?=STEP [a-z-]+ (?:ran|refused) |$)/g)].map(match => [match[1], `${match[2]} ${match[3]}`.slice(0, 330)]));
    for (const [name, result] of Object.entries(steps)) console.log(`    | ${name}: ${result}`);
    const ran = (name, word) => (steps[name] ?? '').startsWith('ran') && (!word || steps[name].toLowerCase().includes(word.toLowerCase()));
    check('whole change: Codex can do the work (read, apply_patch, a command that writes)', ran('patch-add') && ran('patch-update') && ran('read', 'DOCTYPE') && ran('list') && ran('write', 'write=True'), steps);
    check('whole change: commands get no token', ran('leak', 'leak=none'), steps.leak);
    check('whole change: commands cannot read the person\'s files or the sign-in', ran('home', 'home=closed') && ran('signin', 'signin=closed'), [steps.home, steps.signin]);
    check('whole change: commands cannot write outside the scratch copy', ran('outside', 'outside=closed') && ran('homewrite', 'homewrite=closed') && !fs.existsSync(path.join(support, 'Customize/outside.txt')) && !fs.existsSync(homeWritten), [steps.outside, steps.homewrite]);
    check('whole change: commands do not reach the internet', ran('net', 'net=closed'), steps.net);
    if (design) {
      const folder = path.join(support, 'Customize/designs', design.id);
      check('whole change: the file Codex wrote is in the saved version', fs.readFileSync(path.join(folder, 'customize-test.txt'), 'utf8').trim() === 'made by codex.' && !fs.existsSync(path.join(folder, 'AGENTS.md')) &&
        !fs.existsSync(path.join(support, 'Customize/workspace')));
      check('whole change: the page moves to the branch', customize.pageURL === `rach3-app://${state.branch.toLowerCase()}/piano.html` && shown.at(-1) === false, customize.pageURL);
      const answer = await customize.serve(new Request(`${customize.pageURL.replace('piano.html', 'customize-test.txt')}`));
      check('whole change: served from the branch', answer.status === 200 && (await answer.text()).trim() === 'made by codex.');
    }
    try { console.log(fs.readFileSync(path.join(support, 'Customize/codex/stderr.log'), 'utf8').trim().split('\n').slice(-25).map(line => `    | codex: ${line}`).join('\n')); } catch { /* no log */ }
    check('whole change: the stand-in was asked with the sign-in', asked.length >= 2 && asked.every(request => request.auth === 'Bearer access-1'), { requests: asked.length, path: asked[0]?.path });
    const running = () => { try { return require('child_process').execFileSync('pgrep', ['-f', `app-server.*${path.basename(temp)}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const before = process.platform === 'win32' ? 1 : running();
    customize.coreRestarted();
    await wait(1500);
    await customize.native({ op: 'codex-write', line: '{}' });
    check('whole change: Codex stops with core.js', before === 1 && (process.platform === 'win32' || running() === 0), { before, after: process.platform === 'win32' ? null : running() });
  } finally { server.kill(); delete process.env.RACH3_CODEX_UPSTREAM; for (const file of [homeRead, homeWritten]) if (windows) fs.rmSync(file, { force: true }); }
}

const make = () => createCustomize({ source, scripts, codexRoot, support, version: '9.9.9', language: () => 'en', text: turkish => `en:${turkish}`,
  toCore, onShow: start => { shown.push(start); if (page && !page.isDestroyed()) page.loadURL(customize.pageURL).catch(() => {}); }, onPanel: (open, toggle) => panels.push([open, toggle]),
  onDeskEvent: event => deskEvents.push(event), onLessonChanged: lesson => lessons.push(lesson),
  previewBridge: async body => body.command === 'get-language' ? { language: 'en' } : body.command === 'lesson-list' ? customize.ask('lesson-list', { preview: true }).catch(() => []) :
    body.command === 'subscribe' ? { event: 'snapshot', language: 'en', status: { phase: 'disconnected', connected: false, devices: [] }, held: [], fullscreen: false } :
    body.command === 'lesson-tools' ? { groups: { notation: [], pdf: [], transcription: [], youtube: [], separation: [] }, tools: {} } :
    body.command === 'update-state' ? { event: 'update', version: '9.9.9', message: '', notes: [], availableVersion: null, availableNotes: '', newVersion: false } : {},
  importLesson: request => { imports.push(request); return { job: `job-${imports.length}` }; }, missingTools: () => 1234 });

// The rules for names Windows reads differently, tried wherever the test runs:
//   RACH3_TEST_AS_WINDOWS=1 npx electron electron/tests/customize.test.js
async function windowsNames(native) {
  const info = await native({ op: 'info' });
  check('as Windows: platform and Codex\'s name', info.platform === 'windows' && info.available === false);
  for (const name of ['NUL', 'nul.txt', 'COM1.js', 'a:b.js', 'a\\b.js', 'end.', 'end ', 'what?.js', 'a*.js', 'pipe|.js', 'tab\t.js'])
    check(`as Windows: "${name}" is refused`, await native({ op: 'write', area: 'data', path: `designs/${name}`, text: 'x' }) === false && await native({ op: 'exists', area: 'data', path: `designs/${name}` }) === null);
  check('as Windows: plain names still work', await native({ op: 'write', area: 'data', path: 'designs/d1/player.js', text: 'x' }) === true && await native({ op: 'write', area: 'data', path: 'designs/console.js', text: 'x' }) === true);
  const answer = await customize.serve(new Request('rach3-app://app/assets%5C..%5C..%5Cpiano.html'));
  check('as Windows: no backslash way out when serving', answer.status === 404);
}

app.whenReady().then(async () => {
  if (process.env.RACH3_TEST_AS_WINDOWS) {
    customize = make();
    await windowsNames(body => customize.native(body));
    console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
    app.exit(failures ? 1 : 0);
    return;
  }
  const timer = setTimeout(() => { console.log('FAIL the test did not finish in time'); app.exit(1); }, 420000);
  try {
    customize = make();
    ipcMain.handle('test-native', async (event, body) => { try { return { value: await customize.native(body) }; } catch (error) { return { error: error.message }; } });
    check('available without Codex', customize.available === (codexRoot === process.env.RACH3_TEST_CODEX));
    const native = body => customize.native(body);
    // Each part on its own: one that stops does not hide the others.
    const part = async (name, run) => { try { await run(); } catch (error) { failures++; console.log(`FAIL ${name} stopped:`, error.stack || error); } };
    await part('files', () => files(native));
    await part('serving', () => serving(native));
    await part('desk', () => desk(native));
    await part('previewing', () => previewing(native));
    await part('with core.js', withCore);
    await part('the real page', realPage);
    await part('signing in', () => signingIn(native));
    if (process.env.RACH3_TEST_CODEX && fs.existsSync(mock)) await part('whole change', wholeChange);
    else console.log('skip whole change (set RACH3_TEST_CODEX)');
    await part('signing out', () => signingOut(native));
    customize.stop();
    check('stop leaves no hidden window', BrowserWindow.getAllWindows().every(window => window === panel || window === page), BrowserWindow.getAllWindows().length);
  } catch (error) { failures++; console.log('FAIL the test stopped:', error.stack || error); }
  clearTimeout(timer);
  electron.shell.trashItem = realTrash;
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED', `(files kept in ${temp})`);
  app.exit(failures ? 1 : 0);
});
app.on('window-all-closed', () => {});
