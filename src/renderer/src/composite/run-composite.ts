import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { CompositeManifest } from '@shared/composite/manifest'
import type {
  CompositeRunOutcome,
  CompositeRunRequest
} from '@shared/engine/composite-run-contract'
import { parseMediaResultCollection } from '@shared/engine/values'
import { runNodeManually } from '../engine/executor'
import { createEdge } from '../canvas/graph'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import type { ProviderSummary } from '@shared/types'

/**
 * P2 隔离执行原型：临时页内重建固定版本内部图并复用现有节点执行器。
 *
 * 约束：不修改用户当前页；同一时刻只允许一个组合运行（页面切换是全局 editor 状态）。
 * 这是 P2 最小闭环，P3 会把它换成不切页的 NodeRunHost + 持久运行账本。
 */
let queue: Promise<unknown> = Promise.resolve()

export function runCompositeOnTempPage(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  request: CompositeRunRequest
): Promise<CompositeRunOutcome> {
  const next = queue.then(() => execute(editor, projectId, providers, request))
  queue = next.catch(() => undefined)
  return next
}

async function execute(
  editor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  request: CompositeRunRequest
): Promise<CompositeRunOutcome> {
  const { manifest } = request
  const previousPage = editor.getCurrentPageId()
  const pageName = `__composite__${request.runId ?? Date.now()}`
  editor.createPage({ name: pageName })
  const page = editor.getPages().find((item) => item.name === pageName)
  if (!page) return { status: 'failed', reason: '无法创建组合运行页' }
  const shapeByNode = new Map<string, TLShapeId>()
  let successfulSteps = 0
  try {
    editor.setCurrentPage(page)
    for (const node of manifest.graph.nodes) {
      const id = createShapeId()
      shapeByNode.set(node.id, id)
      const media = node.mediaRefs?.[0]
      editor.createShape({
        id,
        type: 'node-card',
        x: node.dx,
        y: node.dy,
        props: {
          nodeType: node.nodeType as NodeCardShape['props']['nodeType'],
          title: node.title,
          w: node.w,
          h: node.h,
          text: node.text ?? '',
          config: node.config ?? '',
          mediaId: media?.mediaId ?? '',
          mediaPath: media?.mediaPath ?? '',
          mediaMime: media?.mime ?? ''
        }
      })
    }

    // 公开输入写入内部图：文本目标节点直接写正文；其他文本端口建一个文本源并连线。
    for (const input of manifest.inputs) {
      const packet = request.inputs.get(`in-${input.id}`)?.[0]
      const value = packet?.value
      if (!value || value.kind !== 'text') continue
      const target = input.targets[0]
      if (!target) continue
      const targetShape = editor.getShape<NodeCardShape>(shapeByNode.get(target.nodeId)!)
      if (!targetShape) continue
      if (targetShape.props.nodeType === 'text' && target.portId === 'in-text') {
        editor.updateShape({ id: targetShape.id, type: 'node-card', props: { text: value.text } })
        continue
      }
      const sourceId = createShapeId()
      editor.createShape({
        id: sourceId,
        type: 'node-card',
        x: (targetShape.x ?? 0) - 380,
        y: targetShape.y ?? 0,
        props: { nodeType: 'text', title: `${input.label}（组合输入）`, text: value.text, w: 340, h: 260 }
      })
      createEdge(editor, { shapeId: sourceId, portId: 'out-text' }, { shapeId: targetShape.id, portId: target.portId }, false)
    }

    for (const edge of manifest.graph.edges) {
      const from = shapeByNode.get(edge.from.nodeId)
      const to = shapeByNode.get(edge.to.nodeId)
      if (!from || !to) return { status: 'failed', reason: '内部连线映射缺失' }
      if (!createEdge(editor, { shapeId: from, portId: edge.from.portId }, { shapeId: to, portId: edge.to.portId }, false)) {
        return { status: 'failed', reason: `内部连线创建失败：${edge.from.nodeId}.${edge.from.portId}` }
      }
    }

    for (const nodeId of topologicalOrder(manifest)) {
      const shapeId = shapeByNode.get(nodeId)
      if (!shapeId) continue
      const result = await runNodeManually(editor, projectId, providers, shapeId)
      if (result.status === 'failed') {
        return { status: 'failed', reason: result.reason ?? `内部节点失败：${nodeId}` }
      }
      successfulSteps += 1
    }

    for (const output of manifest.outputs) {
      const shape = editor.getShape<NodeCardShape>(shapeByNode.get(output.source.nodeId)!)
      const collection = parseMediaResultCollection(String(shape?.meta?.nodeResult ?? ''))
      const item =
        collection?.results.find((entry) => entry.mediaId === collection.selectedMediaId) ??
        collection?.results.at(-1)
      if (item) {
        return {
          status: 'done',
          media: { mediaId: item.mediaId, mediaPath: item.mediaPath, mime: item.mime },
          stepCount: successfulSteps
        }
      }
      const directMediaId = shape?.props.mediaId
      const directPath = shape?.props.mediaPath
      if (directMediaId && directPath) {
        return {
          status: 'done',
          media: { mediaId: directMediaId, mediaPath: directPath, mime: shape.props.mediaMime || 'image/png' },
          stepCount: successfulSteps
        }
      }
    }
    return { status: 'failed', reason: '组合没有产生可投影的公开输出', stepCount: successfulSteps }
  } finally {
    if (editor.getPage(previousPage)) editor.setCurrentPage(previousPage)
    if (editor.getPages().length > 1) editor.deletePage(page.id)
  }
}

function topologicalOrder(manifest: CompositeManifest): string[] {
  const indegree = new Map(manifest.graph.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const node of manifest.graph.nodes) outgoing.set(node.id, [])
  for (const edge of manifest.graph.edges) {
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId)
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of outgoing.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 1) - 1
      indegree.set(next, degree)
      if (degree === 0) queue.push(next)
    }
  }
  return order.length === manifest.graph.nodes.length ? order : []
}
