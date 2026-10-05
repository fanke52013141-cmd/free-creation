import { create } from 'zustand'

export interface ResourceTask {
  id: string
  key: string
  projectId: string
  label: string
  resource: string
  status: 'queued' | 'running'
  cancel: () => void
}

export const useResourceQueue = create<{ tasks: ResourceTask[]; limits: Record<string, number> }>(
  () => ({
    tasks: [],
    limits: { provider: 2, gpu: 1, media: 2, local: 4 }
  })
)

interface Entry {
  task: ResourceTask
  resolve: (release: (() => void) | null) => void
}
const entries: Entry[] = []

function publish(): void {
  useResourceQueue.setState({ tasks: entries.map(({ task }) => ({ ...task })) })
}

function drain(): void {
  const used = new Map<string, number>()
  for (const { task } of entries) {
    if (task.status === 'running') used.set(task.resource, (used.get(task.resource) ?? 0) + 1)
  }
  for (const entry of entries) {
    const { task } = entry
    const limits = useResourceQueue.getState().limits
    const limit = limits[task.resource] ?? limits[task.resource.split(':')[0]] ?? 1
    if (task.status !== 'queued' || (used.get(task.resource) ?? 0) >= limit) continue
    task.status = 'running'
    used.set(task.resource, (used.get(task.resource) ?? 0) + 1)
    let released = false
    entry.resolve(() => {
      if (released) return
      released = true
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
      drain()
    })
  }
  publish()
}

export function setResourceLimit(resource: string, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) return
  useResourceQueue.setState((state) => ({ limits: { ...state.limits, [resource]: limit } }))
  drain()
}

export function hasNodeTask(projectId: string, nodeId: string): boolean {
  return entries.some(({ task }) => task.key === `${projectId}/${nodeId}`)
}

/** Reservation is synchronous; queued tasks occupy their node but no resource slot. */
export function acquireNodeResource(input: {
  projectId: string
  nodeId: string
  label: string
  resource: string
  cancel: () => void
}): Promise<(() => void) | null> | null {
  const key = `${input.projectId}/${input.nodeId}`
  if (hasNodeTask(input.projectId, input.nodeId)) return null
  return new Promise((resolve) => {
    const task: ResourceTask = {
      id: crypto.randomUUID(),
      key,
      projectId: input.projectId,
      label: input.label,
      resource: input.resource,
      status: 'queued',
      cancel: () => {
        input.cancel()
        if (task.status !== 'queued') return
        const index = entries.findIndex((entry) => entry.task === task)
        if (index >= 0) entries.splice(index, 1)
        resolve(null)
        drain()
      }
    }
    entries.push({ task, resolve })
    drain()
  })
}
