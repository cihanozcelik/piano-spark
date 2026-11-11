// The Mac's uninstaller, started by the app as it quits (main.js launchUninstaller):
// waits for the app to end, then removes the app and everything it stored.
// Arguments: the app's process id, and the title of the message shown if something stays.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const parent = Number(process.argv[2]);
const running = () => { try { process.kill(parent, 0); return true; } catch { return false; } };

(async () => {
  while (parent > 1 && running()) await new Promise(done => setTimeout(done, 100));
  // …/rach3.app/Contents/Resources/app/electron/uninstall.js
  const bundle = path.resolve(__dirname, '../../../..');
  let identifier = '';
  try { identifier = execFileSync('/usr/bin/defaults', ['read', path.join(bundle, 'Contents/Info'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim(); } catch {}
  if (identifier !== 'com.rach3.app' || path.extname(bundle) !== '.app') process.exit(1);
  const library = path.join(os.homedir(), 'Library');
  const targets = [bundle, ...['Application Support/Rach3', 'Caches/com.rach3.app', 'WebKit/com.rach3.app',
    'Saved Application State/com.rach3.app.savedState', 'Preferences/com.rach3.app.plist'].map(name => path.join(library, name))];
  const failures = [];
  for (const target of targets) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (error) { failures.push(error.message); }
  }
  try { execFileSync('/usr/bin/defaults', ['delete', 'com.rach3.app'], { stdio: 'ignore' }); } catch {}
  if (!failures.length) process.exit(0);
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display alert (item 1 of argv) message (item 2 of argv)', '-e', 'end run',
      process.argv[3] || 'rach3', failures.join('\n')], { stdio: 'ignore' });
  } catch {}
  process.exit(1);
})();
