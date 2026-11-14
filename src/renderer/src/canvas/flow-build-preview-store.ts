import type { BuildPreview } from '@shared/agent-flow/builder'
import type { FlowGraphPreview } from '@shared/agent-flow/flow-graph-compiler'

type Listener = () => void

/**
 * 幽灵预览层消费的最小结构（builder 预览与外部 FlowGraph 预览同构，均不含 plan 依赖）。
 * 复用同一预览 store / 渲染层，不另建第二套幽灵预览。
 */
export type FlowBuildPreviewLike = Pick<
  BuildPreview,
  'buildId' | 'projectId' | 'nodeId' | 'semanticRevision' | 'state'
> & {
  nodes: ReadonlyArray<{
    id: string
    type: string
    title: string
    text: string
    config: string
    contractVersion: number
    x: number
    y: number
  }>
  edges: ReadonlyArray<{ from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string } }>
}

const previews = new Map<string, FlowBuildPreviewLike>()
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
  preview: FlowBuildPreviewLike | null
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

export function getFlowBuildPreviews(projectId: string): FlowBuildPreviewLike[] {
  return [...previews.values()].filter(
    (preview) => preview.projectId === projectId && preview.state === 'preview'
  )
}

/** P5：把外部 FlowGraph 预览喂入同一幽灵预览 store（锚点=coordinator id）。 */
export function setFlowGraphPreview(projectId: string, preview: FlowGraphPreview): void {
  setFlowBuildPreview(projectId, preview.nodeId, preview)
}
export function clearFlowGraphPreview(projectId: string, nodeId: string): void {
  setFlowBuildPreview(projectId, nodeId, null)
}