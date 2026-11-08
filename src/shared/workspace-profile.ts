import { DISTRIBUTION_EDITION, DISTRIBUTION_HIDDEN_NODE_TYPES } from './edition'
import { ACTIVE_NODE_TYPE_IDS } from './types'
/** Per-project node visibility. IDs are stable node protocol IDs, never labels. */
export interface WorkspaceProfile {
  schemaVersion: 1
  presetId: 'general' | 'image' | 'video' | 'audio' | 'all' | 'custom'
  visibleNodeTypeIds: string[]
  /** 节点集版本；缺省按 0 处理，用于把新版本新增的节点补进旧配置（见 normalize）。 */
  nodeSetRevision?: number
}

/** A focused default; advanced node types remain available from the project settings dialog. */
export const GENERAL_WORKSPACE_NODE_TYPES = [
  'text',
  'file',
  'website',
  'chat',
  'image',
  'image-gen',
  'image-edit',
  'video-asset',
  'video',
  'video-frame',
  'timeline',
  'audio',
  'sound-adjust',
  'speech',
  'tts',
  'storyboard',
  'agent',
  'ai-review',
  'state-machine',
  'processor',
  'json',
  'structured',
  'iterate',
  'code'
] as const

/**
 * 与 GUI「新建项目」同一默认：预设 `all`，可见集合 = 全部当前可创建节点。
 *
 * 为什么需要它：GUI 的新建项目对话框默认 `presetId: 'all'` + 全部可创建节点，
 * 而外部 `project.create` 此前落到 `defaultWorkspaceProfile()`（`general` 预设，
 * 只有 24 个常用节点）。于是同一个业务动作"创建项目"在两个入口得到不同的节点可见集：
 * CLI/MCP 建的项目打开后调色板里没有裁剪/拆分/截取/音色设计/导演台等 8 类节点，
 * 用户会以为功能缺失（实际是可见集不同）。外部入口必须与 GUI 对齐。
 *
 * 发行版（`CANVAS_DISTRIBUTION=1`）沿用同一条裁剪清单；常规开发/测试构建不裁剪。
 */
export function allWorkspaceProfile(): WorkspaceProfile {
  const creatable = DISTRIBUTION_EDITION
    ? ACTIVE_NODE_TYPE_IDS.filter((type) => !DISTRIBUTION_HIDDEN_NODE_TYPES.has(type))
    : [...ACTIVE_NODE_TYPE_IDS]
  return {
    schemaVersion: 1,
    presetId: 'all',
    visibleNodeTypeIds: creatable,
    nodeSetRevision: WORKSPACE_NODE_SET_REVISION
  }
}

export function defaultWorkspaceProfile(): WorkspaceProfile {
    // 发行版：默认可见集合排除裁剪节点（与调色板过滤同一清单）。
    const visibleTypes = DISTRIBUTION_EDITION
      ? GENERAL_WORKSPACE_NODE_TYPES.filter((type) => !DISTRIBUTION_HIDDEN_NODE_TYPES.has(type))
      : [...GENERAL_WORKSPACE_NODE_TYPES]
  return {
    schemaVersion: 1,
    presetId: 'general',
    visibleNodeTypeIds: visibleTypes,
    nodeSetRevision: WORKSPACE_NODE_SET_REVISION
  }
}

/**
 * 节点集版本（2026-11-02 起）。
 *
 * `visibleNodeTypeIds` 是保存时的节点快照，新版本发布的节点天然不在里面——包括用户
 * 手工挑过节点的 `custom` 配置。只靠 preset 补丁永远补不到 custom，于是表现为
 * 「更新后节点面板里根本找不到新节点」。这里按版本号一次性把新节点补进已保存配置；
 * 之后用户再主动隐藏，版本号已到位，不会被反复加回来。
 */
export const WORKSPACE_NODE_SET_REVISION = 2

const NODES_ADDED_BY_REVISION: Record<number, readonly string[]> = {
  2: ['timeline']
}

/** `null` means a legacy project: show every currently creatable node. */
export function normalizeWorkspaceProfile(value: unknown): WorkspaceProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<WorkspaceProfile>
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.visibleNodeTypeIds)) return null
  const ids = [
    ...new Set(
      raw.visibleNodeTypeIds.filter(
        (id): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)
      )
    )
  ]
  const presetId = ['general', 'image', 'video', 'audio', 'all', 'custom'].includes(
    String(raw.presetId)
  )
    ? (raw.presetId as WorkspaceProfile['presetId'])
    : 'custom'
  // 旧项目保存预设时，新发布的节点尚不存在；预设需随版本补入新成员。
  // 用户逐项选择的 custom 配置保持原样。
  if (presetId === 'general' || presetId === 'all') {
    for (const type of [
      'website',
      'sound-adjust',
      'agent',
      'ai-review',
      'state-machine',
      'processor',
      'json',
      'structured',
      'iterate',
      'code',
      // 2026-11-02 时间线节点：老项目保存预设时该节点还不存在，必须随版本补入，
      // 否则「general/all」项目升级后永远看不到新建入口。
      'timeline'
    ])
      if (!ids.includes(type)) ids.push(type)
  } else if (presetId === 'audio' || presetId === 'video') {
    if (!ids.includes('sound-adjust')) ids.push('sound-adjust')
  }
  // 按节点集版本补齐新节点（含 custom）：老配置里没有版本号时按 0 处理。
  const revision = typeof raw.nodeSetRevision === 'number' ? raw.nodeSetRevision : 0
  for (const [addedAt, types] of Object.entries(NODES_ADDED_BY_REVISION)) {
    if (revision >= Number(addedAt)) continue
    for (const type of types) if (!ids.includes(type)) ids.push(type)
  }
  return {
    schemaVersion: 1,
    presetId,
    visibleNodeTypeIds: ids,
    nodeSetRevision: Math.max(revision, WORKSPACE_NODE_SET_REVISION)
  }
}
