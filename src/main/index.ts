// Application entry: profile location, single instance, main window, IPC, menu and lifecycle.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, powerMonitor, safeStorage, screen, session, shell } from 'electron'
import type { UnsavedWorkItem } from '@shared/types'
import { getDriver } from './db/drivers'
import { SessionManager } from './db/session-manager'
import { openTunnel } from './db/tunnel'
import { createEmitter, isSafeExternalUrl, registerIpc } from './ipc'
import { installMenu } from './menu'
import { OperationRegistry } from './operations'
import { unsavedWorkSummary } from './quit-guard'
import { setupUserDataPath } from './paths'
import { createStores, type Stores } from './store'
import { fitBounds } from './store/window-state'
import { VaultEnvironmentResolver } from './vault/environment'
import { VaultService } from './vault/service'
import { appVersion } from './version'

// Must run before `ready` (and before the single-instance lock, which lives in userData).
const userDataPath = setupUserDataPath()

const BACKGROUND = { dark: '#0d0e11', light: '#eceef1' } as const
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])

let mainWindow: BrowserWindow | null = null
let stores: Stores | null = null
let sessions: SessionManager | null = null
let vault: VaultService | null = null
const operations = new OperationRegistry()
/** Last report of the renderer (pending table edits…), reset when the renderer goes away. */
let unsavedWork: UnsavedWorkItem[] = []
/** The user agreed to discard unsaved work (or there was none): closing / quitting may proceed. */
let discardConfirmed = false
/** Terminated from a terminal (SIGINT / SIGTERM): quit without asking. */
let forceQuit = false
/**
 * Driven by Playwright (e2e suite, screenshot scripts): never block quitting on a native "discard unsaved
 * work?" dialog — nobody is there to answer it and the window would stay open.
 */
const automated =
  process.env.DATAGRIPPE_AUTOMATION === '1' ||
  app.commandLine.hasSwitch('remote-debugging-port') ||
  [...process.execArgv, ...process.argv].some((arg) => arg.includes('playwright'))
/**
 * DATAGRIPPE_NO_KEYCHAIN=1 (packaged-app smoke tests): secrets stay in memory and the OS keychain is never touched —
 * an unsigned rebuild of the app would otherwise make macOS ask the user for access to "DataGrippe Safe Storage",
 * blocking startup until someone answers.
 */
const NO_KEYCHAIN = {
  isEncryptionAvailable: () => false,
  encryptString: (): Buffer => {
    throw new Error('The keychain is disabled (DATAGRIPPE_NO_KEYCHAIN).')
  },
  decryptString: (): string => {
    throw new Error('The keychain is disabled (DATAGRIPPE_NO_KEYCHAIN).')
  },
}
/** DevTools and the Developer menu only exist in development builds. */
const developerTools = !app.isPackaged
const RENDERER_CRASH_LIMIT = 3
const RENDERER_CRASH_WINDOW_MS = 60_000

const getWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
const emit = createEmitter(getWindow)

process.on('uncaughtException', (error) => console.error('[main] uncaught exception', error))
process.on('unhandledRejection', (reason) => console.error('[main] unhandled rejection', reason))
// Quit gracefully (stores flushed, sessions closed) when terminated from a terminal.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    forceQuit = true
    app.quit()
  })
}

function prefersDark(): boolean {
  const theme = stores?.settings.get().theme ?? 'dark'
  return theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
}

function rendererUrlAllowed(url: string, win: BrowserWindow): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl && url.startsWith(devUrl)) return true
  return url === win.webContents.getURL()
}

/**
 * The renderer that owned the console sessions is gone (reload, crash, window closed): close its sessions so
 * no transaction keeps holding locks server-side, and stop its exports / imports.
 */
function releaseRendererState(reason: string): void {
  unsavedWork = []
  operations.cancelAll()
  // A pending Vault browser sign-in can no longer be followed (or cancelled) from the UI.
  vault?.cancelLogin()
  void sessions?.closeAllSessions().catch((error: unknown) => console.error(`[main] closing sessions after ${reason} failed`, error))
}

/** Ask before discarding open transactions or pending edits. Resolves true when nothing is lost or the user agrees. */
async function confirmDiscard(win: BrowserWindow | null, action: 'quit' | 'close'): Promise<boolean> {
  if (forceQuit || discardConfirmed || automated) return true
  const summary = unsavedWorkSummary(sessions?.openTransactions().length ?? 0, unsavedWork)
  if (!summary) return true
  const options = {
    type: 'warning' as const,
    buttons: [action === 'quit' ? 'Quit' : 'Close window', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: action === 'quit' ? 'Quit and discard unsaved work?' : 'Close the window and discard unsaved work?',
    detail: summary,
  }
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return response === 0
}

/**
 * The user's Vault CLI token (VAULT_TOKEN / ~/.vault-token) would go to a Vault server that VAULT_ADDR does not
 * name (the app was started from Finder, without the shell environment): ask first. The answer is kept in main.
 */
async function confirmAmbientVaultToken(request: { address: string; namespace?: string; sources: ('env' | 'cli')[] }): Promise<boolean | 'always'> {
  if (automated) return false
  const where = request.namespace ? `${request.address} (namespace ${request.namespace})` : request.address
  const from = request.sources.map((s) => (s === 'env' ? 'VAULT_TOKEN' : '~/.vault-token (vault login)')).join(' and ')
  const options = {
    type: 'question' as const,
    buttons: ['Use my Vault token', 'Not now'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: `Sign in to ${where} with your Vault CLI token?`,
    detail: `DataGrippe found a Vault token in ${from} but no VAULT_ADDR to tell which server it belongs to. That token gives access to every secret you can read: only allow it if ${where} is your Vault server (export VAULT_ADDR in your shell profile to skip this question).`,
    checkboxLabel: "Don't ask again for this server",
    checkboxChecked: false,
  }
  const win = getWindow()
  const { response, checkboxChecked } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  if (response !== 0) return false
  return checkboxChecked ? 'always' : true
}

function createWindow(): BrowserWindow {
  const saved = stores?.windowState.get() ?? { maximized: false }
  const bounds = fitBounds(
    saved.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
  )
  const win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'DataGrippe',
    ...(process.platform !== 'darwin' && !app.isPackaged && existsSync(join(__dirname, '../../build/icon.png'))
      ? { icon: join(__dirname, '../../build/icon.png') }
      : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: prefersDark() ? BACKGROUND.dark : BACKGROUND.light,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: developerTools,
    },
  })
  if (saved.maximized) win.maximize()

  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (rendererUrlAllowed(url, win)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  const persistState = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    stores?.windowState.save({ bounds: win.getNormalBounds(), maximized: win.isMaximized() })
  }
  win.on('resize', persistState)
  win.on('move', persistState)
  win.on('maximize', persistState)
  win.on('unmaximize', persistState)
  let confirming = false
  win.on('close', (event) => {
    if (!forceQuit && !discardConfirmed) {
      // Open transactions or pending edits: ask first (the dialog is async, so close again once confirmed).
      event.preventDefault()
      if (confirming) return
      confirming = true
      void confirmDiscard(win, 'close')
        .then((ok) => {
          if (!ok || win.isDestroyed()) return
          discardConfirmed = true
          win.close()
        })
        .finally(() => {
          confirming = false
        })
      return
    }
    persistState()
    stores?.windowState.flush()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The renderer's last workspace save (sent while unloading) arrives after the close handler's flush.
    stores?.flush()
    // The renderer owned every console session; a new window starts fresh.
    unsavedWork = []
    operations.cancelAll()
    vault?.cancelLogin()
    void sessions?.shutdown()
    discardConfirmed = false
  })

  // A reload (or any cross-document navigation of the main frame) drops the renderer's console tabs:
  // their server sessions must not stay open, idle in transaction, with no UI left to end them.
  let loaded = false
  win.webContents.on('did-finish-load', () => {
    loaded = true
  })
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || !loaded) return
    releaseRendererState('a renderer reload')
  })
  const crashes: number[] = []
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
    releaseRendererState('a renderer crash')
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    crashes.push(now)
    while (crashes.length > 0 && now - crashes[0] > RENDERER_CRASH_WINDOW_MS) crashes.shift()
    if (crashes.length <= RENDERER_CRASH_LIMIT) {
      win.webContents.reload()
      return
    }
    void dialog
      .showMessageBox(win, {
        type: 'error',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: 'DataGrippe keeps crashing',
        detail: `The window stopped ${crashes.length} times in the last minute (${details.reason}). Console sessions were closed.`,
      })
      .then(({ response }) => {
        if (response === 0 && !win.isDestroyed()) win.webContents.reload()
        else app.quit()
      })
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function showMainWindow(): void {
  const win = getWindow()
  if (!win) {
    mainWindow = createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function start(): void {
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow()
  })

  app.whenReady().then(() => {
    showDevIcon()
    stores = createStores(userDataPath, process.env.DATAGRIPPE_NO_KEYCHAIN === '1' ? NO_KEYCHAIN : safeStorage)
    const activeStores = stores
    // Vault tokens and database passwords stay in this process; the renderer only sees login / lease events.
    // The vault CLI's VAULT_ADDR / VAULT_CACERT: from the login shell when started from Finder (never in tests).
    const vaultEnvironment = new VaultEnvironmentResolver({ automated })
    vaultEnvironment.start()
    vault = new VaultService({
      onLogin: (event) => emit('event:vaultLogin', event),
      onStatus: (status) => emit('event:vaultStatus', status),
      openExternal: async (url) => {
        if (!isSafeExternalUrl(url)) throw new Error('Only http(s) sign-in links can be opened.')
        await shell.openExternal(url)
      },
      confirmAmbientToken: confirmAmbientVaultToken,
      environment: () => vaultEnvironment.get(),
      tokenStore: activeStores.vaultTokens,
    })
    // Lease timers are paused while the machine sleeps: renew / re-issue what is overdue as soon as it wakes up.
    powerMonitor.on('resume', () => vault?.resync())
    sessions = new SessionManager({
      vault,
      connections: activeStores.connections,
      drivers: getDriver,
      history: activeStores.history,
      emit,
      // Host keys: ~/.ssh/known_hosts, then the keys the user trusted (ssh:trustHostKey).
      openTunnel: (config, secrets) => openTunnel(config, secrets, { hostKeys: { trusted: activeStores.hostKeys } }),
    })

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    // Without a check handler Electron reports every permission (camera, notifications…) as granted.
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

    registerIpc({
      stores: activeStores,
      sessions,
      getWindow,
      emit,
      operations,
      onSettingsChanged: () => getWindow()?.setBackgroundColor(prefersDark() ? BACKGROUND.dark : BACKGROUND.light),
      onUnsavedWork: (items) => {
        unsavedWork = items
      },
      vaultDefaults: () => vaultEnvironment.defaults(),
    })
    installMenu({
      platform: process.platform,
      appName: app.getName(),
      send: (command) => emit('event:menu', { command }),
      openUserData: () => void shell.openPath(userDataPath),
      developerTools,
    })
    app.setAboutPanelOptions({ applicationName: 'DataGrippe', applicationVersion: appVersion() })

    nativeTheme.on('updated', () => {
      emit('event:nativeTheme', { dark: nativeTheme.shouldUseDarkColors })
      getWindow()?.setBackgroundColor(prefersDark() ? BACKGROUND.dark : BACKGROUND.light)
    })

    mainWindow = createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  }).catch((error: unknown) => {
    console.error('[main] startup failed', error)
    app.exit(1)
  })

  // Same for a quit: write what arrived after before-quit's flush (debounced stores).
  app.on('will-quit', () => {
    try {
      stores?.flush()
    } catch (error) {
      console.error('[main] final flush failed', error)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let quitting = false
  let confirmingQuit = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    if (confirmingQuit) return
    confirmingQuit = true
    void (async () => {
      try {
        // Open transactions and pending edits would be lost: ask first (Cmd+Q, menu, dock).
        if (!(await confirmDiscard(getWindow(), 'quit'))) return
        discardConfirmed = true
        quitting = true
        try {
          stores?.flush()
          operations.cancelAll()
          // Disconnecting revokes the Vault leases (best effort, bounded by the shutdown timeout).
          await sessions?.shutdown(3000)
          await vault?.dispose()
          stores?.flush()
        } catch (error) {
          console.error('[main] shutdown failed', error)
        }
        app.quit()
      } finally {
        confirmingQuit = false
      }
    })()
  })
}

/**
 * Unpackaged runs (npm run dev, tests) would show Electron's own icon: use build/icon.png, the icon
 * electron-builder bundles into the packaged app.
 */
function showDevIcon(): void {
  if (app.isPackaged) return
  const icon = join(__dirname, '../../build/icon.png')
  if (!existsSync(icon)) return
  try {
    if (process.platform === 'darwin') app.dock?.setIcon(icon)
  } catch (error) {
    console.warn('[main] cannot set the dock icon', error)
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else start()
