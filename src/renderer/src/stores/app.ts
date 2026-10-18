import { create } from 'zustand'
import type { ProjectMeta } from '@shared/types'

type View = 'home' | 'canvas'

export interface ProjectOpenFailure {
  projectName: string
  failedAt: number
}

interface AppState {
  view: View
  currentProject: ProjectMeta | null
  projectOpenFailure: ProjectOpenFailure | null
  setHome: () => void
  openProject: (project: ProjectMeta) => void
  setProjectOpenFailure: (failure: ProjectOpenFailure) => void
  clearProjectOpenFailure: () => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'home',
  currentProject: null,
  projectOpenFailure: null,
  setHome: () => set({ view: 'home', currentProject: null }),
  openProject: (project) =>
    set({ view: 'canvas', currentProject: project, projectOpenFailure: null }),
  setProjectOpenFailure: (failure) => set({ projectOpenFailure: failure }),
  clearProjectOpenFailure: () => set({ projectOpenFailure: null })
}))
