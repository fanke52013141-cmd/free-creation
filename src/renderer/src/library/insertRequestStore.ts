import { create } from 'zustand'

interface InsertRequest {
  projectId: string
  resourceId: string
  revisionId: string
  componentIds: string[]
}
export const useResourceInsertRequest = create<{
  request: InsertRequest | null
  set: (request: InsertRequest | null) => void
}>((set) => ({
  request: null,
  set: (request) => set({ request })
}))
