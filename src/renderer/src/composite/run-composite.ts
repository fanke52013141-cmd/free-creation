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
  checkCompositeRunBudget,
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

function findRunFailure(
  issues: ReadonlyArray<{ code: string; phase: string; nodeId?: string; portId?: string }>
): CompositeRunFailure {
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
  // W3 运行期守卫：递归、嵌套深度与展开预算与发布校验同口径拒绝。
  // 拒绝同样写入运行台账（failurePhase=runtime），保证可定位、可审计。
  const budget = checkCompositeRunBudget(manifest, request.parentContext)
  const headless = request.headless ?? request.parentContext?.headless ?? false
  const runContext = {
    chain: budget.chain,
    expandedNodes: budget.expandedNodes,
    ...(headless ? { headless: true } : {})
  }
  // 每次调用独立运行 ID；request.ownRunId 由 headless 外部入口预分配（供台账轮询）；
  // request.runId 是外层（父）运行，用于父子关联。AF-07 续跑复用既有 runId。
  const resuming = Boolean(request.resumeRunId)
  const runId = request.resumeRunId ?? request.ownRunId ?? crypto.randomUUID()
  const parentRunId = request.runId
  const completedSteps = new Set(request.completedSteps ?? [])
  const runtimeVersion = compositeRuntimeVersion(manifest)
  const runEditor = createRunEditor()
  let ledgerStarted = false
  let ledgerFinished = false
  let successfulSteps = 0
  let failure: CompositeRunFailure | undefined
  // 记录因缺少输入等被跳过的内部节点，输出缺失时给出可定位的原因。
  const skippedNotes: string[] = []
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
        ...options,
        // W4 失败定位：失败时把内存 failure 的结构化节点/端口落库，
        // 供 run.get/execute.wait 与桌面实例详情精确定位（一处覆盖所有失败点）。
        ...(status === 'failed' && failure?.nodeId ? { failureNodeId: failure.nodeId } : {}),
        ...(status === 'failed' && failure?.portId ? { failurePortId: failure.portId } : {})
      })
    )
  }
  const shapeByNode = new Map<string, TLShapeId>()
  try {
    const contentHash = await compositeContentHash(manifest)
    if (!resuming) {
      await report(() =>
        window.api.composite.runStart({
          id: runId,
          projectId,
          capabilityId: manifest.capabilityId,
          capabilityVersion: manifest.version,
          contentHash,
          ...(parentRunId ? { parentRunId } : {}),
          ...(request.instanceNodeId ? { instanceNodeId: request.instanceNodeId } : {}),
          // W4 受控重试：公开输入值/重试链随运行创建原子落盘（仅 headless 入口携带）。
          ...(request.inputValues ? { inputValues: request.inputValues } : {}),
          ...(request.retryOf ? { retryOf: request.retryOf } : {})
        })
      )
    }
    ledgerStarted = true
    if (budget.issue) {
      failure = { code: budget.issue.code, phase: 'runtime' }
      await finish('failed', {
        errorCode: failure.code,
        errorMessage: budget.issue.message,
        failurePhase: failure.phase
      })
      return {
        status: 'failed',
        reason: budget.issue.message,
        failure,
        stepCount: 0
      }
    }
    // W3：引用形态的内部组合节点必须先解析固定版本快照并缓存到 meta，
    // 否则 resolvePorts 推导不出公开端口，内部连线与输入绑定会失败。
    // 与主画布 graph.patch 的 meta.compositeManifest 缓存同口径。
    const nestedManifests = new Map<string, CompositeManifest>()
    for (const node of manifest.graph.nodes) {
      if (node.nodeType !== 'composite') continue
      let parsed: {
        manifest?: CompositeManifest
        ref?: { capabilityId?: string; version?: string; contentHash?: string }
        capabilityId?: string
        version?: string
        contentHash?: string
      }
      try {
        parsed = JSON.parse(node.config || '{}')
      } catch {
        parsed = {}
      }
      if (parsed.manifest) continue
      const ref =
        parsed.ref ??
        (parsed.capabilityId
          ? {
              capabilityId: parsed.capabilityId,
              version: parsed.version,
              contentHash: parsed.contentHash
            }
          : undefined)
      if (!ref?.capabilityId || !ref.version) continue
      const result = await window.api.composite.versionGet({
        capabilityId: ref.capabilityId,
        version: ref.version
      })
      if (
        !result.ok ||
        !result.data ||
        (ref.contentHash && result.data.contentHash !== ref.contentHash)
      ) {
        failure = { code: 'COMPOSITE_REF_NOT_RESOLVED', phase: 'input', nodeId: node.id }
        const reason = `内部组合节点固定版本引用无法解析：${ref.capabilityId}@${ref.version}`
        await finish('failed', {
          errorCode: failure.code,
          errorMessage: reason,
          failurePhase: failure.phase
        })
        return { status: 'failed', reason, failure, stepCount: 0 }
      }
      nestedManifests.set(node.id, result.data.manifest)
    }
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
        },
        ...(nestedManifests.has(node.id)
          ? { meta: { compositeManifest: nestedManifests.get(node.id) } }
          : {})
      } as never)
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
          errorMessage: planned.issues
            .map((issue) => issue.message)
            .join('；')
            .slice(0, 500),
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
        const targetShape = targetId ? runEditor.getShape<NodeCardShape>(targetId) : undefined
        if (!targetShape) {
          failure = {
            code: 'INPUT_TARGET_MISSING',
            phase: 'input',
            nodeId: binding.target.nodeId,
            portId: binding.target.portId
          }
          const reason = `输入「${binding.label}」的目标 ${binding.target.nodeId}.${binding.target.portId} 不存在`
          await finish('failed', {
            errorCode: failure.code,
            errorMessage: reason,
            failurePhase: 'input'
          })
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
          await finish('failed', {
            errorCode: failure.code,
            errorMessage: reason,
            failurePhase: 'input'
          })
          return { status: 'failed', reason, failure, stepCount: 0 }
        }
      }
    }

    for (const edge of manifest.graph.edges) {
      const from = shapeByNode.get(edge.from.nodeId)
      const to = shapeByNode.get(edge.to.nodeId)
      if (!from || !to) {
        failure = {
          code: 'INTERNAL_EDGE_MISSING',
          phase: 'step',
          nodeId: edge.from.nodeId,
          portId: edge.from.portId
        }
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
        failure = {
          code: 'INTERNAL_EDGE_INVALID',
          phase: 'step',
          nodeId: edge.from.nodeId,
          portId: edge.from.portId
        }
        const reason = `内部连线创建失败：${edge.from.nodeId}.${edge.from.portId} -> ${edge.to.nodeId}.${edge.to.portId}`
        await finish('failed', {
          errorCode: failure.code,
          errorMessage: reason,
          failurePhase: 'step'
        })
        return { status: 'failed', reason, failure, stepCount: successfulSteps }
      }
    }

    // AF-07：续跑回放已完成节点的运行结果到隔离 editor（供下游消费，不重跑）。
    if (resuming && request.stepOutputs) {
      for (const [nodeId, output] of Object.entries(request.stepOutputs)) {
        const shapeId = shapeByNode.get(nodeId)
        if (!shapeId) continue
        runEditor.updateShape({
          id: shapeId,
          type: 'node-card',
          meta: {
            nodeResult: output.nodeResult ?? undefined,
            nodeRun: output.nodeRun ? JSON.parse(JSON.stringify(output.nodeRun)) : undefined
          }
        })
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
      // AF-07：续跑跳过已完成步骤（保护已付费任务，不自动重做）。
      if (completedSteps.has(nodeId)) {
        successfulSteps++
        continue
      }
      // AF-07：内部纯人工任务节点——停等人工提交（不再 fail-closed）。
      // 已满足的提交值消费为正式输出；否则开放人工等待并停在 waiting-input，
      // 由外部 humanTask.submit 满足后经 composite.run.resume 续跑。
      if (nodeType === 'human-task') {
        const submission = request.humanSubmissions?.[nodeId]
        if (submission) {
          const instance = {
            schemaVersion: 1,
            nodeId,
            revision: 1,
            status: 'completed',
            result: submission,
            lastSubmissionId: `composite:${runId}:${nodeId}`,
            submittedAt: Date.now()
          }
          runEditor.updateShape({
            id: shapeId,
            type: 'node-card',
            meta: { humanTask: JSON.stringify(instance), humanTaskPending: '' }
          })
          await report(() =>
            window.api.composite.runStep({ runId, stepKey: nodeId, nodeType, status: 'completed' })
          )
          successfulSteps++
          continue
        }
        await report(() => window.api.composite.runWait({ runId, stepKey: nodeId, nodeType }))
        return {
          status: 'waiting',
          waitingStepKey: nodeId,
          reason: `节点流等待人工任务「${nodeId}」提交后续跑`,
          stepCount: successfulSteps
        }
      }
      await report(() =>
        window.api.composite.runStep({ runId, stepKey: nodeId, nodeType, status: 'running' })
      )
      const result = await runNodeManually(
        runEditor,
        projectId,
        providers,
        shapeId,
        undefined,
        undefined,
        runContext
      )
      await report(() =>
        window.api.composite.runStep({
          runId,
          stepKey: nodeId,
          nodeType,
          // W4：skipped 如实记账（此前误记 completed），跳过原因随步骤台账可查。
          status:
            result.status === 'failed'
              ? 'failed'
              : result.status === 'skipped'
                ? 'skipped'
                : 'completed',
          ...(result.reason ? { reason: result.reason } : {})
        })
      )
      // AF-07：持久化已完成节点的运行结果（供人工等待续跑回放，跳过重跑）。
      if (result.status !== 'failed' && result.status !== 'skipped') {
        const meta = runEditor.getShape<NodeCardShape>(shapeId)?.meta as
          Record<string, unknown> | undefined
        await report(() =>
          window.api.composite.runStepOutput({
            runId,
            nodeId,
            nodeResult: typeof meta?.nodeResult === 'string' ? meta.nodeResult : null,
            nodeRun: meta?.nodeRun ?? null
          })
        )
      }
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
      if (result.status === 'skipped') {
        skippedNotes.push(
          `内部节点「${nodeType || nodeId}」被跳过${result.reason ? `：${result.reason}` : '（缺少必要输入）'}`
        )
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
      await finish('failed', {
        errorCode: 'NO_OUTPUT',
        errorMessage: reason,
        failurePhase: 'output'
      })
      return { status: 'failed', reason, failure, stepCount: successfulSteps }
    }

    const read = (
      nodeId: string,
      portId: string
    ): import('@shared/engine/values').NodeValue | undefined => {
      const shapeId = shapeByNode.get(nodeId)
      const shape = shapeId ? runEditor.getShape<NodeCardShape>(shapeId) : undefined
      if (!shape) return undefined
      return projectNodeOutputs(shape)[portId]
    }
    const collected = collectCompositeOutputs(manifest, read)
    if (collected.issues.length > 0) {
      failure = findRunFailure(collected.issues)
      const outputReason = collected.issues.map((issue) => issue.message).join('；')
      const reason =
        skippedNotes.length > 0 ? `${skippedNotes.join('；')}。${outputReason}` : outputReason
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
        outputPorts: compositeOutputSummary(manifest, collected.outputs),
        ...(headless ? { outputValues: collected.outputs } : {})
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
    if (
      !createEdge(
        editor,
        { shapeId: sourceId, portId: 'out-text' },
        { shapeId: targetShape.id, portId: target.portId },
        false
      )
    )
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
