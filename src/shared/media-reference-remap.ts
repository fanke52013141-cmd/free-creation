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
    if (typeof current === 'string') {
      const direct = maps.ids.get(current) ?? maps.paths.get(current)
      if (direct) return direct
      // 节点 config/nodeResult 是持久化 JSON 字符串；导入时也必须进入其内部，
      // 否则导演台等节点会保留指向源项目的媒体引用。跳过普通提示词，避免无意义的解析。
      const trimmed = current.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return current
      try {
        const parsed = JSON.parse(current) as unknown
        if (parsed && typeof parsed === 'object') {
          const remapped = visit(parsed)
          // 没有引用变化时保留用户在配置中写下的原始格式。
          return JSON.stringify(remapped) === JSON.stringify(parsed)
            ? current
            : JSON.stringify(remapped)
        }
      } catch {
        // 非 JSON 的用户文本不属于结构化引用，保持原样。
      }
      return current
    }
    if (Array.isArray(current)) return current.map(visit)
    if (!current || typeof current !== 'object') return current
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([key, item]) => [key, visit(item)])
    )
  }
  return visit(value) as T
}
