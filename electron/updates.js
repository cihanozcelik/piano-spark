'use strict';
// Updates, as the page's update panel sees them. The update systems themselves are the
// ones rach3 always had, so an installed copy keeps updating from the same signed feeds:
//   Mac      Sparkle, driven by desktop/UpdateController.m unchanged (native/updates.node)
//   Windows  Velopack and the signed GitHub release feed (updates-windows.js)
// A copy run from the repository has neither and only shows its version and notes.
const path = require('path');

function createUpdates({ release, settings, installed, resources, onChange, language, text }) {
  const notes = () => release.localizedNotes?.[language()] ?? release.notes ?? [];

  // ---- Mac: UpdateController owns everything, including what is new since the last launch.
  if (installed && process.platform === 'darwin') {
    const native = require(path.join(resources, 'updates.node'));
    const read = json => { try { return JSON.parse(json); } catch { return null; } };
    native.create(json => { const event = read(json); if (event) onChange(event); });
    return {
      snapshot: () => read(native.snapshot()),
      start: () => native.start(), check: () => native.check(), acknowledge: () => native.acknowledge(),
      stop: () => native.stop(), leaving() {},
    };
  }

  // ---- Windows and development: the state Updates.cs kept.
  let status = 'Güncellemeler otomatik denetlenir.', availableVersion = '', availableNotes = '';
  const seen = settings.get('AnnouncedVersion');
  let newVersion = typeof seen === 'string' && seen !== release.version;
  if (seen == null) settings.set('AnnouncedVersion', release.version);
  const snapshot = () => ({ event: 'update', version: release.version, notes: notes(), newVersion, message: text(status), availableVersion, availableNotes });
  const changed = () => onChange(snapshot());
  const state = {
    set(next) { if (next.status != null) status = next.status; if (next.availableVersion != null) availableVersion = next.availableVersion;
      if (next.availableNotes != null) availableNotes = next.availableNotes; changed(); },
  };
  const system = installed && process.platform === 'win32' ? require('./updates-windows').createWindowsUpdates({ release, state }) : null;
  return {
    snapshot,
    start() { system?.start(); },
    check() { if (system) system.check(); else changed(); },
    acknowledge() { newVersion = false; settings.set('AnnouncedVersion', release.version); changed(); },
    stop() { system?.stop(); },
    // The app is about to end: a downloaded update installs now.
    leaving() { system?.install(); },
  };
}

module.exports = { createUpdates };
