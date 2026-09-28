/** Per-project node visibility. IDs are stable node protocol IDs, never labels. */
export interface WorkspaceProfile {
  schemaVersion: 1
  presetId: 'general' | 'image' | 'video' | 'audio' | 'all' | 'custom'
  visibleNodeTypeIds: string[]
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
  'audio',
  'sound-adjust',
  'speech',
  'tts',
  'storyboard'
] as const

export function defaultWorkspaceProfile(): WorkspaceProfile {
  return {
    schemaVersion: 1,
    presetId: 'general',
    visibleNodeTypeIds: [...GENERAL_WORKSPACE_NODE_TYPES]
  }
}

/** `null` means a legacy project: show every currently creatable node. */
export function normalizeWorkspaceProfile(value: unknown): WorkspaceProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<WorkspaceProfile>
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.visibleNodeTypeIds)) return null
  const ids = [...new Set(raw.visibleNodeTypeIds.filter((id): id is string =>
    typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)
  ))]
  const presetId = ['general', 'image', 'video', 'audio', 'all', 'custom'].includes(
    String(raw.presetId)
  )
    ? (raw.presetId as WorkspaceProfile['presetId'])
    : 'custom'
  // 旧项目保存预设时，新发布的节点尚不存在；预设需随版本补入新成员。
  // 用户逐项选择的 custom 配置保持原样。
  if (presetId === 'general' || presetId === 'all') {
    for (const type of ['website', 'sound-adjust']) if (!ids.includes(type)) ids.push(type)
  } else if (presetId === 'audio' || presetId === 'video') {
    if (!ids.includes('sound-adjust')) ids.push('sound-adjust')
  }
  return { schemaVersion: 1, presetId, visibleNodeTypeIds: ids }
}
