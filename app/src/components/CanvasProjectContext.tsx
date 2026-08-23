import type { ReactNode } from 'react'
import { CanvasProjectContext } from './projectContext'

export function CanvasProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  return <CanvasProjectContext.Provider value={projectId}>{children}</CanvasProjectContext.Provider>
}
