// Runs first on rach3's page, on the Mac and on Windows: reports runtime errors on the
// page to the app, so the person and ChatGPT can see them.
(() => {
  const send = (kind, detail) => { try { window.webkit.messageHandlers.rach3.postMessage({ command: 'page-error', kind, ...detail }); } catch {} };
  window.addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) send('resource', { message: 'Could not load ' + (target.src || target.href) });
    else send('error', { message: event.message, source: event.filename || '', line: event.lineno || 0, column: event.colno || 0, stack: event.error?.stack || '' });
  }, true);
  window.addEventListener('unhandledrejection', event => send('rejection', { message: String(event.reason?.message || event.reason), stack: event.reason?.stack || '' }));
  const original = console.error;
  console.error = function(...parts) { send('console', { message: parts.map(part => part?.stack || String(part)).join(' ') }); return original.apply(this, parts); };
})();
