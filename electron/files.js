// Where rach3's files are, in the installed app and in the repository.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The interface as the page sees it: one flat folder. The app serves it as the original
// design, and a version changed with ChatGPT starts as a copy of it.
const SOURCE = {
  'piano.html': 'piano.html', 'i18n.js': 'i18n.js', 'i18n-messages.js': 'i18n-messages.js', 'desktop.js': 'desktop.js',
  'player.js': 'player.js', 'workspace-state.js': 'workspace-state.js', 'sheet-music.js': 'sheet-music.js',
  'piano-input.js': 'piano-input.js', 'piano-output.js': 'piano-output.js', 'practice-clock.js': 'practice-clock.js',
  'practice-session.js': 'practice-session.js', 'hand-reach.js': 'hand-reach.js', 'staff-notation.js': 'staff-notation.js',
  'create-lesson.js': 'create-lesson.js', 'lesson-chat.js': 'lesson-chat.js', 'app-shell.js': 'app-shell.js',
  'bluetooth.js': 'bluetooth-connection/bluetooth.js', 'bluetooth-diagnostics.js': 'bluetooth-connection/bluetooth-diagnostics.js',
  'assets/bravura/Bravura.woff2': 'assets/bravura/Bravura.woff2',
  'assets/brand/rach3-wordmark-on-dark.png': 'assets/brand/rach3-wordmark-on-dark.png',
  'assets/notation/verovio-toolkit-wasm.js': 'assets/notation/verovio-toolkit-wasm.js',
  'AGENTS.md': 'desktop/customize/AGENTS.md',
};
const CUSTOMIZE = ['core.js', 'panel.js', 'page-errors.js'];

// Copies the page's files into `folder` as the flat layout above.
function writeSource(folder) {
  fs.rmSync(folder, { recursive: true, force: true });
  for (const [target, origin] of Object.entries(SOURCE)) {
    fs.mkdirSync(path.dirname(path.join(folder, target)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, origin), path.join(folder, target));
  }
}

// The folders the app reads. Installed, they sit in the app's resources; run from the
// repository, the page's files are laid out in build/electron first.
function locate({ packaged, resources }) {
  if (packaged) return {
    source: path.join(resources, 'Source'), scripts: path.join(resources, 'Customize'), engine: path.join(resources, 'Engine'),
    codex: path.join(resources, 'Codex'), release: path.join(resources, 'release.json'), platformText: path.join(resources, 'platform-text.json'),
  };
  const source = path.join(ROOT, 'build/electron/Source');
  writeSource(source);
  return {
    source, scripts: path.join(ROOT, 'desktop/customize'), engine: path.join(ROOT, 'build/electron/Engine'),
    codex: path.join(ROOT, 'build/electron/Codex'), release: path.join(ROOT, 'desktop/release.json'),
    platformText: path.join(ROOT, 'build/electron/platform-text.json'),
  };
}

module.exports = { ROOT, SOURCE, CUSTOMIZE, writeSource, locate };
