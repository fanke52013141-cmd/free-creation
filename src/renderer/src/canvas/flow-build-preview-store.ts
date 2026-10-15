import type { BuildPreview } from '@shared/agent-flow/builder'

type Listener = () => void

const previews = new Map<string, BuildPreview>()
const listeners = new Set<Listener>()
let revision = 0

function key(projectId: string, nodeId: string): string {
  return `${projectId}\u0000${nodeId}`
}

function publish(): void {
  revision++
  for (const listener of listeners) listener()
}

export function setFlowBuildPreview(
  projectId: string,
  nodeId: string,
  preview: BuildPreview | null
): void {
  const id = key(projectId, nodeId)
  const current = previews.get(id)
  if (
    preview &&
    current?.buildId === preview.buildId &&
    current.state === preview.state &&
    current.semanticRevision === preview.semanticRevision
  )
    return
  if (preview) previews.set(id, preview)
  else if (!previews.delete(id)) return
  publish()
}

export function subscribeFlowBuildPreviews(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFlowBuildPreviewRevision(): number {
  return revision
}

export function getFlowBuildPreviews(projectId: string): BuildPreview[] {
  return [...previews.values()].filter(
    (preview) => preview.projectId === projectId && preview.state === 'preview'
  )
}
