import { hasCompositeManualGate, type CompositeManifest } from './manifest'

export interface CompositeNestedCapabilityRef {
  capabilityId: string
  version: string
  contentHash?: string
}

export interface CompositeNestedCandidates {
  inline: CompositeManifest[]
  references: CompositeNestedCapabilityRef[]
}

/**
 * 当前 manifest 的直接嵌套候选：图形节点里的内嵌/固定版本引用 + 显式 capability 依赖。
 * 发布校验和运行准入共用同一份展开事实，兼容旧快照缺少 requiresManualGate 传播标记的情况。
 */
export function compositeNestedCandidates(manifest: CompositeManifest): CompositeNestedCandidates {
  const inline: CompositeManifest[] = []
  const references: CompositeNestedCapabilityRef[] = []
  for (const node of manifest.graph.nodes) {
    if (node.nodeType !== 'composite') continue
    try {
      const parsed = JSON.parse(node.config || '{}') as {
        manifest?: CompositeManifest
        ref?: CompositeNestedCapabilityRef
        capabilityId?: unknown
        version?: unknown
        contentHash?: unknown
      }
      if (parsed.manifest) {
        inline.push(parsed.manifest)
        continue
      }
      const ref = parsed.ref ??
        (typeof parsed.capabilityId === 'string'
          ? {
              capabilityId: parsed.capabilityId,
              version: parsed.version,
              contentHash: parsed.contentHash
            }
          : undefined)
      if (
        ref &&
        typeof ref.capabilityId === 'string' &&
        typeof ref.version === 'string'
      ) {
        references.push({
          capabilityId: ref.capabilityId,
          version: ref.version,
          ...(typeof ref.contentHash === 'string' ? { contentHash: ref.contentHash } : {})
        })
      }
    } catch {
      // 损坏配置由既有运行/发布校验报告；这里不据此推断人工门。
    }
  }
  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.kind === 'capability' && dependency.version) {
      references.push({
        capabilityId: dependency.id,
        version: dependency.version
      })
    }
  }
  return { inline, references }
}

function manifestKey(manifest: CompositeManifest): string {
  return `${manifest.capabilityId}@${manifest.version}`
}

/**
 * 在嵌套链中查找人工门，默认不包含当前 manifest 自身。
 * includeCurrent=true 用于已经定位到某个内部 composite 快照后的整棵子树检查。
 * 返回实际命中的快照，供稳定错误码附带安全 capabilityId；不返回正文或配置。
 */
export function findNestedCompositeManualGate(
  manifest: CompositeManifest,
  getCapability: (capabilityId: string, version: string) => CompositeManifest | null,
  options: { includeCurrent?: boolean } = {}
): CompositeManifest | null {
  const visited = new Set<string>([manifestKey(manifest)])
  const walk = (
    current: CompositeManifest,
    includeCurrent: boolean
  ): CompositeManifest | null => {
    if (
      includeCurrent &&
      (current.executionPolicy?.requiresManualGate || hasCompositeManualGate(current.graph))
    )
      return current
    const candidates = compositeNestedCandidates(current)
    for (const nested of candidates.inline) {
      if (nested.executionPolicy?.requiresManualGate || hasCompositeManualGate(nested.graph))
        return nested
      const key = manifestKey(nested)
      if (visited.has(key)) continue
      visited.add(key)
      const found = walk(nested, false)
      if (found) return found
    }
    for (const ref of candidates.references) {
      const nested = getCapability(ref.capabilityId, ref.version)
      if (!nested) continue
      if (nested.executionPolicy?.requiresManualGate || hasCompositeManualGate(nested.graph))
        return nested
      const key = manifestKey(nested)
      if (visited.has(key)) continue
      visited.add(key)
      const found = walk(nested, false)
      if (found) return found
    }
    return null
  }
  return walk(manifest, options.includeCurrent === true)
}
