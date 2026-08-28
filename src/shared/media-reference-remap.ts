/** 媒体 ID / 相对路径的精确重映射。纯函数，供导入器与回归测试共用。 */
export interface MediaReferenceMap {
  ids: ReadonlyMap<string, string>
  paths: ReadonlyMap<string, string>
}

/**
 * tldraw 快照、节点运行结果和导演台数据均为 JSON。递归替换精确匹配的媒体引用，
 * 既不会漏掉嵌套字段，也不会把提示词中的相同片段误改为新 ID。
 */
export function remapMediaReferences<T>(value: T, maps: MediaReferenceMap): T {
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string')
      return maps.ids.get(current) ?? maps.paths.get(current) ?? current
    if (Array.isArray(current)) return current.map(visit)
    if (!current || typeof current !== 'object') return current
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([key, item]) => [key, visit(item)])
    )
  }
  return visit(value) as T
}
