// Save status for the settings dialog ("Saving…" → "Saved") and debounced per-key updates.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { toast } from '@/components/ui'
import { useSettings } from '@/stores/settings'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const SAVED_VISIBLE_MS = 1800
export const NUMBER_DEBOUNCE_MS = 300
export const TEXT_DEBOUNCE_MS = 400

export interface SettingsSaver {
  status: SaveStatus
  /** Apply now. */
  save: (patch: Partial<AppSettings>) => void
  /** Apply after `delay` ms of quiet for this key (latest value wins); flushed on unmount. */
  saveLater: <K extends keyof AppSettings>(key: K, value: AppSettings[K], delay?: number) => void
  /** A debounced value of this key is still waiting to be saved. */
  isPending: (key: keyof AppSettings) => boolean
}

export function useSettingsSaver(): SettingsSaver {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const inflight = useRef(0)
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef(new Map<keyof AppSettings, { timer: ReturnType<typeof setTimeout>; patch: Partial<AppSettings> }>())

  const save = useCallback((patch: Partial<AppSettings>) => {
    inflight.current += 1
    if (fade.current) clearTimeout(fade.current)
    setStatus('saving')
    useSettings
      .getState()
      .update(patch)
      .then(() => {
        inflight.current -= 1
        if (inflight.current > 0) return
        setStatus('saved')
        fade.current = setTimeout(() => setStatus('idle'), SAVED_VISIBLE_MS)
      })
      .catch((error: unknown) => {
        inflight.current -= 1
        setStatus('error')
        toast.error('Could not save the setting', error)
      })
  }, [])

  const saveLater = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K], delay = NUMBER_DEBOUNCE_MS) => {
      const existing = pending.current.get(key)
      if (existing) clearTimeout(existing.timer)
      const patch = { [key]: value } as Partial<AppSettings>
      const timer = setTimeout(() => {
        pending.current.delete(key)
        save(patch)
      }, delay)
      pending.current.set(key, { timer, patch })
    },
    [save],
  )

  // Closing the dialog must not drop a change that is still waiting for its debounce.
  useEffect(() => {
    const map = pending.current
    return () => {
      if (fade.current) clearTimeout(fade.current)
      const patches = [...map.values()]
      map.clear()
      for (const { timer, patch } of patches) {
        clearTimeout(timer)
        void useSettings
          .getState()
          .update(patch)
          .catch((error: unknown) => toast.error('Could not save the setting', error))
      }
    }
  }, [])

  const isPending = useCallback((key: keyof AppSettings) => pending.current.has(key), [])

  return useMemo(() => ({ status, save, saveLater, isPending }), [status, save, saveLater, isPending])
}
