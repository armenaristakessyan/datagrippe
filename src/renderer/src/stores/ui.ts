// Global UI state + promise-based dialogs. <DialogHost/> (components/layout) renders `dialogs`.
import { create } from 'zustand'
import type { ConnectionConfig, Dialect } from '@shared/types'
import { uid } from '@/lib/id'

export interface ConfirmOptions {
  title: string
  message?: string
  /** Extra detail rendered in a monospace block (e.g. the SQL about to run). */
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export interface PromptOptions {
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
}

export type DialogRequest =
  | { id: string; type: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { id: string; type: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
  | {
      id: string
      type: 'password'
      connection: ConnectionConfig
      /**
       * Tries the typed password (e.g. connects with it). While it runs the prompt shows progress; when
       * it throws, the prompt stays open with the error so the user can correct the password.
       */
      submit?: (password: string) => Promise<void>
      resolve: (value: string | null) => void
    }

export type PaletteMode = 'commands' | 'objects'

export interface ConnectionDialogState {
  open: boolean
  /** Edit an existing connection; undefined = create. */
  editId?: string
  /** Pre-selected dialect when creating. */
  dialect?: Dialect
  /** Initial group when creating. */
  group?: string
}

interface UiState {
  /** Resolved theme actually applied to <html>. */
  resolvedTheme: 'dark' | 'light'
  sidebarVisible: boolean
  paletteOpen: boolean
  paletteMode: PaletteMode
  settingsOpen: boolean
  historyOpen: boolean
  /** "Import from DBeaver" dialog (components/import). */
  dbeaverImportOpen: boolean
  /** "Import from DataGrip" dialog: the same dialog, reading pasted DataGrip data sources. */
  datagripImportOpen: boolean
  connectionDialog: ConnectionDialogState
  dialogs: DialogRequest[]

  setResolvedTheme: (theme: 'dark' | 'light') => void
  toggleSidebar: () => void
  setSidebarVisible: (visible: boolean) => void
  openPalette: (mode?: PaletteMode) => void
  closePalette: () => void
  setSettingsOpen: (open: boolean) => void
  setHistoryOpen: (open: boolean) => void
  setDbeaverImportOpen: (open: boolean) => void
  setDatagripImportOpen: (open: boolean) => void
  openConnectionDialog: (opts?: { editId?: string; dialect?: Dialect; group?: string }) => void
  closeConnectionDialog: () => void

  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
  /** Resolves to the password once `submit` (when given) accepted it, or null when cancelled. */
  askPassword: (connection: ConnectionConfig, submit?: (password: string) => Promise<void>) => Promise<string | null>
  /** Called by <DialogHost/> when a dialog is answered. */
  dismissDialog: (id: string) => void
}

export const useUi = create<UiState>((set, get) => ({
  resolvedTheme: 'dark',
  sidebarVisible: true,
  paletteOpen: false,
  paletteMode: 'commands',
  settingsOpen: false,
  historyOpen: false,
  dbeaverImportOpen: false,
  datagripImportOpen: false,
  connectionDialog: { open: false },
  dialogs: [],

  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
  toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  openPalette: (mode = 'commands') => set({ paletteOpen: true, paletteMode: mode }),
  closePalette: () => set({ paletteOpen: false }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  setDbeaverImportOpen: (dbeaverImportOpen) => set({ dbeaverImportOpen }),
  setDatagripImportOpen: (datagripImportOpen) => set({ datagripImportOpen }),
  openConnectionDialog: (opts) => set({ connectionDialog: { open: true, ...opts } }),
  closeConnectionDialog: () => set({ connectionDialog: { open: false } }),

  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      const id = uid('dlg')
      set({ dialogs: [...get().dialogs, { id, type: 'confirm', options, resolve }] })
    }),
  prompt: (options) =>
    new Promise<string | null>((resolve) => {
      const id = uid('dlg')
      set({ dialogs: [...get().dialogs, { id, type: 'prompt', options, resolve }] })
    }),
  askPassword: (connection, submit) =>
    new Promise<string | null>((resolve) => {
      const id = uid('dlg')
      set({ dialogs: [...get().dialogs, { id, type: 'password', connection, submit, resolve }] })
    }),
  dismissDialog: (id) => set({ dialogs: get().dialogs.filter((d) => d.id !== id) }),
}))
