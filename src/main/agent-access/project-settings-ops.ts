// F9（三）项目节点可见集：读/写 GUI「工作台节点设置」保存的 workspaceProfile。
//
// 为什么需要外部读写：本轮修复过"外部 project.create 默认少 8 类节点"（台账 34）——
// 可见集直接决定调色板里有哪些节点，Agent 必须能解释"某个节点为什么不在面板里"，
// 也必须能按用户意图调整。
//
// 口径：
// - 读取走 projects.repo.openProject（与 GUI 打开项目同一条读路径，含旧配置归一化）；
//   旧项目从未保存过配置时返回 profile=null + source=legacy-all-visible（运行时按
//   "显示全部当前可创建节点"解释），不伪造成 general 预设。
// - 写入只接受当前可创建类型（allWorkspaceProfile()：Active 集 ∩ 非发行版裁剪），
//   未知/退役/重复/空集合由执行层显式拒绝并给稳定错误码；
//   落盘走 projects.repo.saveWorkspaceProfile（正式保存机制：锁 + tmp/rename + 索引更新），
//   随后重读项目核对，避免"回执说保存了但文件没变"。
// - 写入不推进 graphVersion（与 GUI 同语义：可见集是工作台配置，不是图内容）。
import type { WorkspaceProfile } from '../../shared/workspace-profile'
import { WORKSPACE_NODE_SET_REVISION, allWorkspaceProfile } from '../../shared/workspace-profile'
import { DesktopAccessError } from './desktop'
import * as projects from '../store/projects.repo'

export interface ProjectSettingsContext {
  activeProjectId: () => string | null
}

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, `node-visibility:${detail ?? code}`)
}

/** 生效后失败：项目文件可能已改变，保守按 unknown 交由调用方重读核对。 */
function unknownFailure(code: string, detail?: string): never {
  throw new DesktopAccessError(code, true, `node-visibility:${detail ?? code}`)
}

function creatableNodeTypeIds(): string[] {
  return [...allWorkspaceProfile().visibleNodeTypeIds]
}

function projectIdOf(input: Record<string, unknown>): string {
  return input.projectId as string
}

function profileDto(profile: WorkspaceProfile): {
  presetId: WorkspaceProfile['presetId']
  visibleNodeTypeIds: string[]
  nodeSetRevision: number
} {
  return {
    presetId: profile.presetId,
    visibleNodeTypeIds: [...profile.visibleNodeTypeIds],
    nodeSetRevision: profile.nodeSetRevision ?? 0
  }
}

function getVisibility(input: Record<string, unknown>): unknown {
  const projectId = projectIdOf(input)
  const file = projects.openProject(projectId)
  if (!file) refuse('NOT_FOUND', 'project')
  const creatable = creatableNodeTypeIds()
  const creatableSet = new Set(creatable)
  const saved = file.workspaceProfile
  const base = {
    projectId,
    graphVersion: file.meta.graphVersion,
    creatableNodeTypeIds: creatable,
    creatableCount: creatable.length
  }
  // 旧项目：从未保存过可见集。运行时会话按"全部可创建节点"解释，不能伪造成 general。
  if (!saved) {
    return {
      ...base,
      profile: null,
      effectiveVisibleNodeTypeIds: creatable,
      savedButNotCreatable: [],
      visibleCount: creatable.length,
      source: 'legacy-all-visible' as const
    }
  }
  const effective = saved.visibleNodeTypeIds.filter((type) => creatableSet.has(type))
  const savedButNotCreatable = saved.visibleNodeTypeIds.filter((type) => !creatableSet.has(type))
  return {
    ...base,
    profile: profileDto(saved),
    effectiveVisibleNodeTypeIds: effective,
    savedButNotCreatable,
    visibleCount: effective.length,
    source: 'saved-profile' as const
  }
}

function setVisibility(input: Record<string, unknown>, context: ProjectSettingsContext): unknown {
  const projectId = projectIdOf(input)
  const before = projects.openProject(projectId)
  if (!before) refuse('NOT_FOUND', 'project')
  const requested = input.visibleNodeTypeIds as string[]
  if (requested.length === 0) refuse('EMPTY_NODE_VISIBILITY')
  const creatable = creatableNodeTypeIds()
  const creatableSet = new Set(creatable)
  const unknown = requested.filter((type) => !creatableSet.has(type))
  if (unknown.length > 0)
    refuse('UNKNOWN_NODE_TYPE', [...new Set(unknown)].slice(0, 5).join(','))
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const type of requested) {
    if (seen.has(type)) duplicates.push(type)
    else seen.add(type)
  }
  if (duplicates.length > 0)
    refuse('DUPLICATE_NODE_TYPE', [...new Set(duplicates)].slice(0, 5).join(','))
  // 按当前可创建顺序归一：调色板顺序稳定，回执与文件内容可逐字节比较。
  const ordered = creatable.filter((type) => seen.has(type))
  const presetId: WorkspaceProfile['presetId'] =
    ordered.length === creatable.length ? 'all' : 'custom'
  // 显式写入必须按请求原样保存：携带当前节点集版本，避免共享 normalize 因为
  // "版本落后"把新节点（如 timeline）静默补回用户刚下掉的集合。GUI 对话框不传版本号，
  // 走的是"补新节点"的旧口径；外部显式集合是精确替换，两者在文件里的结果都可能出现，
  // 但外部回执给出 added/removed，不会静默改用户意图。
  const profile: WorkspaceProfile = {
    schemaVersion: 1,
    presetId,
    visibleNodeTypeIds: ordered,
    nodeSetRevision: WORKSPACE_NODE_SET_REVISION
  }
  const previous = before.workspaceProfile?.visibleNodeTypeIds ?? creatable
  let meta
  try {
    // 正式保存机制：写锁 + tmp/rename + 索引更新时间；不推进 graphVersion。
    meta = projects.saveWorkspaceProfile(projectId, profile)
  } catch {
    refuse('SAVE_FAILED', 'save')
  }
  if (!meta) refuse('NOT_FOUND', 'project')
  const after = projects.openProject(projectId)
  const savedProfile = after?.workspaceProfile
  if (!after || !savedProfile)
    unknownFailure('STORAGE_INCONSISTENT', 'verify')
  const savedIds = savedProfile.visibleNodeTypeIds
  // 核对落盘结果与请求集合一致（顺序已按可创建顺序归一）。
  if (
    savedIds.length !== ordered.length ||
    savedIds.some((type, index) => type !== ordered[index])
  )
    unknownFailure('STORAGE_INCONSISTENT', 'verify')
  const previousSet = new Set(previous)
  const savedSet = new Set(savedIds)
  return {
    projectId,
    graphVersion: after.meta.graphVersion,
    saved: true as const,
    profile: profileDto(savedProfile),
    visibleCount: savedIds.length,
    added: savedIds.filter((type) => !previousSet.has(type)),
    removed: previous.filter((type) => !savedSet.has(type)),
    // 画布打开时 GUI 持有一份内存配置：必须重开项目才能看到新可见集（如实告知）。
    desktopReloadRequired: context.activeProjectId() === projectId
  }
}

/** project.nodeVisibility.* 的统一入口。 */
export function runProjectSettingsOperation(
  operation: string,
  input: Record<string, unknown>,
  context: ProjectSettingsContext
): unknown {
  switch (operation) {
    case 'project.nodeVisibility.get':
      return getVisibility(input)
    case 'project.nodeVisibility.set':
      return setVisibility(input, context)
    default:
      throw new DesktopAccessError('UNSUPPORTED_OPERATION', false, 'project-settings-dispatch')
  }
}
