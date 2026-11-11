// The hidden Bluetooth window's only door to the app: one message channel each way.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rach3BluetoothHost', {
  send: message => ipcRenderer.send('rach3-bluetooth', message),
  receive: callback => { ipcRenderer.on('rach3-bluetooth', (event, message) => callback(message)); },
});
