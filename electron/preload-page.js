// The page talks to the app exactly as it always has: window.webkit.messageHandlers.rach3.
// The same file serves Mac and Windows.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('webkit', { messageHandlers: { rach3: {
  postMessage: async message => {
    const answer = await ipcRenderer.invoke('rach3', message);
    if (answer.error != null) throw new Error(answer.error);
    return answer.value;
  },
} } });

// The scripts every page of rach3 starts with, before its own (main.js pageScripts).
for (const script of ipcRenderer.sendSync('rach3-page-setup', location.href)) webFrame.executeJavaScript(script);
