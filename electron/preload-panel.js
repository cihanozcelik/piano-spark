// core.js, the shared part of the ChatGPT features, asks the app for what only the
// computer can do through window.webkit.messageHandlers.native.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webkit', { messageHandlers: { native: {
  postMessage: async message => {
    const answer = await ipcRenderer.invoke('rach3-native', message);
    if (answer.error != null) throw new Error(answer.error);
    return answer.value;
  },
} } });
