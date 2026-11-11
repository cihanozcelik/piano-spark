// Test only: gives core.js its window.webkit.messageHandlers.native, as the panel will.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('webkit', { messageHandlers: { native: { postMessage: async message => {
  const answer = await ipcRenderer.invoke('test-native', message);
  if (answer.error != null) throw new Error(answer.error);
  return answer.value;
} } } });
