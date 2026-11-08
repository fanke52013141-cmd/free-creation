// F8（一）flowAssets 族：把 GUI「Agent Flow 资产」的**固定资产**动作开放给外部 CLI/MCP。
//
// 业务实现只有一份：`src/main/agent-flow/asset-store.ts` 的 `FlowAssetStore`
// （GUI 资产面板、命令账本 precheck、审核宿主共用同一 store）。本模块只负责：
// 1. 项目作用域与活动画布处理——活动画布的未保存编辑先经**权威宿主保存握手**（与 GUI
//    `ensureCanvasSaved` 同一语义）再读取落盘版本，绝不绕过保存屏障直接从内存猜版本；
// 2. 幂等提交身份——`submissionId` 由幂等键派生，崩溃恢复窗口内重复提交命中同一回执；
// 3. 响应规模限制——固定资产取值最多 1 MiB，而外部接入单帧上限 1 MiB，读取超限如实
//    拒绝（不截断、不伪装成成功）。
// 任何情况下外部都不能提供取值、改已提交版本、跳过命令占用（`ASSET_SOURCE_OCCUPIED`）
// 或伪造审核结论：这些都发生在同一 store 的既有规则里。
import { createHash } from 'node:crypto'
import type { FlowAssetValue, FlowAssetVersion } from '../../shared/agent-flow/assets'
import { FlowAssetError } from '../../shared/agent-flow/assets'
import type { AccessOperationId, AccessOutput } from '../../shared/agent-access/registry'
import { FlowAssetStore } from '../agent-flow/asset-store'
import { getDb } from '../store/db'
import { openProject } from '../store/projects.repo'
import { DesktopAccessError, type AccessDesktop } from './desktop'

/** 本族已开放的操作；service.ts 只按这个集合做一次分组委托。 */
export const FLOW_ASSET_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'flowAsset.submit',
  'flowAsset.list',
  'flowAsset.read'
] as AccessOperationId[])

export interface FlowAssetOperationContext {
  activeProjectId: () => string | null
  desktop?: AccessDesktop
  requestId: string
  /** 写操作的幂等键：同键重放返回原回执，也决定固定资产提交身份。 */
  idempotencyKey?: string
  diagnostics: { traceId: string; spanId: string }
}

/** 与 output.get 同一投影上限：文本 20k 字符、JSON 100k 编码字符；超出如实拒绝。 */
const MAX_TEXT_CHARS = 20_000
const MAX_JSON_CHARS = 100_000

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

function fail(error: unknown): never {
  if (error instanceof DesktopAccessError) throw error
  if (error instanceof FlowAssetError)
    throw new DesktopAccessError(error.code, false, error.phase)
  throw error
}

function assetStore(): FlowAssetStore {
  return new FlowAssetStore(getDb(), openProject)
}

function projectFile(projectId: string): NonNullable<ReturnType<typeof openProject>> {
  const file = openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'read')
  return file
}

function summaryDto(version: Omit<FlowAssetVersion, 'value'>): Record<string, unknown> {
  return {
    ref: version.ref,
    projectId: version.projectId,
    ordinal: version.ordinal,
    graphVersion: version.graphVersion,
    createdAt: version.createdAt,
    digest: version.digest
  }
}

/** 固定取值 DTO：媒体只回受控引用（mediaId/相对路径/MIME/摘要），不回字节或绝对路径。 */
function valueDto(value: FlowAssetValue): AccessOutput<'flowAsset.read'>['value'] {
  // 用 `in` 收窄：FlowAssetValue 的文本成员是 `kind: 'text' | 'markdown'` 联合判别，
  // 按 kind 比较无法把成员从联合中排除。
  if ('text' in value) {
    if (value.text.length > MAX_TEXT_CHARS)
      refuse('ASSET_VALUE_TOO_LARGE', `text length ${value.text.length} exceeds ${MAX_TEXT_CHARS}`)
    return { kind: value.kind, text: value.text }
  }
  if ('data' in value) {
    const encoded = JSON.stringify(value.data ?? null) ?? 'null'
    if (encoded.length > MAX_JSON_CHARS)
      refuse('ASSET_VALUE_TOO_LARGE', `json length ${encoded.length} exceeds ${MAX_JSON_CHARS}`)
    return {
      kind: 'json',
      json: JSON.parse(encoded) as NonNullable<AccessOutput<'flowAsset.read'>['value']['json']>
    }
  }
  return {
    kind: value.kind,
    mediaId: value.mediaId,
    mediaPath: value.mediaPath,
    mime: value.mime,
    ...(value.contentSha256 ? { contentSha256: value.contentSha256 } : {})
  }
}

function versionDto(version: FlowAssetVersion): AccessOutput<'flowAsset.read'> {
  return {
    projectId: version.projectId,
    ref: version.ref,
    ordinal: version.ordinal,
    graphVersion: version.graphVersion,
    createdAt: version.createdAt,
    digest: version.digest,
    valueKind: version.value.kind,
    value: valueDto(version.value)
  }
}

/**
 * 提交固定资产。活动画布必须先经桌面保存握手：这是"画布变更/读取必须经权威宿主"的
 * 同一规则，避免用内存里的旧版本固化出与用户界面不一致的版本。
 */
async function submitFlowAsset(
  input: Record<string, unknown>,
  context: FlowAssetOperationContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const portId = input.portId as string
  const expected = input.expectedGraphVersion as number
  const file = projectFile(projectId)
  let graphVersion = file.meta.graphVersion
  if (context.activeProjectId() === projectId) {
    if (!context.desktop)
      refuse(
        'ACTIVE_PROJECT_REQUIRED',
        'flowAsset.submit: canvas is open but no desktop host can save it; retry after the window is ready'
      )
    // 与 GUI 的 ensureCanvasSaved 同一窗口：先把未保存编辑落盘，再读版本。
    const flushed = await context.desktop.run({ action: 'flush', projectId })
    graphVersion = flushed.graphVersion
  }
  if (graphVersion !== expected)
    refuse('REVISION_CONFLICT', `expected ${expected} but the saved canvas is at ${graphVersion}`)
  // 同幂等键重放（含崩溃后的重试）命中同一 submissionId，不重复固化版本。
  const submissionId = `ext-${createHash('sha256')
    .update(context.idempotencyKey ?? context.requestId)
    .digest('hex')
    .slice(0, 40)}`
  const version = assetStore().submit({
    projectId,
    nodeId,
    portId,
    submissionId,
    expectedGraphVersion: graphVersion,
    traceId: context.diagnostics.traceId,
    spanId: context.diagnostics.spanId
  })
  return {
    projectId,
    ref: version.ref,
    ordinal: version.ordinal,
    graphVersion: version.graphVersion,
    createdAt: version.createdAt,
    digest: version.digest,
    valueKind: version.value.kind
  }
}

function listFlowAsset(input: Record<string, unknown>): unknown {
  const projectId = input.projectId as string
  const nodeId = input.nodeId as string
  const portId = input.portId as string
  projectFile(projectId)
  const versions = assetStore().list(projectId, nodeId, portId)
  return {
    projectId,
    nodeId,
    portId,
    total: versions.length,
    items: versions.map(summaryDto)
  }
}

function readFlowAsset(input: Record<string, unknown>): unknown {
  const projectId = input.projectId as string
  const versionId = input.versionId as string
  projectFile(projectId)
  return versionDto(assetStore().read(projectId, versionId))
}

/** dispatch 的分组委托入口：只分发本族操作，其余明确拒绝（防误接）。 */
export async function runFlowAssetOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: FlowAssetOperationContext
): Promise<unknown> {
  try {
    switch (operationId) {
      case 'flowAsset.submit':
        return await submitFlowAsset(input, context)
      case 'flowAsset.list':
        return listFlowAsset(input)
      case 'flowAsset.read':
        return readFlowAsset(input)
      default:
        refuse('UNSUPPORTED_OPERATION', 'flow-assets-dispatch')
    }
  } catch (error) {
    fail(error)
  }
}
