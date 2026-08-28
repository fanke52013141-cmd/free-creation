import type { NodeCardProps } from './NodeCardShape'

type UnknownRecord = Record<string, unknown>

const nodeCardDefaults: NodeCardProps = {
  w: 340,
  h: 200,
  nodeType: 'text',
  title: '文本',
  config: '',
  text: '',
  mediaId: '',
  mediaPath: '',
  mediaMime: '',
  exec: 'idle'
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 将已知 node-card 的缺失 props 补齐为当前节点契约所需的默认值。
 *
 * 这是恢复前的纯内存修复：不会删除任何记录，也不会直接写入项目文件；仅在
 * tldraw 成功加载后才会进入既有的自动保存路径。未知形状与其他 tldraw 记录
 * 原样保留，避免把正常的未来扩展误判为损坏数据。
 */
export function repairTldrawSnapshot(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || !isRecord(snapshot.store)) return snapshot

  let changed = false
  const repairedStore: UnknownRecord = {}

  for (const [id, value] of Object.entries(snapshot.store)) {
    if (!isRecord(value) || value.typeName !== 'shape' || value.type !== 'node-card') {
      repairedStore[id] = value
      continue
    }

    const props = isRecord(value.props) ? value.props : {}
    const repairedProps: NodeCardProps = {
      w: numberOr(props.w, nodeCardDefaults.w),
      h: numberOr(props.h, nodeCardDefaults.h),
      nodeType: stringOr(props.nodeType, nodeCardDefaults.nodeType),
      title: stringOr(props.title, nodeCardDefaults.title),
      config: stringOr(props.config, nodeCardDefaults.config),
      text: stringOr(props.text, nodeCardDefaults.text),
      mediaId: stringOr(props.mediaId, nodeCardDefaults.mediaId),
      mediaPath: stringOr(props.mediaPath, nodeCardDefaults.mediaPath),
      mediaMime: stringOr(props.mediaMime, nodeCardDefaults.mediaMime),
      exec: stringOr(props.exec, nodeCardDefaults.exec)
    }
    const isChanged = Object.entries(repairedProps).some(
      ([key, repaired]) => props[key] !== repaired
    )
    repairedStore[id] = isChanged ? { ...value, props: { ...props, ...repairedProps } } : value
    changed ||= isChanged
  }

  return changed ? { ...snapshot, store: repairedStore } : snapshot
}
