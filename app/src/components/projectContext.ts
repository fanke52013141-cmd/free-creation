import { createContext, useContext } from 'react'

export const CanvasProjectContext = createContext<string | null>(null)

export function useCanvasProjectId(): string {
  const projectId = useContext(CanvasProjectContext)
  if (!projectId) throw new Error('CanvasProjectProvider is required for asset and task nodes.')
  return projectId
}
