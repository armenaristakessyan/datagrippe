import type { PreloadBridge } from '../shared/ipc'

declare global {
  interface Window {
    datagrippe: PreloadBridge
  }
}

export {}
