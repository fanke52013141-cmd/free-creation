import { create } from 'zustand'
import type { ProjectMeta } from '@shared/types'

type View = 'home' | 'canvas'

interface AppState {
  view: View
  currentProject: ProjectMeta | null
  setHome: () => void
  openProject: (project: ProjectMeta) => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'home',
  currentProject: null,
  setHome: () => set({ view: 'home', currentProject: null }),
  openProject: (project) => set({ view: 'canvas', currentProject: project })
}))
