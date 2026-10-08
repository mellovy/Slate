const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('canvas', {
  cfg: () => ipcRenderer.invoke('cfg:get'),
  connect: (url, token) => ipcRenderer.invoke('cfg:set', url, token),
  clear: () => ipcRenderer.invoke('cfg:clear'),
  sync: () => ipcRenderer.invoke('canvas:sync'),
  open: (u) => ipcRenderer.invoke('open:url', u),
  pickFile: (folder, id) => ipcRenderer.invoke('file:pick', folder, id),
  getFile: (courseId, fileId) => ipcRenderer.invoke('canvas:file', courseId, fileId),
  getPage: (courseId, slug) => ipcRenderer.invoke('canvas:page', courseId, slug),
  openFile: (p) => ipcRenderer.invoke('file:open', p),
  removeFile: (p) => ipcRenderer.invoke('file:remove', p)
});
