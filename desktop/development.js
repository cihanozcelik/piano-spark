// Only the developer HTTP server injects this file; it is not bundled in the app.
(() => {
  let revision, stopped = false;
  async function watch() {
    try {
      const response = await fetch('/api/development');
      if (!response.ok) throw new Error('Geliştirme servisi hazır değil');
      const next = JSON.stringify((await response.json()).revision);
      if (revision && revision !== next) {
        // The browser still owns the video while its chunks are being uploaded.
        if (document.documentElement.dataset.lessonPhase !== 'upload') {
          location.reload(); return;
        }
      } else revision = next;
    } catch { /* Reconnect when the developer restarts the local server. */ }
    if (!stopped) setTimeout(watch, 700);
  }
  window.addEventListener('pagehide', () => { stopped = true; });
  watch();
})();
