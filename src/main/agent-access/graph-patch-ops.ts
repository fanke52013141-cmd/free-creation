import {
  resolvePatchReferences,
  type CompositeResolutionMap,
  type GraphPatchOp
} from '../../shared/agent-access/graph-ops'
import { compositeContentHash } from '../../shared/composite/manifest'
import { getDb } from '../store/db'
import * as projects from '../store/projects.repo'
import { listMedia } from '../store/media.repo'
import { getCompositeVersion } from '../store/composite.repo'
import { AccessFailure, type AccessDiagnosticsContext } from './access-failure'
import { previewCompositeUpgrade } from './composite-ops'
import type { AccessDesktop } from './desktop'
import {
  buildGraphPatchPreview,
  getGraphPatchPreview,
  precheckGraphPatchOps,
  saveGraphPatchPreview,
  updateGraphPatchPreviewState
} from './graph-patch-preview'
import { requestHumanDecision } from './human-decision'
import { assertProjectHasNoActiveTasks } from './project-delete-ops'

export interface GraphPatchOpsContext {
  activeProjectId: () => string | null
  desktop?: AccessDesktop
}

/**
 * W3 实例升级：与 GUI 同一份 previewCompositeUpgrade 预检；阻断则拒绝且原实例不变。
 * 目标必须是已发布快照（摘要核对），通过后复用 graph.patch 的同一权威应用路径，
 * 不另建画布编辑路径。
 */
export async function applyCompositeUpgradeOp(
  ctx: GraphPatchOpsContext,
  input: Record<string, unknown>,
  markCommitted: () => void
): Promise<unknown> {
  const projectId = String(input.projectId ?? '')
  const nodeId = String(input.nodeId ?? '')
  const preview = previewCompositeUpgrade(projectId, nodeId, input.nextManifest)
  if (!preview.ok) {
    const detail =
      (preview.impact?.breaking ?? [])
        .map((item) => item.portId)
        .slice(0, 8)
        .join(',') || 'invalid-next-manifest'
    throw new AccessFailure('UPGRADE_BLOCKED', 'precheck', detail)
  }
  const next = preview.nextManifest
  const record = getCompositeVersion(next.capabilityId, next.version)
  if (!record) throw new AccessFailure('NOT_FOUND', 'precheck', 'published-version')
  const hash = await compositeContentHash(next)
  if (hash !== record.contentHash)
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'next-manifest-not-published-snapshot')
  const patch = (await executeGraphPatchOp(
    ctx,
    projectId,
    ctx.activeProjectId(),
    {
      projectId,
      expectedGraphVersion: input.expectedGraphVersion,
      ops: [
        {
          action: 'node.update',
          nodeId,
          config: {
            capabilityId: next.capabilityId,
            version: next.version,
            contentHash: record.contentHash
          }
        }
      ]
    },
    markCommitted
  )) as { graphVersion: number }
  return {
    projectId,
    nodeId,
    previousVersion: preview.previousVersion,
    version: next.version,
    graphVersion: patch.graphVersion
  }
}

/** 方案 A：外部 Agent 全 34 节点画布变更提案（校验并持久化为幽灵预览，零画布写入）。 */
export function proposeGraphPatchOp(
  ctx: GraphPatchOpsContext,
  id: string,
  activeId: string | null | undefined,
  input: Record<string, unknown>
): unknown {
  if (id !== activeId || !ctx.desktop)
    throw new AccessFailure(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry graph.patch.propose'
    )
  const current = projects.openProject(id)
  if (!current) throw new AccessFailure('NOT_FOUND', 'read')
  const expectedGraphVersion = input.expectedGraphVersion as number
  if (current.meta.graphVersion !== expectedGraphVersion) {
    throw new AccessFailure('REVISION_CONFLICT', 'precheck', undefined, current.meta.graphVersion)
  }
  const patchOps = input.ops as GraphPatchOp[]
  const resolved = resolvePatchReferences(patchOps, {
    nodes: current.nodes,
    edges: current.edges
  })
  if (!resolved.ok)
    throw new AccessFailure(
      'PATCH_REFERENCE_INVALID',
      'precheck',
      resolved.errors
        .slice(0, 5)
        .map((e) => `op[${e.index}]:${e.code}`)
        .join(',')
    )
  const chatOpCount = patchOps.filter((op) => op.action === 'chat.patch').length
  if (chatOpCount > 0 && chatOpCount !== patchOps.length)
    throw new AccessFailure(
      'MIXED_PATCH_UNSUPPORTED',
      'precheck',
      'chat.patch must be submitted in its own batch'
    )
  for (const op of patchOps) {
    const mediaRef =
      op.action === 'node.create' || op.action === 'node.update' ? op.media : undefined
    if (mediaRef && !listMedia(id).some((candidate) => candidate.id === mediaRef.mediaId)) {
      throw new AccessFailure('MEDIA_NOT_FOUND', 'precheck', mediaRef.mediaId)
    }
    if (op.action === 'chat.patch') {
      const chatNode = current.nodes.find((candidate) => candidate.id === op.nodeId)
      if (!chatNode || chatNode.type !== 'chat')
        throw new AccessFailure('CHAT_NODE_REQUIRED', 'precheck', op.nodeId.slice(0, 60))
    }
    if (op.action === 'node.create' || op.action === 'node.update') {
      const cfg = op.config as Record<string, unknown> | undefined
      if (
        cfg &&
        !cfg.manifest &&
        typeof cfg.capabilityId === 'string' &&
        typeof cfg.version === 'string'
      ) {
        const isComposite =
          op.action === 'node.create'
            ? op.nodeType === 'composite'
            : current.nodes.find((node) => node.id === op.nodeId)?.type === 'composite'
        if (!isComposite)
          throw new AccessFailure('INVALID_INPUT', 'precheck', 'composite-ref-on-non-composite')
        const record = getCompositeVersion(cfg.capabilityId, cfg.version)
        if (!record) throw new AccessFailure('NOT_FOUND', 'precheck', 'published-version')
        if (typeof cfg.contentHash === 'string' && cfg.contentHash !== record.contentHash)
          throw new AccessFailure('INVALID_INPUT', 'precheck', 'composite-content-hash-mismatch')
      }
    }
  }
  const precheck = precheckGraphPatchOps({
    ops: patchOps,
    currentFile: current,
    resolveCompositeManifest: (capabilityId, version) =>
      getCompositeVersion(capabilityId, version)?.manifest
  })
  if (!precheck.ok) {
    throw new AccessFailure(precheck.issue.code, 'precheck', precheck.issue.detail)
  }
  const preview = buildGraphPatchPreview({
    projectId: id,
    name: typeof input.name === 'string' ? input.name : undefined,
    expectedGraphVersion,
    autoLayout: input.autoLayout === true,
    ops: patchOps,
    currentFile: current
  })
  saveGraphPatchPreview(getDb(), preview)
  return {
    projectId: id,
    previewId: preview.buildId,
    name: preview.name,
    state: 'preview' as const,
    expectedGraphVersion: preview.expectedGraphVersion,
    autoLayout: preview.autoLayout,
    summary: preview.summary,
    nodeCount: preview.nodes.length,
    edgeCount: preview.edges.length
  }
}

/** 方案 A：经 BL-01 桌面人工确认后，将已持久化的幽灵预览通过 executeGraphPatchOp 原子落盘。 */
export async function confirmGraphPatchOp(
  ctx: GraphPatchOpsContext,
  id: string,
  activeId: string | null | undefined,
  input: Record<string, unknown>,
  diagnostics: AccessDiagnosticsContext,
  markCommitted: () => void
): Promise<unknown> {
  const previewId = String(input.previewId ?? '')
  const preview = getGraphPatchPreview(getDb(), id, previewId)
  if (!preview) throw new AccessFailure('NOT_FOUND', 'read', 'preview-not-found')
  if (preview.state === 'discarded')
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'preview-discarded')
  if (preview.state === 'committed')
    throw new AccessFailure('INVALID_INPUT', 'precheck', 'preview-already-committed')

  // 在弹出桌面人工确认前先检查画布版本，避免用户点击允许后再遭遇版本冲突。
  const current = projects.openProject(id)
  if (!current) throw new AccessFailure('NOT_FOUND', 'read')
  if (current.meta.graphVersion !== preview.expectedGraphVersion) {
    throw new AccessFailure(
      'REVISION_CONFLICT',
      'precheck',
      `expected ${preview.expectedGraphVersion}, current ${current.meta.graphVersion}; re-propose with currentGraphVersion`,
      current.meta.graphVersion
    )
  }

  const decision = await requestHumanDecision({
    operation: 'graph.patch.confirm',
    desktop: ctx.desktop,
    projectId: id,
    activeProjectId: activeId ?? null,
    prompt: {
      title: '允许外部画布变更落盘？',
      message: `外部 Agent 请求将预览「${preview.name}」落到画布（+${preview.summary.nodeCreated} 节点 / +${preview.summary.edgeCreated} 连线 / 改 ${preview.summary.nodeUpdated} / 删 ${preview.summary.nodeDeleted}）。`,
      confirmText: '允许落画布'
    },
    diagnostics
  })
  if (!decision.ok) {
    throw new AccessFailure(decision.code, 'human-decision', decision.detail)
  }

  const applied = (await executeGraphPatchOp(
    ctx,
    id,
    activeId,
    {
      expectedGraphVersion: preview.expectedGraphVersion,
      ops: preview.ops,
      autoLayout: preview.autoLayout
    },
    markCommitted
  )) as Record<string, unknown>

  updateGraphPatchPreviewState(getDb(), id, previewId, 'committed')
  return {
    ...applied,
    previewId,
    state: 'committed' as const
  }
}

/** 方案 A：取消待确认的画布变更幽灵预览（已落盘则幂等返回 committed）。 */
export function discardGraphPatchOp(id: string, input: Record<string, unknown>): unknown {
  const previewId = String(input.previewId ?? '')
  const updated = updateGraphPatchPreviewState(getDb(), id, previewId, 'discarded')
  if (!updated) throw new AccessFailure('NOT_FOUND', 'read', 'preview-not-found')
  return {
    projectId: id,
    previewId,
    state: updated.state
  }
}

/** F2 画布编辑的权威应用：dispatch 与 composite.upgrade.apply 共用同一条准入/应用/核对路径。 */
export async function executeGraphPatchOp(
  ctx: GraphPatchOpsContext,
  id: string,
  activeId: string | null | undefined,
  input: Record<string, unknown>,
  markCommitted: () => void
): Promise<unknown> {
  if (id !== activeId || !ctx.desktop)
    throw new AccessFailure(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry graph.patch'
    )
  const current = projects.openProject(id)
  if (!current) throw new AccessFailure('NOT_FOUND', 'read')
  const resolved = resolvePatchReferences(input.ops as GraphPatchOp[], {
    nodes: current.nodes,
    edges: current.edges
  })
  if (!resolved.ok)
    throw new AccessFailure(
      'PATCH_REFERENCE_INVALID',
      'precheck',
      resolved.errors
        .slice(0, 5)
        .map((e) => `op[${e.index}]:${e.code}`)
        .join(',')
    )
  const mediaResolutions: Record<
    string,
    { mediaId: string; mediaPath: string; mediaMime: string; name?: string }
  > = {}
  const chatMediaResolutions: typeof mediaResolutions = {}
  for (const op of input.ops as GraphPatchOp[]) {
    const mediaRef =
      op.action === 'node.create' || op.action === 'node.update' ? op.media : undefined
    if (!mediaRef || mediaResolutions[mediaRef.mediaId]) continue
    const asset = listMedia(id).find((candidate) => candidate.id === mediaRef.mediaId)
    if (!asset) throw new AccessFailure('MEDIA_NOT_FOUND', 'precheck', mediaRef.mediaId)
    mediaResolutions[mediaRef.mediaId] = {
      mediaId: asset.id,
      mediaPath: asset.path,
      mediaMime: asset.mime,
      ...(asset.name ? { name: asset.name.slice(0, 200) } : {})
    }
  }
  const patchOps = input.ops as GraphPatchOp[]
  const chatOpCount = patchOps.filter((op) => op.action === 'chat.patch').length
  if (chatOpCount > 0 && chatOpCount !== patchOps.length)
    throw new AccessFailure(
      'MIXED_PATCH_UNSUPPORTED',
      'precheck',
      'chat.patch must be submitted in its own graph.patch batch'
    )
  for (const op of patchOps) {
    if (op.action !== 'chat.patch') continue
    const chatNode = current.nodes.find((candidate) => candidate.id === op.nodeId)
    if (!chatNode || chatNode.type !== 'chat')
      throw new AccessFailure('CHAT_NODE_REQUIRED', 'precheck', op.nodeId.slice(0, 60))
    for (const chatOp of op.ops) {
      if (chatOp.action !== 'chat.message.append' || !chatOp.message.images) continue
      for (const image of chatOp.message.images) {
        const asset = listMedia(id).find((candidate) => candidate.id === image.mediaId)
        if (!asset) throw new AccessFailure('MEDIA_NOT_FOUND', 'precheck', image.mediaId)
        chatMediaResolutions[image.mediaId] = {
          mediaId: asset.id,
          mediaPath: asset.path,
          mediaMime: asset.mime,
          ...(asset.name ? { name: asset.name.slice(0, 200) } : {})
        }
      }
    }
  }
  const compositeResolutions: CompositeResolutionMap = {}
  for (const [opIndex, op] of patchOps.entries()) {
    if (op.action !== 'node.create' && op.action !== 'node.update') continue
    const cfg = op.config as Record<string, unknown> | undefined
    if (
      !cfg ||
      cfg.manifest ||
      typeof cfg.capabilityId !== 'string' ||
      typeof cfg.version !== 'string'
    )
      continue
    const isComposite =
      op.action === 'node.create'
        ? op.nodeType === 'composite'
        : current.nodes.find((node) => node.id === op.nodeId)?.type === 'composite'
    if (!isComposite)
      throw new AccessFailure('INVALID_INPUT', 'precheck', 'composite-ref-on-non-composite')
    const record = getCompositeVersion(cfg.capabilityId, cfg.version)
    if (!record) throw new AccessFailure('NOT_FOUND', 'precheck', 'published-version')
    if (typeof cfg.contentHash === 'string' && cfg.contentHash !== record.contentHash)
      throw new AccessFailure('INVALID_INPUT', 'precheck', 'composite-content-hash-mismatch')
    const key =
      op.action === 'node.create'
        ? op.ref
          ? `ref:${op.ref}`
          : `index:${opIndex}`
        : `node:${op.nodeId}`
    compositeResolutions[key] = { manifest: record.manifest, contentHash: record.contentHash }
  }
  const patchResult = await ctx.desktop.run(
    {
      action: 'graph-patch',
      projectId: id,
      ops: input.ops as GraphPatchOp[],
      expectedGraphVersion: input.expectedGraphVersion as number,
      ...(input.autoLayout ? { autoLayout: true } : {}),
      ...(Object.keys(mediaResolutions).length ? { mediaResolutions } : {}),
      ...(Object.keys(chatMediaResolutions).length ? { mediaResolutions: chatMediaResolutions } : {}),
      ...(Object.keys(compositeResolutions).length ? { compositeResolutions } : {})
    },
    (version) => {
      if (ctx.activeProjectId() !== id)
        throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
      assertProjectHasNoActiveTasks(id)
      const admitted = projects.openProject(id)
      if (!admitted || admitted.meta.graphVersion !== version)
        throw new AccessFailure('REVISION_CONFLICT', 'patch-admission')
      markCommitted()
      return admitted.meta
    }
  )
  const savedFile = projects.openProject(id)
  if (!savedFile || savedFile.meta.graphVersion !== patchResult.graphVersion)
    throw new AccessFailure('REVISION_CONFLICT', 'patch-verify')
  const payload = (patchResult.result ?? {}) as {
    created?: Array<{ ref?: string; nodeId?: string }>
    groups?: Array<{ ref?: string; groupId?: string }>
    counts?: Partial<
      Record<
        'nodeCreated' | 'nodeUpdated' | 'nodeDeleted' | 'edgeCreated' | 'edgeDeleted',
        number
      >
    >
    layout?: { mode?: string; moved?: number }
  }
  const createdNodes = (payload.created ?? []).filter(
    (c): c is { ref?: string; nodeId: string } => typeof c.nodeId === 'string'
  )
  for (const created of createdNodes) {
    const persisted =
      savedFile.nodes.some((n) => n.id === created.nodeId) ||
      savedFile.edges.some((e) => e.id === created.nodeId)
    if (!persisted)
      throw new AccessFailure('STORAGE_INCONSISTENT', 'patch-verify', created.nodeId.slice(0, 60))
  }
  const zero = { nodeCreated: 0, nodeUpdated: 0, nodeDeleted: 0, edgeCreated: 0, edgeDeleted: 0 }
  const counts = { ...zero, ...(payload.counts ?? {}) }
  return {
    projectId: id,
    graphVersion: patchResult.graphVersion,
    saved: true,
    created: createdNodes.map((c) => ({ ...(c.ref ? { ref: c.ref } : {}), nodeId: c.nodeId })),
    groups: (payload.groups ?? []).filter(
      (group): group is { ref?: string; groupId: string } =>
        typeof (group as { groupId?: unknown }).groupId === 'string'
    ),
    applied: counts,
    ...(payload.layout &&
    (payload.layout.mode === 'flow' ||
      payload.layout.mode === 'lanes' ||
      payload.layout.mode === 'grid')
      ? { layout: { mode: payload.layout.mode, moved: payload.layout.moved ?? 0 } }
      : {})
  }
}

/**
 * L2 智能整理：与 graph.patch 同一权威宿主握手（版本核对 → 准入 → 原子应用 →
 * 保存屏障 → 落盘核对）。
 */
export async function executeGraphLayoutOp(
  ctx: GraphPatchOpsContext,
  id: string,
  activeId: string | null | undefined,
  input: Record<string, unknown>,
  markCommitted: () => void
): Promise<unknown> {
  if (id !== activeId || !ctx.desktop)
    throw new AccessFailure(
      'ACTIVE_PROJECT_REQUIRED',
      'desktop-ownership',
      'project.open the target canvas first, then retry graph.layout'
    )
  const current = projects.openProject(id)
  if (!current) throw new AccessFailure('NOT_FOUND', 'read')
  const nodeIds = input.nodeIds as string[] | undefined
  if (nodeIds) {
    const known = new Set(current.nodes.map((node) => node.id))
    const missing = nodeIds.filter((nodeId) => !known.has(nodeId))
    if (missing.length > 0)
      throw new AccessFailure('NODE_NOT_FOUND', 'precheck', missing[0]!.slice(0, 60))
  }
  const layoutResult = await ctx.desktop.run(
    {
      action: 'graph-layout',
      projectId: id,
      layoutMode: (input.mode as 'auto' | 'flow' | 'lanes' | 'grid' | undefined) ?? 'auto',
      ...(nodeIds ? { nodeIds } : {}),
      expectedGraphVersion: input.expectedGraphVersion as number
    },
    (version) => {
      if (ctx.activeProjectId() !== id)
        throw new AccessFailure('RESOURCE_BUSY', 'desktop-ownership')
      assertProjectHasNoActiveTasks(id)
      const admitted = projects.openProject(id)
      if (!admitted || admitted.meta.graphVersion !== version)
        throw new AccessFailure('REVISION_CONFLICT', 'layout-admission')
      markCommitted()
      return admitted.meta
    }
  )
  const savedFile = projects.openProject(id)
  if (!savedFile || savedFile.meta.graphVersion !== layoutResult.graphVersion)
    throw new AccessFailure('REVISION_CONFLICT', 'layout-verify')
  const payload = (layoutResult.result ?? {}) as { mode?: string; moved?: number }
  const mode =
    payload.mode === 'flow' || payload.mode === 'lanes' || payload.mode === 'grid'
      ? payload.mode
      : 'grid'
  return {
    projectId: id,
    graphVersion: layoutResult.graphVersion,
    saved: true,
    mode,
    moved: payload.moved ?? 0
  }
}
