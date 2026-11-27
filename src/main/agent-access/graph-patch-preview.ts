import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  GRAPH_NODE_CONFIG_MAX_BYTES,
  type GraphPatchOp
} from '../../shared/agent-access/graph-ops'
import { nodeContract } from '../../shared/agent-access/node-contracts'
import type { CompositeManifest } from '../../shared/composite/manifest'
import {
  codeParamPortId,
  codePortConfigErrors,
  mapVarTypeToPortType,
  outputFieldPortId,
  outputPortId,
  parseCodeConfigs
} from '../../shared/engine/executors/code'
import { portPairCompatible } from '../../shared/port-compatibility'
import type { PortDecl, PortType, ProjectFile } from '../../shared/types'
import { layoutGraph } from '../../shared/flow-layout'

interface PrecheckPort {
  id: string
  dir: 'in' | 'out'
  type: PortType
  cardinality: 'one' | 'many'
  schema?: { id: string; version: number }
}

interface PrecheckSimNode {
  type: string
  config: string
  exists: boolean
  compositeManifest?: CompositeManifest
  /** 当已有节点来自画布快照时保留其真实端口，供动态端口节点校验。 */
  existingPorts?: { in: PrecheckPort[]; out: PrecheckPort[] }
}

function parseSchemaString(raw?: string): { id: string; version: number } | undefined {
  if (!raw) return undefined
  const at = raw.lastIndexOf('@')
  if (at <= 0) return { id: raw, version: 1 }
  const version = Number(raw.slice(at + 1))
  return Number.isFinite(version) ? { id: raw.slice(0, at), version } : { id: raw, version: 1 }
}

function mergePatchConfig(baseRaw: string, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {}
  if (baseRaw.trim()) {
    try {
      const parsed: unknown = JSON.parse(baseRaw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>
      }
    } catch {
      // ignore malformed historical config
    }
  }
  const merged: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k]
    else merged[k] = v
  }
  return JSON.stringify(merged)
}

function resolvePrecheckPorts(
  node: PrecheckSimNode
): { in: PrecheckPort[]; out: PrecheckPort[]; strict: boolean } {
  if (node.type === 'composite') {
    const manifest = node.compositeManifest
    if (!manifest) return { in: [], out: [], strict: true }
    return {
      strict: true,
      in: manifest.inputs.map((input) => ({
        id: `in-${input.id}`,
        dir: 'in',
        type: input.type,
        cardinality: input.cardinality,
        ...(input.type === 'json'
          ? { schema: input.schemaRef ?? { id: 'json.any', version: 1 } }
          : {})
      })),
      out: manifest.outputs.map((output) => ({
        id: `out-${output.id}`,
        dir: 'out',
        type: output.type,
        cardinality: output.cardinality,
        ...(output.type === 'json'
          ? { schema: output.schemaRef ?? { id: 'json.any', version: 1 } }
          : {})
      }))
    }
  }
  if (node.type === 'code') {
    const cfg = parseCodeConfigs(node.config)
    const paramPorts: PrecheckPort[] = cfg.params.map((p) => {
      const type = mapVarTypeToPortType(p.type)
      return {
        id: codeParamPortId(p),
        dir: 'in',
        type,
        cardinality: p.cardinality ?? 'one',
        ...(type === 'json' ? { schema: { id: 'json.any', version: 1 } } : {}),
        ...(type === 'camera' ? { schema: { id: 'previs.camera', version: 1 } } : {})
      }
    })
    const outputFields =
      cfg.outputMode === 'fields'
        ? cfg.outputs
        : [{ name: cfg.outputName, type: cfg.outputType }]
    return {
      strict: true,
      in: [
        { id: 'in-text', dir: 'in', type: 'text', cardinality: 'many' },
        {
          id: 'in-json',
          dir: 'in',
          type: 'json',
          cardinality: 'many',
          schema: { id: 'json.any', version: 1 }
        },
        ...paramPorts
      ],
      out: outputFields.map((field) => {
        const type = mapVarTypeToPortType(field.type)
        const id = 'portId' in field ? outputFieldPortId(field) : outputPortId(field.name)
        return {
          id,
          dir: 'out',
          type,
          cardinality: 'one',
          ...(type === 'json' ? { schema: { id: 'json.any', version: 1 } } : {}),
          ...(type === 'camera' ? { schema: { id: 'previs.camera', version: 1 } } : {})
        }
      })
    }
  }
  const contract = nodeContract(node.type)
  if (!contract) {
    if (node.existingPorts) return { ...node.existingPorts, strict: false }
    return { in: [], out: [], strict: false }
  }
  if (contract.dynamicPorts && node.existingPorts) {
    return { ...node.existingPorts, strict: false }
  }
  return {
    strict: !contract.dynamicPorts,
    in: contract.ports.in.map((p) => ({
      id: p.id,
      dir: 'in',
      type: p.type as PortType,
      cardinality: p.cardinality,
      schema: parseSchemaString(p.schema)
    })),
    out: contract.ports.out.map((p) => ({
      id: p.id,
      dir: 'out',
      type: p.type as PortType,
      cardinality: p.cardinality,
      schema: parseSchemaString(p.schema)
    }))
  }
}

export interface GraphPatchPrecheckIssue {
  code: string
  detail: string
}

/**
 * 方案 A `graph.patch.propose` 主进程深度预检：
 * 在把幽灵预览推送到用户画布之前，提前校验节点类型、config 体积与 code 动态端口配置、
 * 连线端口存在性（附带合法端口列表）、端口类型/Schema 兼容、单值端口占用、重复边与全图无环。
 * 让外部 Agent 在 propose 阶段即可拿到精准错误并自修，绝不把坏预览推给用户点击确认。
 */
export function precheckGraphPatchOps(options: {
  ops: readonly GraphPatchOp[]
  currentFile: ProjectFile
  resolveCompositeManifest?: (
    capabilityId: string,
    version: string
  ) => CompositeManifest | undefined
}): { ok: true } | { ok: false; issue: GraphPatchPrecheckIssue } {
  const { ops, currentFile, resolveCompositeManifest } = options
  const simNodes = new Map<string, PrecheckSimNode>()
  const snapshotStore = (
    currentFile.tldrawSnapshot as
      | {
          store?: Record<
            string,
            { props?: { config?: string }; meta?: { compositeManifest?: CompositeManifest } }
          >
        }
      | undefined
  )?.store

  for (const node of currentFile.nodes) {
    const snap = snapshotStore?.[node.id]
    const config = typeof snap?.props?.config === 'string' ? snap.props.config : ''
    let compositeManifest = snap?.meta?.compositeManifest
    if (node.type === 'composite' && !compositeManifest && config) {
      try {
        const parsed = JSON.parse(config) as {
          manifest?: CompositeManifest
          capabilityId?: string
          version?: string
        }
        compositeManifest =
          parsed.manifest ??
          (parsed.capabilityId && parsed.version
            ? resolveCompositeManifest?.(parsed.capabilityId, parsed.version)
            : undefined)
      } catch {
        // ignore
      }
    }
    const existingPorts = {
      in: node.ports
        .filter((p) => p.dir === 'in')
        .map((p) => ({
          id: p.id,
          dir: 'in' as const,
          type: p.type,
          cardinality: p.cardinality,
          schema: p.schema
        })),
      out: node.ports
        .filter((p) => p.dir === 'out')
        .map((p) => ({
          id: p.id,
          dir: 'out' as const,
          type: p.type,
          cardinality: p.cardinality,
          schema: p.schema
        }))
    }
    simNodes.set(node.id, {
      type: node.type,
      config,
      exists: true,
      compositeManifest,
      existingPorts
    })
  }

  const simEdges = new Map<
    string,
    { from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; exists: boolean }
  >()
  for (const edge of currentFile.edges) {
    simEdges.set(edge.id, {
      from: { nodeId: edge.from.nodeId, portId: edge.from.portId },
      to: { nodeId: edge.to.nodeId, portId: edge.to.portId },
      exists: true
    })
  }

  const refToId = new Map<string, string>()
  const resolveId = (raw: string): string => refToId.get(raw) ?? raw

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]
    if (op.action === 'node.create') {
      let compositeManifest: CompositeManifest | undefined
      if (op.nodeType === 'composite') {
        const cfg = op.config as Record<string, unknown> | undefined
        if (cfg && typeof cfg.manifest === 'object' && cfg.manifest !== null) {
          compositeManifest = cfg.manifest as CompositeManifest
        } else if (cfg && typeof cfg.capabilityId === 'string' && typeof cfg.version === 'string') {
          compositeManifest = resolveCompositeManifest?.(cfg.capabilityId, cfg.version)
        }
        if (!compositeManifest) {
          return {
            ok: false,
            issue: {
              code: 'NODE_TYPE_INVALID',
              detail: `op[${index}]: composite node requires config { capabilityId, version }`
            }
          }
        }
      } else {
        const contract = nodeContract(op.nodeType)
        if (!contract || !contract.creatable) {
          return {
            ok: false,
            issue: {
              code: 'NODE_TYPE_INVALID',
              detail: `op[${index}]: nodeType '${op.nodeType}' is not creatable`
            }
          }
        }
      }
      const baseConfig = op.nodeType === 'composite' ? '' : (nodeContract(op.nodeType)?.initialConfig ?? '')
      const config = op.config ? mergePatchConfig(baseConfig, op.config) : baseConfig
      if (Buffer.byteLength(config, 'utf8') > GRAPH_NODE_CONFIG_MAX_BYTES) {
        return {
          ok: false,
          issue: { code: 'CONFIG_TOO_LARGE', detail: `op[${index}]: config exceeds 64KiB` }
        }
      }
      if (op.nodeType === 'code') {
        const errors = codePortConfigErrors(config)
        if (errors.length > 0) {
          return {
            ok: false,
            issue: {
              code: 'CONFIG_INVALID',
              detail: `op[${index}] (code): ${errors.join('；')}`.slice(0, 280)
            }
          }
        }
      }
      const id = op.ref ? `preview:${op.ref}` : `preview:node-${index}`
      if (op.ref) refToId.set(op.ref, id)
      simNodes.set(id, { type: op.nodeType, config, exists: true, compositeManifest })
      continue
    }

    if (op.action === 'node.duplicate') {
      const source = simNodes.get(resolveId(op.nodeId))
      if (!source || !source.exists) {
        return {
          ok: false,
          issue: { code: 'PATCH_REFERENCE_INVALID', detail: `op[${index}]:NODE_NOT_FOUND` }
        }
      }
      const id = op.ref ? `preview:${op.ref}` : `preview:dup-${index}`
      if (op.ref) refToId.set(op.ref, id)
      simNodes.set(id, { ...source, exists: true })
      continue
    }

    if (op.action === 'node.update') {
      const id = resolveId(op.nodeId)
      const node = simNodes.get(id)
      if (!node || !node.exists) {
        return {
          ok: false,
          issue: { code: 'PATCH_REFERENCE_INVALID', detail: `op[${index}]:NODE_NOT_FOUND` }
        }
      }
      if (op.config) {
        const nextConfig = mergePatchConfig(node.config, op.config)
        if (Buffer.byteLength(nextConfig, 'utf8') > GRAPH_NODE_CONFIG_MAX_BYTES) {
          return {
            ok: false,
            issue: { code: 'CONFIG_TOO_LARGE', detail: `op[${index}]: config exceeds 64KiB` }
          }
        }
        if (node.type === 'code') {
          const errors = codePortConfigErrors(nextConfig)
          if (errors.length > 0) {
            return {
              ok: false,
              issue: {
                code: 'CONFIG_INVALID',
                detail: `op[${index}] (code): ${errors.join('；')}`.slice(0, 280)
              }
            }
          }
        }
        node.config = nextConfig
      }
      continue
    }

    if (op.action === 'node.delete') {
      const id = resolveId(op.nodeId)
      const node = simNodes.get(id)
      if (node) {
        node.exists = false
        for (const edge of simEdges.values()) {
          if (edge.from.nodeId === id || edge.to.nodeId === id) edge.exists = false
        }
      }
      continue
    }

    if (op.action === 'edge.delete') {
      const edge = simEdges.get(op.edgeId)
      if (edge) edge.exists = false
      continue
    }

    if (op.action === 'edge.create') {
      const fromId = resolveId(op.from.nodeId)
      const toId = resolveId(op.to.nodeId)
      const fromNode = simNodes.get(fromId)
      const toNode = simNodes.get(toId)
      if (!fromNode?.exists || !toNode?.exists) {
        return {
          ok: false,
          issue: { code: 'PATCH_REFERENCE_INVALID', detail: `op[${index}]:NODE_NOT_FOUND` }
        }
      }
      const fromResolved = resolvePrecheckPorts(fromNode)
      const toResolved = resolvePrecheckPorts(toNode)
      const fromPort = fromResolved.out.find((p) => p.id === op.from.portId)
      const toPort = toResolved.in.find((p) => p.id === op.to.portId)
      if (!fromPort && fromResolved.strict) {
        const valid = fromResolved.out.map((p) => p.id).join(', ') || 'none'
        return {
          ok: false,
          issue: {
            code: 'EDGE_PORT_INVALID',
            detail: `op[${index}]: ${fromNode.type}.out has no port '${op.from.portId}' (valid: ${valid})`.slice(0, 280)
          }
        }
      }
      if (!toPort && toResolved.strict) {
        const valid = toResolved.in.map((p) => p.id).join(', ') || 'none'
        return {
          ok: false,
          issue: {
            code: 'EDGE_PORT_INVALID',
            detail: `op[${index}]: ${toNode.type}.in has no port '${op.to.portId}' (valid: ${valid})`.slice(0, 280)
          }
        }
      }
      if (fromPort && toPort) {
        if (
          !portPairCompatible(
            fromPort as Pick<PortDecl, 'type' | 'schema'>,
            toPort as Pick<PortDecl, 'type' | 'schema'>
          )
        ) {
          return {
            ok: false,
            issue: {
              code: 'EDGE_INCOMPATIBLE',
              detail: `op[${index}]: ${fromNode.type}.${fromPort.id}(${fromPort.type}) -> ${toNode.type}.${toPort.id}(${toPort.type}) incompatible`.slice(0, 280)
            }
          }
        }
        if (
          toPort.cardinality === 'one' &&
          [...simEdges.values()].some(
            (e) => e.exists && e.to.nodeId === toId && e.to.portId === toPort.id
          )
        ) {
          return {
            ok: false,
            issue: {
              code: 'EDGE_OCCUPIED',
              detail: `op[${index}]: ${toNode.type}.${toPort.id} accepts only one incoming edge`
            }
          }
        }
      }
      if (
        [...simEdges.values()].some(
          (e) =>
            e.exists &&
            e.from.nodeId === fromId &&
            e.from.portId === op.from.portId &&
            e.to.nodeId === toId &&
            e.to.portId === op.to.portId
        )
      ) {
        return {
          ok: false,
          issue: {
            code: 'EDGE_DUPLICATE',
            detail: `op[${index}]: duplicate edge ${op.from.nodeId}.${op.from.portId} -> ${op.to.nodeId}.${op.to.portId}`.slice(0, 280)
          }
        }
      }
      simEdges.set(`preview:edge-${index}`, {
        from: { nodeId: fromId, portId: op.from.portId },
        to: { nodeId: toId, portId: op.to.portId },
        exists: true
      })
    }
  }

  // 全图无环预检
  const adj = new Map<string, string[]>()
  for (const edge of simEdges.values()) {
    if (!edge.exists) continue
    const list = adj.get(edge.from.nodeId) ?? []
    list.push(edge.to.nodeId)
    adj.set(edge.from.nodeId, list)
  }
  const color = new Map<string, 1 | 2>()
  const hasCycle = (id: string): boolean => {
    const c = color.get(id)
    if (c === 2) return false
    if (c === 1) return true
    color.set(id, 1)
    for (const next of adj.get(id) ?? []) if (hasCycle(next)) return true
    color.set(id, 2)
    return false
  }
  for (const id of adj.keys()) {
    if (hasCycle(id)) {
      return {
        ok: false,
        issue: { code: 'EDGE_CYCLE', detail: 'graph patch introduces a cycle; use iterate node for loops' }
      }
    }
  }

  return { ok: true }
}

export interface GraphPatchPreviewNode {
  id: string
  type: string
  title: string
  text: string
  config: string
  contractVersion: number
  x: number
  y: number
}

export interface GraphPatchPreviewEdge {
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}

export interface GraphPatchPreviewSummary {
  nodeCreated: number
  nodeUpdated: number
  nodeDeleted: number
  edgeCreated: number
  edgeDeleted: number
}

/**
 * 方案 A：外部 Agent 全 34 节点 graph.patch 幽灵预览记录。
 * 复用既有 `flow_builds` 表（source='patch'），零数据库迁移，与 FlowGraph 预览共用同一幽灵渲染层与确认面板。
 */
export interface GraphPatchPreviewRecord {
  previewKind: 'patch'
  buildId: string
  projectId: string
  nodeId: string
  semanticRevision: string
  state: 'preview' | 'committed' | 'discarded'
  name: string
  expectedGraphVersion: number
  autoLayout: boolean
  ops: GraphPatchOp[]
  nodes: GraphPatchPreviewNode[]
  edges: GraphPatchPreviewEdge[]
  /** 拟修改的已有节点 ID 列表（画布叠加蓝色虚线高亮框）。 */
  updatedNodeIds: string[]
  /** 拟删除的已有节点 ID 列表（画布叠加红色删除高亮框）。 */
  deletedNodeIds: string[]
  summary: GraphPatchPreviewSummary
  createdAt: number
}

export function buildGraphPatchPreview(options: {
  projectId: string
  name?: string
  expectedGraphVersion: number
  autoLayout: boolean
  ops: GraphPatchOp[]
  currentFile: ProjectFile
}): GraphPatchPreviewRecord {
  const { projectId, expectedGraphVersion, autoLayout, ops, currentFile } = options
  const buildId = `patch:${randomUUID()}`
  const summary: GraphPatchPreviewSummary = {
    nodeCreated: 0,
    nodeUpdated: 0,
    nodeDeleted: 0,
    edgeCreated: 0,
    edgeDeleted: 0
  }

  const refToPreviewId = new Map<string, string>()
  const nodes: GraphPatchPreviewNode[] = []
  const edges: GraphPatchPreviewEdge[] = []
  const updatedNodeIdSet = new Set<string>()
  const deletedNodeIdSet = new Set<string>()

  for (const [index, op] of ops.entries()) {
    if (op.action === 'node.create') {
      summary.nodeCreated += 1
      const id = op.ref ? `preview:${op.ref}` : `preview:node-${index}`
      if (op.ref) refToPreviewId.set(op.ref, id)
      nodes.push({
        id,
        type: op.nodeType,
        title: op.title?.trim() || op.nodeType,
        text: (op.text ?? '').slice(0, 120),
        config: op.config ? JSON.stringify(op.config) : '',
        contractVersion: 1,
        x: op.x,
        y: op.y
      })
    } else if (op.action === 'node.duplicate') {
      summary.nodeCreated += 1
      const source = currentFile.nodes.find((n) => n.id === op.nodeId)
      const snapshotStore = (
        currentFile.tldrawSnapshot as { store?: Record<string, { x?: number; y?: number }> } | undefined
      )?.store
      const snap = snapshotStore?.[op.nodeId]
      const id = op.ref ? `preview:${op.ref}` : `preview:dup-${index}`
      if (op.ref) refToPreviewId.set(op.ref, id)
      nodes.push({
        id,
        type: source?.type ?? 'text',
        title: op.title?.trim() || (source?.title ? `${source.title} 副本` : '节点副本'),
        text: '',
        config: '',
        contractVersion: source?.contractVersion ?? 1,
        x: (typeof snap?.x === 'number' ? snap.x : 0) + (op.dx ?? 40),
        y: (typeof snap?.y === 'number' ? snap.y : 0) + (op.dy ?? 40)
      })
    } else if (
      op.action === 'node.update' ||
      op.action === 'chat.patch' ||
      op.action === 'node.select-result'
    ) {
      summary.nodeUpdated += 1
      if (!refToPreviewId.has(op.nodeId)) updatedNodeIdSet.add(op.nodeId)
    } else if (op.action === 'node.delete') {
      summary.nodeDeleted += 1
      updatedNodeIdSet.delete(op.nodeId)
      deletedNodeIdSet.add(op.nodeId)
    } else if (op.action === 'edge.create') {
      summary.edgeCreated += 1
      const fromId = refToPreviewId.get(op.from.nodeId) ?? op.from.nodeId
      const toId = refToPreviewId.get(op.to.nodeId) ?? op.to.nodeId
      edges.push({
        from: { nodeId: fromId, portId: op.from.portId },
        to: { nodeId: toId, portId: op.to.portId }
      })
    } else if (op.action === 'edge.delete') {
      summary.edgeDeleted += 1
    }
  }

  // 若启用 autoLayout 且本批新建了多个节点，用共享 layoutGraph 给出清晰预览位置。
  if (autoLayout && nodes.length >= 2) {
    const layout = layoutGraph(
      nodes.map((node) => ({
        id: node.id,
        type: node.type,
        x: node.x,
        y: node.y,
        w: 340,
        h: 300,
        title: node.title
      })),
      edges
        .filter(
          (edge) =>
            nodes.some((n) => n.id === edge.from.nodeId) &&
            nodes.some((n) => n.id === edge.to.nodeId)
        )
        .map((edge) => ({ from: edge.from.nodeId, to: edge.to.nodeId })),
      'flow',
      {
        origin: {
          x: Math.min(...nodes.map((n) => n.x)),
          y: Math.min(...nodes.map((n) => n.y))
        }
      }
    )
    const posMap = new Map(layout.positions.map((pos) => [pos.id, pos]))
    for (const node of nodes) {
      const pos = posMap.get(node.id)
      if (pos) {
        node.x = pos.x
        node.y = pos.y
      }
    }
  }

  const defaultNameParts: string[] = []
  if (summary.nodeCreated > 0) defaultNameParts.push(`+${summary.nodeCreated} 节点`)
  if (summary.nodeUpdated > 0) defaultNameParts.push(`改 ${summary.nodeUpdated} 节点`)
  if (summary.nodeDeleted > 0) defaultNameParts.push(`删 ${summary.nodeDeleted} 节点`)
  if (summary.edgeCreated > 0) defaultNameParts.push(`+${summary.edgeCreated} 连线`)
  if (summary.edgeDeleted > 0) defaultNameParts.push(`删 ${summary.edgeDeleted} 连线`)

  return {
    previewKind: 'patch',
    buildId,
    projectId,
    nodeId: buildId,
    semanticRevision: `graph-v${expectedGraphVersion}`,
    state: 'preview',
    name: options.name?.trim() || `外部画布变更（${defaultNameParts.join(' · ') || `${ops.length} 项`}）`,
    expectedGraphVersion,
    autoLayout,
    ops,
    nodes,
    edges,
    updatedNodeIds: [...updatedNodeIdSet],
    deletedNodeIds: [...deletedNodeIdSet],
    summary,
    createdAt: Date.now()
  }
}

export function saveGraphPatchPreview(db: Database.Database, record: GraphPatchPreviewRecord): void {
  db.prepare(
    `INSERT INTO flow_builds(project_id, node_id, build_id, body_json, source)
     VALUES (?, ?, ?, ?, 'patch')
     ON CONFLICT(project_id, build_id) DO UPDATE SET body_json = excluded.body_json, source = 'patch'`
  ).run(record.projectId, record.nodeId, record.buildId, JSON.stringify(record))
}

export function getGraphPatchPreview(
  db: Database.Database,
  projectId: string,
  previewId: string
): GraphPatchPreviewRecord | null {
  const row = db
    .prepare(
      `SELECT body_json FROM flow_builds WHERE project_id = ? AND build_id = ? AND source = 'patch'`
    )
    .get(projectId, previewId) as { body_json: string } | undefined
  if (!row) return null
  return JSON.parse(row.body_json) as GraphPatchPreviewRecord
}

export function listGraphPatchPreviews(
  db: Database.Database,
  projectId: string
): GraphPatchPreviewRecord[] {
  const rows = db
    .prepare(
      `SELECT body_json FROM flow_builds WHERE project_id = ? AND source = 'patch' ORDER BY rowid DESC`
    )
    .all(projectId) as Array<{ body_json: string }>
  return rows.map((row) => JSON.parse(row.body_json) as GraphPatchPreviewRecord)
}

export function updateGraphPatchPreviewState(
  db: Database.Database,
  projectId: string,
  previewId: string,
  state: 'committed' | 'discarded'
): GraphPatchPreviewRecord | null {
  const existing = getGraphPatchPreview(db, projectId, previewId)
  if (!existing) return null
  if (existing.state === 'committed' && state === 'discarded') return existing
  const updated: GraphPatchPreviewRecord = { ...existing, state }
  saveGraphPatchPreview(db, updated)
  return updated
}
