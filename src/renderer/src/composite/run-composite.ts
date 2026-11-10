import {
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultTools,
  Editor,
  type TLShapeId
} from 'tldraw'
import type { CompositeManifest } from '@shared/composite/manifest'
import type {
  CompositeRunOutcome,
  CompositeRunRequest
} from '@shared/engine/composite-run-contract'
import { parseMediaResultCollection } from '@shared/engine/values'
import { compositeContentHash } from '@shared/composite/manifest'
import type { ProviderSummary } from '@shared/types'
import { NodeCardUtil, type NodeCardShape } from '../canvas/NodeCardShape'
import { CarrierArrowUtil } from '../canvas/CarrierArrowUtil'
import { BackdropShapeUtil } from '../canvas/BackdropShape'
import { createEdge } from '../canvas/graph'
import { runNodeManually } from '../engine/executor'

/**
 * P2 隔离执行：每次组合运行创建一个独立 tldraw store/editor，内部节点只写这份快照。
 * 不切换用户当前页、不共享 editor 状态；两个组合并发时各自 shape/meta/产物互不覆盖。
 * 注意：运行器仍依赖 renderer 注册表与 window.api，这是桌面宿主边界（计划 §3.3）。
 */
export function runCompositeIsolated(
  _hostEditor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  request: CompositeRunRequest
): Promise<CompositeRunOutcome> {
  return execute(projectId, providers, request)
}

async function execute(
  projectId: string,
  providers: ProviderSummary[],
  request: CompositeRunRequest
): Promise<CompositeRunOutcome> {
  const { manifest } = request
  if (request.signal?.cancelled) return { status: 'failed', reason: '组合运行已取消' }
  const runId = request.runId ?? crypto.randomUUID()
  const runEditor = createRunEditor()
  let ledgerStarted = false
  const report = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch {
      // 账本失败不能改变组合业务结果（日志/存储降级）。
    }
  }
  const shapeByNode = new Map<string, TLShapeId>()
  try {
    const contentHash = await compositeContentHash(manifest)
    await report(() =>
      window.api.composite.runStart({
        id: runId,
        projectId,
        capabilityId: manifest.capabilityId,
        capabilityVersion: manifest.version,
        contentHash
      })
    )
    ledgerStarted = true
    for (const node of manifest.graph.nodes) {
      const id = createShapeId()
      shapeByNode.set(node.id, id)
      const media = node.mediaRefs?.[0]
      runEditor.createShape({
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

    for (const input of manifest.inputs) {
      const packet = request.inputs.get(`in-${input.id}`)?.[0]
      const value = packet?.value
      if (!value || value.kind !== 'text') continue
      const target = input.targets[0]
      if (!target) continue
      const targetId = shapeByNode.get(target.nodeId)
      const targetShape = targetId
        ? runEditor.getShape<NodeCardShape>(targetId)
        : undefined
      if (!targetShape) continue
      if (targetShape.props.nodeType === 'text' && target.portId === 'in-text') {
        runEditor.updateShape({ id: targetShape.id, type: 'node-card', props: { text: value.text } })
        continue
      }
      const sourceId = createShapeId()
      runEditor.createShape({
        id: sourceId,
        type: 'node-card',
        x: targetShape.x - 380,
        y: targetShape.y,
        props: {
          nodeType: 'text',
          title: `${input.label}（组合输入）`,
          text: value.text,
          w: 340,
          h: 260
        }
      })
      createEdge(
        runEditor,
        { shapeId: sourceId, portId: 'out-text' },
        { shapeId: targetShape.id, portId: target.portId },
        false
      )
    }

    for (const edge of manifest.graph.edges) {
      const from = shapeByNode.get(edge.from.nodeId)
      const to = shapeByNode.get(edge.to.nodeId)
      if (!from || !to) return { status: 'failed', reason: '内部连线映射缺失' }
      if (
        !createEdge(
          runEditor,
          { shapeId: from, portId: edge.from.portId },
          { shapeId: to, portId: edge.to.portId },
          false
        )
      ) {
        return { status: 'failed', reason: `内部连线创建失败：${edge.from.nodeId}.${edge.from.portId}` }
      }
    }

    let successfulSteps = 0
    for (const nodeId of topologicalOrder(manifest)) {
      if (request.signal?.cancelled) return { status: 'failed', reason: '组合运行已取消', stepCount: successfulSteps }
      const shapeId = shapeByNode.get(nodeId)
      if (!shapeId) continue
      await report(() =>
        window.api.composite.runStep({ runId, stepKey: nodeId, nodeType: manifest.graph.nodes.find((node) => node.id === nodeId)?.nodeType ?? '', status: 'running' })
      )
      const result = await runNodeManually(runEditor, projectId, providers, shapeId)
      await report(() =>
        window.api.composite.runStep({ runId, stepKey: nodeId, nodeType: manifest.graph.nodes.find((node) => node.id === nodeId)?.nodeType ?? '', status: result.status === 'failed' ? 'failed' : 'completed', ...(result.reason ? { reason: result.reason } : {}) })
      )
      if (result.status === 'failed') {
        return { status: 'failed', reason: result.reason ?? `内部节点失败：${nodeId}`, stepCount: successfulSteps }
      }
      successfulSteps += 1
    }

    for (const output of manifest.outputs) {
      const shapeId = shapeByNode.get(output.source.nodeId)
      const shape = shapeId ? runEditor.getShape<NodeCardShape>(shapeId) : undefined
      const collection = parseMediaResultCollection(String(shape?.meta?.nodeResult ?? ''))
      const item =
        collection?.results.find((entry) => entry.mediaId === collection.selectedMediaId) ??
        collection?.results.at(-1)
      if (item) {
        await report(() => window.api.composite.runFinish({ runId, status: 'completed' }))
        return {
          status: 'done',
          media: { mediaId: item.mediaId, mediaPath: item.mediaPath, mime: item.mime },
          stepCount: successfulSteps
        }
      }
      if (shape?.props.mediaId && shape.props.mediaPath) {
        await report(() => window.api.composite.runFinish({ runId, status: 'completed' }))
        return {
          status: 'done',
          media: {
            mediaId: shape.props.mediaId,
            mediaPath: shape.props.mediaPath,
            mime: shape.props.mediaMime || 'image/png'
          },
          stepCount: successfulSteps
        }
      }
    }
    await report(() => window.api.composite.runFinish({ runId, status: 'failed', errorCode: 'NO_OUTPUT', errorMessage: '组合没有产生可投影的公开输出' }))
    return { status: 'failed', reason: '组合没有产生可投影的公开输出', stepCount: successfulSteps }
  } catch (error) {
    if (ledgerStarted) await report(() => window.api.composite.runFinish({ runId, status: 'failed', errorCode: 'COMPOSITE_EXCEPTION', errorMessage: error instanceof Error ? error.message : String(error) }))
    return {
      status: 'failed',
      reason: `组合隔离执行异常：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    if (!runEditor.isDisposed) runEditor.dispose()
  }
}

function createRunEditor(): Editor {
  const shapeUtils = [NodeCardUtil, CarrierArrowUtil, BackdropShapeUtil]
  const store = createTLStore({ shapeUtils, bindingUtils: defaultBindingUtils })
  return new Editor({
    store,
    shapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: defaultTools,
    getContainer: () => document.createElement('div')
  })
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
