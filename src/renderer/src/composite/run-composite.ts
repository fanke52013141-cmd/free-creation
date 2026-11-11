import {
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultTools,
  Editor,
  type TLShapeId
} from 'tldraw'
import type { CompositeManifest } from '@shared/composite/manifest'
import { compositeRuntimeVersion } from '@shared/composite/manifest'
import type {
  CompositeRunFailure,
  CompositeRunOutcome,
  CompositeRunRequest
} from '@shared/engine/composite-run-contract'
import { parseMediaResultCollection } from '@shared/engine/values'
import { compositeContentHash } from '@shared/composite/manifest'
import {
  collectCompositeOutputs,
  compositeOutputSummary,
  planCompositeInputBindings
} from '@shared/composite/runtime'
import type { ProviderSummary } from '@shared/types'
import { NodeCardUtil, type NodeCardShape } from '../canvas/NodeCardShape'
import { CarrierArrowUtil } from '../canvas/CarrierArrowUtil'
import { BackdropShapeUtil } from '../canvas/BackdropShape'
import { createEdge } from '../canvas/graph'
import { runNodeManually } from '../engine/executor'
import { projectNodeOutputs } from '../nodes/nodeValues'

/**
 * 节点流隔离执行：每次调用创建一个独立 tldraw store/editor，内部节点只写这份快照。
 * 不切换用户当前页、不共享 editor 状态；两个节点流并发时各自 shape/meta/产物互不覆盖。
 *
 * 运行语义按 manifest.runtimeVersion 分支：
 * - 2（W1 起）：输入包作为虚拟上游接入契约声明的内部端口，文本由普通文本节点合并；
 *   公开输出按本次运行的显式映射收集，缺失必需输出返回可定位失败。
 * - 1（历史版本）：保留旧的文本替换与“首个媒体结果”行为，旧发布版本与实例不变。
 */
export function runCompositeIsolated(
  _hostEditor: Editor,
  projectId: string,
  providers: ProviderSummary[],
  request: CompositeRunRequest
): Promise<CompositeRunOutcome> {
  return execute(projectId, providers, request)
}

function findRunFailure(issues: ReadonlyArray<{ code: string; phase: string; nodeId?: string; portId?: string }>): CompositeRunFailure {
  const first = issues[0]
  return {
    code: first?.code ?? 'COMPOSITE_RUN_FAILED',
    phase: (first?.phase as CompositeRunFailure['phase']) ?? 'runtime',
    ...(first?.nodeId ? { nodeId: first.nodeId } : {}),
    ...(first?.portId ? { portId: first.portId } : {})
  }
}

async function execute(
  projectId: string,
  providers: ProviderSummary[],
  request: CompositeRunRequest
): Promise<CompositeRunOutcome> {
  const { manifest } = request
  if (request.signal?.cancelled) return { status: 'failed', reason: '节点流运行已取消' }
  // 每次调用独立运行 ID；request.runId 是外层（父）运行，用于父子关联。
  const runId = crypto.randomUUID()
  const parentRunId = request.runId
  const runtimeVersion = compositeRuntimeVersion(manifest)
  const runEditor = createRunEditor()
  let ledgerStarted = false
  let ledgerFinished = false
  let successfulSteps = 0
  let failure: CompositeRunFailure | undefined
  const report = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch {
      // 账本失败不能改变节点流业务结果（日志/存储降级）。
    }
  }
  const finish = async (
    status: 'completed' | 'failed' | 'cancelled',
    options: { errorCode?: string; errorMessage?: string; failurePhase?: string } = {}
  ): Promise<void> => {
    if (!ledgerStarted || ledgerFinished) return
    ledgerFinished = true
    await report(() =>
      window.api.composite.runFinish({
        runId,
        status,
        ...options
      })
    )
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
        contentHash,
        ...(parentRunId ? { parentRunId } : {}),
        ...(request.instanceNodeId ? { instanceNodeId: request.instanceNodeId } : {})
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

    if (runtimeVersion === 1) {
      const legacy = applyLegacyInputs(runEditor, manifest, request, shapeByNode)
      if (legacy) {
        failure = { code: 'INPUT_VALUE_INVALID', phase: 'input' }
        await finish('failed', {
          errorCode: failure.code,
          errorMessage: legacy,
          failurePhase: failure.phase
        })
        return { status: 'failed', reason: legacy, failure, stepCount: 0 }
      }
    } else {
      const planned = planCompositeInputBindings(manifest, request.inputs)
      if (planned.issues.length > 0) {
        failure = findRunFailure(planned.issues)
        await finish('failed', {
          errorCode: failure.code,
          errorMessage: planned.issues.map((issue) => issue.message).join('；').slice(0, 500),
          failurePhase: failure.phase
        })
        return {
          status: 'failed',
          reason: planned.issues[0]!.message,
          failure,
          stepCount: 0
        }
      }
      for (const binding of planned.bindings) {
        const targetId = shapeByNode.get(binding.target.nodeId)
        const targetShape = targetId
          ? runEditor.getShape<NodeCardShape>(targetId)
          : undefined
        if (!targetShape) {
          failure = {
            code: 'INPUT_TARGET_MISSING',
            phase: 'input',
            nodeId: binding.target.nodeId,
            portId: binding.target.portId
          }
          const reason = `输入「${binding.label}」的目标 ${binding.target.nodeId}.${binding.target.portId} 不存在`
          await finish('failed', { errorCode: failure.code, errorMessage: reason, failurePhase: 'input' })
          return { status: 'failed', reason, failure, stepCount: 0 }
        }
        const sourceId = createVirtualSource(runEditor, binding, targetShape, shapeByNode.size)
        if (
          !sourceId ||
          !createEdge(
            runEditor,
            { shapeId: sourceId, portId: binding.sourcePortId },
            { shapeId: targetShape.id, portId: binding.target.portId },
            false,
            binding.order
          )
        ) {
          failure = {
            code: 'INPUT_TARGET_MISSING',
            phase: 'input',
            nodeId: binding.target.nodeId,
            portId: binding.target.portId
          }
          const reason = `输入「${binding.label}」无法接入 ${binding.target.nodeId}.${binding.target.portId}（端口类型或映射不兼容）`
          await finish('failed', { errorCode: failure.code, errorMessage: reason, failurePhase: 'input' })
          return { status: 'failed', reason, failure, stepCount: 0 }
        }
      }
    }

    for (const edge of manifest.graph.edges) {
      const from = shapeByNode.get(edge.from.nodeId)
      const to = shapeByNode.get(edge.to.nodeId)
      if (!from || !to) {
        failure = { code: 'INTERNAL_EDGE_MISSING', phase: 'step', nodeId: edge.from.nodeId, portId: edge.from.portId }
        await finish('failed', { errorCode: failure.code, failurePhase: 'step' })
        return { status: 'failed', reason: '内部连线映射缺失', failure, stepCount: successfulSteps }
      }
      if (
        !createEdge(
          runEditor,
          { shapeId: from, portId: edge.from.portId },
          { shapeId: to, portId: edge.to.portId },
          false
        )
      ) {
        failure = { code: 'INTERNAL_EDGE_INVALID', phase: 'step', nodeId: edge.from.nodeId, portId: edge.from.portId }
        const reason = `内部连线创建失败：${edge.from.nodeId}.${edge.from.portId} -> ${edge.to.nodeId}.${edge.to.portId}`
        await finish('failed', { errorCode: failure.code, errorMessage: reason, failurePhase: 'step' })
        return { status: 'failed', reason, failure, stepCount: successfulSteps }
      }
    }

    for (const nodeId of topologicalOrder(manifest)) {
      if (request.signal?.cancelled) {
        await finish('cancelled')
        return { status: 'failed', reason: '节点流运行已取消', stepCount: successfulSteps }
      }
      const shapeId = shapeByNode.get(nodeId)
      if (!shapeId) continue
      const nodeType = manifest.graph.nodes.find((node) => node.id === nodeId)?.nodeType ?? ''
      await report(() =>
        window.api.composite.runStep({ runId, stepKey: nodeId, nodeType, status: 'running' })
      )
      const result = await runNodeManually(runEditor, projectId, providers, shapeId)
      await report(() =>
        window.api.composite.runStep({
          runId,
          stepKey: nodeId,
          nodeType,
          status: result.status === 'failed' ? 'failed' : 'completed',
          ...(result.reason ? { reason: result.reason } : {})
        })
      )
      if (result.status === 'failed') {
        failure = { code: 'NODE_FAILED', phase: 'step', nodeId }
        await finish('failed', {
          errorCode: failure.code,
          errorMessage: result.reason ?? `内部节点失败：${nodeId}`,
          failurePhase: 'step'
        })
        return {
          status: 'failed',
          reason: result.reason ?? `内部节点失败：${nodeId}`,
          failure,
          stepCount: successfulSteps
        }
      }
      successfulSteps += 1
    }

    if (runtimeVersion === 1) {
      const legacyOutput = collectLegacyMediaOutput(manifest, runEditor, shapeByNode)
      if (legacyOutput) {
        await finish('completed')
        return {
          status: 'done',
          media: legacyOutput,
          stepCount: successfulSteps
        }
      }
      failure = { code: 'REQUIRED_OUTPUT_MISSING', phase: 'output' }
      const reason = '节点流没有产生可投影的公开输出'
      await finish('failed', { errorCode: 'NO_OUTPUT', errorMessage: reason, failurePhase: 'output' })
      return { status: 'failed', reason, failure, stepCount: successfulSteps }
    }

    const read = (nodeId: string, portId: string): import('@shared/engine/values').NodeValue | undefined => {
      const shapeId = shapeByNode.get(nodeId)
      const shape = shapeId ? runEditor.getShape<NodeCardShape>(shapeId) : undefined
      if (!shape) return undefined
      return projectNodeOutputs(shape)[portId]
    }
    const collected = collectCompositeOutputs(manifest, read)
    if (collected.issues.length > 0) {
      failure = findRunFailure(collected.issues)
      const reason = collected.issues.map((issue) => issue.message).join('；')
      await finish('failed', {
        errorCode: failure.code,
        errorMessage: reason,
        failurePhase: failure.phase
      })
      return { status: 'failed', reason, failure, stepCount: successfulSteps }
    }
    await report(() =>
      window.api.composite.runFinish({
        runId,
        status: 'completed',
        outputPorts: compositeOutputSummary(manifest, collected.outputs)
      })
    )
    ledgerFinished = true
    return {
      status: 'done',
      ...(collected.media ? { media: collected.media } : {}),
      outputs: collected.outputs,
      stepCount: successfulSteps
    }
  } catch (error) {
    failure = { code: 'COMPOSITE_EXCEPTION', phase: 'runtime' }
    const reason = `节点流隔离执行异常：${error instanceof Error ? error.message : String(error)}`
    await finish('failed', {
      errorCode: failure.code,
      errorMessage: reason,
      failurePhase: 'runtime'
    })
    return { status: 'failed', reason, failure, stepCount: successfulSteps }
  } finally {
    if (!runEditor.isDisposed) runEditor.dispose()
  }
}

/** 历史语义：文本输入直接替换目标文本节点正文；非文本不接入（旧执行器实际行为）。 */
function applyLegacyInputs(
  editor: Editor,
  manifest: CompositeManifest,
  request: CompositeRunRequest,
  shapeByNode: Map<string, TLShapeId>
): string | null {
  for (const input of manifest.inputs) {
    const packet = request.inputs.get(`in-${input.id}`)?.[0]
    const value = packet?.value
    if (!value || value.kind !== 'text') continue
    const target = input.targets[0]
    if (!target) continue
    const targetId = shapeByNode.get(target.nodeId)
    const targetShape = targetId ? editor.getShape<NodeCardShape>(targetId) : undefined
    if (!targetShape) return `输入「${input.label}」的目标 ${target.nodeId}.${target.portId} 不存在`
    if (targetShape.props.nodeType === 'text' && target.portId === 'in-text') {
      editor.updateShape({ id: targetShape.id, type: 'node-card', props: { text: value.text } })
      continue
    }
    // 历史执行器对非文本节点会创建一个临时文本上游再连线；保留这一行为。
    const sourceId = createShapeId()
    editor.createShape({
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
    if (!createEdge(editor, { shapeId: sourceId, portId: 'out-text' }, { shapeId: targetShape.id, portId: target.portId }, false))
      return `输入「${input.label}」无法接入 ${target.nodeId}.${target.portId}`
  }
  return null
}

function collectLegacyMediaOutput(
  manifest: CompositeManifest,
  editor: Editor,
  shapeByNode: Map<string, TLShapeId>
): { mediaId: string; mediaPath: string; mime: string } | null {
  for (const output of manifest.outputs) {
    const shapeId = shapeByNode.get(output.source.nodeId)
    const shape = shapeId ? editor.getShape<NodeCardShape>(shapeId) : undefined
    const collection = parseMediaResultCollection(String(shape?.meta?.nodeResult ?? ''))
    const item =
      collection?.results.find((entry) => entry.mediaId === collection.selectedMediaId) ??
      collection?.results.at(-1)
    if (item) {
      return { mediaId: item.mediaId, mediaPath: item.mediaPath, mime: item.mime }
    }
    if (shape?.props.mediaId && shape.props.mediaPath) {
      return {
        mediaId: shape.props.mediaId,
        mediaPath: shape.props.mediaPath,
        mime: shape.props.mediaMime || 'image/png'
      }
    }
  }
  return null
}

function createVirtualSource(
  editor: Editor,
  binding: import('@shared/composite/runtime').CompositeInputBinding,
  target: NodeCardShape,
  index: number
): TLShapeId | null {
  const id = createShapeId()
  const media = binding.value
  editor.createShape({
    id,
    type: 'node-card',
    x: target.x - 380,
    y: target.y + index * 40,
    props: {
      nodeType: binding.sourceNodeType,
      title: `${binding.label}（节点流输入）`,
      w: 340,
      h: 260,
      ...(media.kind === 'text' || media.kind === 'markdown' ? { text: media.text } : {}),
      ...(media.kind === 'json' ? { text: JSON.stringify(media.data, null, 2) } : {}),
      ...(media.kind === 'image' ||
      media.kind === 'video' ||
      media.kind === 'audio' ||
      media.kind === 'file'
        ? {
            mediaId: media.mediaId,
            mediaPath: media.mediaPath,
            mediaMime: media.mime
          }
        : {})
    }
  })
  return id
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
