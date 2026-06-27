const { contextBridge, ipcRenderer } = require('electron')

const invoke = (command, args = {}) => ipcRenderer.invoke('sparkcode:invoke', command, args)

contextBridge.exposeInMainWorld('__TAURI__', {
  core: { invoke },
  invoke,
})

contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', {
  invoke,
})
