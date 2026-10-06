// Command registry: feeds the command palette, native menu events and keyboard hints.
// Global shortcuts are defined ONCE as accelerators in the native menu (src/main/menu.ts), which
// sends `event:menu` with the command id; do not also bind them with keydown listeners.
import { create } from 'zustand'
import type { ComponentType } from 'react'

export interface Command {
  id: string
  title: string
  /** Palette section, e.g. "Query", "Navigation", "View", "Connection". */
  group?: string
  /** Display-only shortcut hint, e.g. "⌘↵". */
  shortcut?: string
  keywords?: string[]
  icon?: ComponentType<{ className?: string; size?: number }>
  /** Order inside its palette group when nothing is typed (lower first; default after the ranked ones, A–Z). */
  priority?: number
  /** Hidden from the palette (and not runnable) when it returns false. */
  when?: () => boolean
  run: () => void | Promise<void>
}

interface CommandsState {
  commands: Record<string, Command>
}

export const useCommandRegistry = create<CommandsState>(() => ({ commands: {} }))

/** Register commands; returns an unregister function. Re-registering an id replaces it. */
export function registerCommands(commands: Command[]): () => void {
  const current = { ...useCommandRegistry.getState().commands }
  for (const c of commands) current[c.id] = c
  useCommandRegistry.setState({ commands: current })
  return () => {
    const next = { ...useCommandRegistry.getState().commands }
    for (const c of commands) if (next[c.id] === c) delete next[c.id]
    useCommandRegistry.setState({ commands: next })
  }
}

export function runCommand(id: string): void {
  const command = useCommandRegistry.getState().commands[id]
  if (!command || (command.when && !command.when())) return
  void Promise.resolve(command.run()).catch((error) => console.error(`Command ${id} failed`, error))
}

export function useCommands(): Command[] {
  const commands = useCommandRegistry((s) => s.commands)
  return Object.values(commands).filter((c) => !c.when || c.when())
}
