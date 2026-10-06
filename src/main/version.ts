// App version. `app.getVersion()` falls back to Electron's version when the app is started from a
// build directory without a package.json beside it, so the bundler injects the real one.
import { app } from 'electron'

declare const __APP_VERSION__: string | undefined

export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : app.getVersion()
}
