import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_EVENT_NAMES, type PreloadBridge } from '@shared/ipc'

const bridge: PreloadBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, listener) => {
    if (!IPC_EVENT_NAMES.includes(event)) throw new Error(`Unknown event ${event}`)
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('datagrippe', bridge)
