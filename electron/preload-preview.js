// The hidden preview of a changed copy, which ChatGPT looks at to check its work. The
// page there talks to the app the way the real page does,
// window.webkit.messageHandlers.rach3, but only reading commands are answered
// (electron/customize.js). The same file serves Mac and Windows.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const channel = name => ({
  postMessage: async message => {
    const answer = await ipcRenderer.invoke(name, message);
    if (answer.error != null) throw new Error(answer.error);
    return answer.value;
  },
});

// On the Mac the page's header leaves room for the window buttons, as on the real page.
if (process.platform === 'darwin') {
  const mark = () => { if (document.documentElement) { document.documentElement.dataset.windowControls = 'mac'; return true; } return false; };
  if (!mark()) new MutationObserver((records, observer) => { if (mark()) observer.disconnect(); }).observe(document, { childList: true });
}

contextBridge.exposeInMainWorld('webkit', { messageHandlers: { rach3: channel('rach3-preview') } });

// desktop/customize/page-errors.js runs in the page's own world before the page's
// scripts, so every runtime error there is reported.
if (window === window.top) {
  const script = ipcRenderer.sendSync('rach3-preview-script');
  if (script) webFrame.executeJavaScript(script);
}
