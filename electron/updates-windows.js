'use strict';
// Windows updates through Velopack and the project's GitHub releases, as before. Like
// Sparkle on the Mac, an update is trusted only when its feed carries a valid Ed25519
// signature from the release key in release.json; Velopack then checks each package's
// SHA-256 against that signed feed. Every file Velopack may download, the full package and
// each patch, must be listed in the signed feed. Updates download in the background and
// install when rach3 quits.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Velopack's install, update and uninstall hooks run here and exit. Uninstalling removes
// lessons, tools and settings, like the Mac app's uninstaller. Must run first in the app.
function runHooks(log) {
  const { VelopackApp } = require('velopack');
  let hooks = VelopackApp.build();
  if (log) hooks = hooks.setLogger((level, message) => { try { fs.appendFileSync(log, `[${level}] ${message}\r\n`); } catch {} });
  hooks
    .onBeforeUninstallFastCallback(() => {
      try { fs.rmSync(path.join(process.env.LOCALAPPDATA, 'Rach3'), { recursive: true, force: true }); } catch {}
    })
    .run();
}

// The packages listed in a feed, only when the feed carries a valid signature from the key.
function signedAssets(publicKey, feed, signature) {
  // A raw Ed25519 public key, as release.json holds it, wrapped the way Node reads keys.
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, feed, key, Buffer.from(String(signature).trim(), 'base64'))) throw new Error('The update feed signature is invalid');
  const assets = JSON.parse(feed.toString('utf8').replace(/^﻿/, ''))?.Assets;
  return Array.isArray(assets) ? assets.filter(asset => asset && typeof asset === 'object') : [];
}

// Every file Velopack may download must be in the signed feed with the same size and SHA-256.
function requireSigned(signed, info) {
  for (const asset of [info.TargetFullRelease, ...(info.DeltasToTarget || [])]) {
    const listed = asset.SHA256 && signed.some(entry => entry.FileName === asset.FileName && Number(entry.Size) === Number(asset.Size) &&
      String(entry.SHA256).toLowerCase() === String(asset.SHA256).toLowerCase());
    if (!listed) throw new Error(`The update file ${asset.FileName} is not in the signed feed`);
  }
}

function createWindowsUpdates({ release, state }) {
  const publicKey = Buffer.from(release.publicKey, 'base64');
  let manager = null, pending = null, checking = false, timer = null;

  async function signedFeed(target) {
    const folder = `https://github.com/${release.repository}/releases/download/v${target.Version}/`;
    const get = async name => {
      const response = await fetch(folder + name, { headers: { 'user-agent': 'rach3/' + release.version } });
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };
    return signedAssets(publicKey, await get('releases.win.json'), (await get('releases.win.json.sig')).toString('utf8'));
  }

  async function check() {
    if (!manager || checking || pending) { state.set({}); return; }
    checking = true;
    state.set({ status: 'Yeni sürüm aranıyor…' });
    let status;
    try {
      const info = await manager.checkForUpdatesAsync();
      if (!info) { status = 'En güncel sürüm yüklü.'; return; }
      const target = info.TargetFullRelease;
      requireSigned(await signedFeed(target), info);
      state.set({ status: 'Yeni sürüm arka planda indiriliyor…', availableVersion: String(target.Version), availableNotes: target.NotesMarkdown || '' });
      await manager.downloadUpdateAsync(info);
      pending = info;
      status = 'Güncelleme indirildi. rach3 yeniden başlatılınca yüklenecek.';
    } catch (error) {
      console.error('Update failed:', error);
      status = 'Güncelleme tamamlanamadı. İnternet bağlantısını kontrol et; mevcut sürümle devam edebilirsin.';
    } finally { checking = false; state.set({ status }); }
  }

  return {
    start() {
      if (manager || timer) return;
      try {
        const { UpdateManager, GithubSource } = require('velopack');
        manager = new UpdateManager(new GithubSource('https://github.com/' + release.repository, null, false));
        manager.getCurrentVersion();      // throws in a copy Velopack did not install
      } catch (error) { console.error('Updates unavailable:', error.message); manager = null; }
      if (!manager) return;
      // Soon after start, then every six hours.
      timer = setTimeout(function again() { check(); timer = setTimeout(again, 6 * 60 * 60 * 1000); }, 15 * 1000);
    },
    check,
    stop() { clearTimeout(timer); timer = null; },
    // rach3 is quitting: the downloaded update installs once this process has ended.
    install() {
      if (!manager || !pending) return;
      try { manager.waitExitThenApplyUpdate(pending.TargetFullRelease, true, false); } catch (error) { console.error('Update install failed:', error); }
    },
  };
}

module.exports = { createWindowsUpdates, runHooks, signedAssets, requireSigned };
