import type { CompositeManifest, CompositeManifestIssue } from './manifest'
import { parseCompositeManifest } from './manifest'

export type CompositeValidationCode =
  | 'MANIFEST_SCHEMA'
  | 'NODE_REF_MISSING'
  | 'PORT_MISSING'
  | 'PORT_TYPE_MISMATCH'
  | 'PORT_CARDINALITY'
  | 'DUPLICATE_EDGE'
  | 'CYCLE'
  | 'INPUT_NO_TARGET'
  | 'INPUT_TARGET_MISSING'
  | 'INPUT_DUPLICATE_TARGET'
  | 'REQUIRED_INPUT_UNBOUND'
  | 'OUTPUT_SOURCE_MISSING'
  | 'OUTPUT_TYPE_MISMATCH'
  | 'NO_BUSINESS_OUTPUT'
  | 'SCHEMA_UNREGISTERED'
  | 'DEPENDENCY_MISSING'
  | 'BUDGET_EXCEEDED'
  | 'SELF_RECURSION'
  | 'DEPENDENCY_CYCLE'

export interface CompositeValidationIssue extends CompositeManifestIssue {
  code: CompositeValidationCode
}

export interface CompositeValidationResult {
  ok: boolean
  issues: CompositeValidationIssue[]
}

export interface CompositeValidationDeps {
  /** 已发布能力的依赖是否存在（递归检查）；不注入时按 manifest 内声明判定。 */
  hasCapability?: (capabilityId: string, version: string) => boolean
  /** 解析固定版本 manifest，用于嵌套深度/依赖环校验。 */
  getCapability?: (capabilityId: string, version: string) => CompositeManifest | null
}

const ANY_PORT = 'any'
const MAX_BUDGET_NODES = 500
const MAX_BUDGET_EDGES = 1500

function issue(
  code: CompositeValidationCode,
  path: string,
  message: string
): CompositeValidationIssue {
  return { code, path, message }
}

function portsCompatible(
  sourceType: string,
  targetType: string,
  sourceCardinality: 'one' | 'many',
  targetCardinality: 'one' | 'many'
): boolean {
  if (!(sourceType === targetType || sourceType === ANY_PORT || targetType === ANY_PORT)) return false
  if (sourceCardinality === 'many' && targetCardinality === 'one') return false
  return true
}

/**
 * 组合发布前的完整校验（纯函数，GUI/CLI/MCP 共用）。
 *
 * 依赖 manifest 内的节点端口快照，不读 renderer 注册表；因此桌面、CLI、MCP 与 CI
 * 对同一份 manifest 得到完全相同的结论。旧模板不在此处自动转换。
 */
export function validateCompositeManifest(
  value: unknown,
  deps: CompositeValidationDeps = {}
): CompositeValidationResult {
  const parsed = parseCompositeManifest(value)
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((item) => issue('MANIFEST_SCHEMA', item.path, item.message))
    }
  }
  const manifest = parsed.manifest
  const issues: CompositeValidationIssue[] = []
  const nodeById = new Map(manifest.graph.nodes.map((node) => [node.id, node]))
  const portOf = (
    nodeId: string,
    portId: string
  ): NonNullable<CompositeManifest['graph']['nodes'][number]['ports']>[number] | undefined =>
    nodeById.get(nodeId)?.ports?.find((port) => port.id === portId)

  // 内部连线：端点、类型、基数、重复、DAG
  const seenEdges = new Set<string>()
  const outgoingCount = new Map<string, number>()
  for (const [index, edge] of manifest.graph.edges.entries()) {
    const path = `graph.edges[${index}]`
    const fromPort = portOf(edge.from.nodeId, edge.from.portId)
    const toPort = portOf(edge.to.nodeId, edge.to.portId)
    if (!nodeById.has(edge.from.nodeId) || !nodeById.has(edge.to.nodeId)) {
      issues.push(issue('NODE_REF_MISSING', path, '连线引用了不存在的内部节点'))
      continue
    }
    if (!fromPort || !toPort) {
      issues.push(issue('PORT_MISSING', path, '连线引用了不存在的端口'))
      continue
    }
    if (fromPort.dir !== 'out' || toPort.dir !== 'in') {
      issues.push(issue('PORT_MISSING', path, '连线方向必须是 out -> in'))
      continue
    }
    if (!portsCompatible(fromPort.type, toPort.type, fromPort.cardinality, toPort.cardinality)) {
      issues.push(
        issue(
          'PORT_TYPE_MISMATCH',
          path,
          `端口类型不兼容：${fromPort.type}(${fromPort.cardinality}) -> ${toPort.type}(${toPort.cardinality})`
        )
      )
    }
    const key = `${edge.from.nodeId}:${edge.from.portId}->${edge.to.nodeId}:${edge.to.portId}`
    if (seenEdges.has(key)) issues.push(issue('DUPLICATE_EDGE', path, '重复连线'))
    seenEdges.add(key)
    const countKey = `${edge.to.nodeId}:${edge.to.portId}`
    outgoingCount.set(countKey, (outgoingCount.get(countKey) ?? 0) + 1)
    if ((outgoingCount.get(countKey) ?? 0) > 1 && toPort.cardinality === 'one') {
      issues.push(issue('PORT_CARDINALITY', path, `单值端口 ${toPort.id} 收到多条内部连线`))
    }
  }
  if (hasCycle(manifest)) issues.push(issue('CYCLE', 'graph.edges', '内部图存在环，组合必须保持 DAG'))

  // 公开输入
  const usedTargets = new Set<string>()
  for (const [index, input] of manifest.inputs.entries()) {
    const path = `inputs[${index}]`
    if (input.targets.length === 0) issues.push(issue('INPUT_NO_TARGET', path, '公开输入没有映射目标'))
    if (input.type === 'json' && !input.schemaRef)
      issues.push(issue('SCHEMA_UNREGISTERED', path, 'JSON 公开输入缺少 schemaRef'))
    for (const target of input.targets) {
      const port = portOf(target.nodeId, target.portId)
      if (!port) {
        issues.push(issue('INPUT_TARGET_MISSING', path, `映射目标 ${target.nodeId}:${target.portId} 不存在`))
        continue
      }
      if (port.dir !== 'in') issues.push(issue('INPUT_TARGET_MISSING', path, '公开输入只能映射到输入端口'))
      if (!portsCompatible(input.type, port.type, input.cardinality, port.cardinality)) {
        issues.push(
          issue(
            'PORT_TYPE_MISMATCH',
            path,
            `公开输入 ${input.type} 与目标端口 ${port.type} 不兼容`
          )
        )
      }
      const targetKey = `${target.nodeId}:${target.portId}`
      if (usedTargets.has(targetKey))
        issues.push(issue('INPUT_DUPLICATE_TARGET', path, `目标端口 ${targetKey} 被多个公开输入占用`))
      usedTargets.add(targetKey)
    }
  }

  // 必填内部输入：要么有内部连线，要么被公开输入绑定
  const internalIncoming = new Set(
    manifest.graph.edges.map((edge) => `${edge.to.nodeId}:${edge.to.portId}`)
  )
  for (const node of manifest.graph.nodes) {
    for (const port of node.ports ?? []) {
      if (port.dir !== 'in' || !port.required) continue
      const key = `${node.id}:${port.id}`
      if (internalIncoming.has(key) || usedTargets.has(key)) continue
      issues.push(issue('REQUIRED_INPUT_UNBOUND', `graph.nodes.${node.id}`, `必填输入 ${port.id} 没有来源（内部连线或公开输入）`))
    }
  }

  // 公开输出
  if (manifest.outputs.length === 0) issues.push(issue('NO_BUSINESS_OUTPUT', 'outputs', '至少需要一个公开输出'))
  for (const [index, output] of manifest.outputs.entries()) {
    const path = `outputs[${index}]`
    const port = portOf(output.source.nodeId, output.source.portId)
    if (!port) {
      issues.push(issue('OUTPUT_SOURCE_MISSING', path, `输出来源 ${output.source.nodeId}:${output.source.portId} 不存在`))
      continue
    }
    if (port.dir !== 'out') issues.push(issue('OUTPUT_SOURCE_MISSING', path, '公开输出必须来自输出端口'))
    if (port.type !== output.type && output.type !== ANY_PORT && port.type !== ANY_PORT) {
      issues.push(issue('OUTPUT_TYPE_MISMATCH', path, `公开输出 ${output.type} 与来源 ${port.type} 不匹配`))
    }
    if (port.cardinality === 'many' && output.cardinality === 'one')
      issues.push(issue('PORT_CARDINALITY', path, '多值来源不能声明为单值公开输出'))
  }

  // 依赖：固定节点版本、能力递归、预算
  for (const [index, dependency] of (manifest.dependencies ?? []).entries()) {
    const path = `dependencies[${index}]`
    if (dependency.kind === 'node') {
      const matches = manifest.graph.nodes.some(
        (node) =>
          node.nodeType === dependency.id &&
          (dependency.contractVersion === undefined ||
            node.contractVersion === dependency.contractVersion)
      )
      if (!matches)
        issues.push(issue('DEPENDENCY_MISSING', path, `内部图缺少依赖节点 ${dependency.id}@${dependency.contractVersion ?? '?'}`))
    }
    if (dependency.kind === 'capability') {
      if (dependency.id === manifest.capabilityId)
        issues.push(issue('SELF_RECURSION', path, '组合不能直接依赖自身'))
      else if (dependency.version && deps.hasCapability && !deps.hasCapability(dependency.id, dependency.version))
        issues.push(issue('DEPENDENCY_MISSING', path, `依赖组合 ${dependency.id}@${dependency.version} 不存在`))
    }
  }
  // 依赖锁定：内部图每个节点类型/契约版本都必须在 dependencies 中登记，防止
  // 注册表升级后同一版本组合静默换用新节点实现。
  for (const node of manifest.graph.nodes) {
    const listed = (manifest.dependencies ?? []).some(
      (dependency) =>
        dependency.kind === 'node' &&
        dependency.id === node.nodeType &&
        (dependency.contractVersion === undefined || dependency.contractVersion === node.contractVersion)
    )
    if (!listed)
      issues.push(
        issue('DEPENDENCY_MISSING', `graph.nodes.${node.id}`, `节点 ${node.nodeType}@${node.contractVersion} 未登记依赖`)
      )
  }

  // 嵌套依赖：环、深度、展开节点预算（注入 resolver 时才可判定）。
  const getCapability = deps.getCapability
  if (getCapability) {
    const policy = manifest.executionPolicy
    const maxDepth = policy?.maxDepth ?? 5
    const maxNodes = policy?.maxExpandedNodes ?? MAX_BUDGET_NODES
    const walk = (
      current: CompositeManifest,
      depth: number,
      path: string[],
      counter: { nodes: number }
    ): void => {
      counter.nodes += current.graph.nodes.length
      if (counter.nodes > maxNodes) {
        issues.push(issue('BUDGET_EXCEEDED', 'executionPolicy.maxExpandedNodes', `嵌套展开节点数超过预算 ${maxNodes}`))
        return
      }
      if (depth > maxDepth) {
        issues.push(issue('BUDGET_EXCEEDED', 'executionPolicy.maxDepth', `嵌套深度超过预算 ${maxDepth}`))
        return
      }
      for (const dependency of current.dependencies ?? []) {
        if (dependency.kind !== 'capability' || !dependency.version) continue
        if (path.includes(dependency.id)) {
          issues.push(issue('DEPENDENCY_CYCLE', 'dependencies', `组合依赖存在环：${[...path, dependency.id].join(' -> ')}`))
          continue
        }
        const nested = getCapability(dependency.id, dependency.version)
        if (!nested) {
          issues.push(issue('DEPENDENCY_MISSING', 'dependencies', `依赖组合 ${dependency.id}@${dependency.version} 不存在`))
          continue
        }
        walk(nested, depth + 1, [...path, dependency.id], counter)
      }
    }
    walk(manifest, 1, [manifest.capabilityId], { nodes: 0 })
  }

  const policy = manifest.executionPolicy
  const budgetNodes = policy?.maxExpandedNodes ?? MAX_BUDGET_NODES
  const budgetEdges = policy?.maxExpandedEdges ?? MAX_BUDGET_EDGES
  if (manifest.graph.nodes.length > budgetNodes)
    issues.push(issue('BUDGET_EXCEEDED', 'executionPolicy.maxExpandedNodes', `节点数 ${manifest.graph.nodes.length} 超过预算 ${budgetNodes}`))
  if (manifest.graph.edges.length > budgetEdges)
    issues.push(issue('BUDGET_EXCEEDED', 'executionPolicy.maxExpandedEdges', `连线数 ${manifest.graph.edges.length} 超过预算 ${budgetEdges}`))

  return { ok: issues.length === 0, issues }
}

function hasCycle(manifest: CompositeManifest): boolean {
  const adjacency = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const node of manifest.graph.nodes) {
    adjacency.set(node.id, [])
    indegree.set(node.id, 0)
  }
  for (const edge of manifest.graph.edges) {
    adjacency.get(edge.from.nodeId)?.push(edge.to.nodeId)
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited += 1
    for (const next of adjacency.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 1) - 1
      indegree.set(next, degree)
      if (degree === 0) queue.push(next)
    }
  }
  return visited !== manifest.graph.nodes.length
}
