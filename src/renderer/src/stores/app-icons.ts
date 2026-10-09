// Custom app icons: the PNG files of <data folder>/icons, read by main. The built-in icon is the AppMark artwork.
import { create } from 'zustand'
import type { AppIconInfo } from '@shared/types'
import { api } from '@/lib/api'

interface AppIconsState {
  icons: AppIconInfo[]
  /** Read the icons folder (again: the user may have added files). Keeps the last list when it fails. */
  load: () => Promise<void>
}

export const useAppIcons = create<AppIconsState>((set) => ({
  icons: [],
  load: async () => {
    try {
      set({ icons: await api.app.icons() })
    } catch {
      // the built-in icon stays available
    }
  },
}))
