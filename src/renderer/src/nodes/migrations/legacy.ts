/**
 * 旧项目契约迁移与检查（路线图 R0 / WP2）。
 *
 * 本模块把原先内嵌在 CanvasEditor.handleMount 中的四段迁移逻辑抽取为纯函数，
 * 使其可测试、可在打开项目前预检、可在不依赖 editor 实例的情况下推断结果。
 *
 * 设计原则：不静默猜测，也不静默删数据。未知内容保留原样 + 冻结 + 显式警告。
 */
import type { TLShape, TLShapeId } from 'tldraw'
import type { CanvasNode, ProjectFile } from '@shared/types'
import { getNodeType, needsNodeSizeMigration } from '../registry'

// ── 迁移计划 ──

/** 对单个 shape 的更新指令 */
export interface ShapeUpdate {
  id: TLShapeId
  type: 'node-card'
  props: Record<string, unknown>
}

/** 旧分组 → 原生分组的操作指令 */
export interface GroupMigrationOp {
  memberIds: TLShapeId[]
}

/** 迁移计划的完整输出 */
export interface LegacyMigrationResult {
  /** 需要更新的 shape 列表（节点类型变更、尺寸修正） */
  shapeUpdates: ShapeUpdate[]
  /** 需要删除的 shape ID（退役节点：compose、旧 group） */
  deletions: TLShapeId[]
  /** 旧分组 → 原生分组的操作 */
  groupOps: GroupMigrationOp[]
  /** 用户可见的迁移摘要消息 */
  warnings: string[]
}

/**
 * 分析当前画布 shapes，产出旧节点迁移计划。纯函数：不触碰 editor，不产生副作用。
 *
 * 覆盖四段迁移：
 * 1. image → image-gen（有生成配置或无媒体的旧图片节点）
 * 2. compose 退役（直接标记删除）
 * 3. group 退役（提取成员关系输出分组指令 + 删除旧卡片）
 * 4. 尺寸规范化（旧默认尺寸或异常超大节点调整到 spec.defaultSize）
 */
export function planLegacyMigrations(shapes: TLShape[]): LegacyMigrationResult {
  const result: LegacyMigrationResult = {
    shapeUpdates: [],
    deletions: [],
    groupOps: [],
    warnings: []
  }

  // 收集所有 node-card 的 ID，供 group 成员校验使用
  const nodeCardIds = new Set<string>()
  for (const shape of shapes) {
    if (shape.type === 'node-card') nodeCardIds.add(shape.id as string)
  }

  // 跟踪迁移后的"虚拟"nodeType，供后续尺寸检查使用正确的 spec
  const effectiveNodeType = new Map<string, string>()
  for (const shape of shapes) {
    if (shape.type === 'node-card') {
      effectiveNodeType.set(shape.id as string, (shape.props as { nodeType: string }).nodeType)
    }
  }

  // ── 1. image → image-gen ──
  let imageGenCount = 0
  for (const shape of shapes) {
    if (shape.type !== 'node-card') continue
    const props = shape.props as {
      nodeType: string
      title: string
      text: string
      mediaPath: string
    }
    if (props.nodeType !== 'image') continue
    let hasPromptConfig = false
    try {
      const value = JSON.parse(props.text) as { prompt?: unknown }
      hasPromptConfig = typeof value.prompt === 'string'
    } catch {
      // 空或普通资产文字不代表生图配置
    }
    if (!hasPromptConfig && props.mediaPath) continue
    result.shapeUpdates.push({
      id: shape.id,
      type: 'node-card',
      props: {
        nodeType: 'image-gen',
        title: props.title === '图片' ? '生图' : props.title
      }
    })
    effectiveNodeType.set(shape.id as string, 'image-gen')
    imageGenCount++
  }
  if (imageGenCount > 0) {
    result.warnings.push(`已将 ${imageGenCount} 个旧图片生成节点迁移为"生图"`)
  }

  // ── 2 + 3. compose 退役 / group 退役 ──
  let groupCount = 0
  for (const shape of shapes) {
    if (shape.type !== 'node-card') continue
    const props = shape.props as { nodeType: string; text: string }
    if (props.nodeType === 'compose') {
      result.deletions.push(shape.id)
      continue
    }
    if (props.nodeType !== 'group') continue
    try {
      const parsed = JSON.parse(props.text) as { memberIds?: unknown }
      const memberIds = Array.isArray(parsed.memberIds)
        ? (parsed.memberIds as unknown[]).filter(
            (id): id is TLShapeId => typeof id === 'string' && nodeCardIds.has(id)
          )
        : []
      if (memberIds.length >= 2) {
        result.groupOps.push({ memberIds })
        groupCount++
      }
    } catch {
      // 损坏的旧分组不阻断项目打开
    }
    result.deletions.push(shape.id)
  }
  if (groupCount > 0) {
    result.warnings.push(`已将 ${groupCount} 个旧分组迁移为画布分组状态`)
  }

  // ── 4. 尺寸规范化（使用迁移后的 effectiveNodeType）──
  let sizeCount = 0
  for (const shape of shapes) {
    if (shape.type !== 'node-card') continue
    // 跳过已标记删除的节点
    if (result.deletions.includes(shape.id)) continue
    const props = shape.props as { nodeType: string; w: number; h: number }
    const nodeType = effectiveNodeType.get(shape.id as string) ?? props.nodeType
    const spec = getNodeType(nodeType)
    if (!spec || !needsNodeSizeMigration(nodeType, props.w, props.h)) continue
    result.shapeUpdates.push({
      id: shape.id,
      type: 'node-card',
      props: { w: spec.defaultSize.w, h: spec.defaultSize.h }
    })
    sizeCount++
  }
  if (sizeCount > 0) {
    result.warnings.push(`已将 ${sizeCount} 个旧节点调整为标准尺寸`)
  }

  return result
}

// ── 项目预检 ──

export type WarningLevel = 'error' | 'warn' | 'info'

/** 单条项目警告 */
export interface ProjectWarning {
  level: WarningLevel
  nodeId?: string
  nodeType?: string
  portId?: string
  edgeId?: string
  message: string
  suggestion?: string
}

/** 已退役但会被 planLegacyMigrations 处理（删除/转换）的旧类型，预检时跳过避免误报 */
const RETIRED_HANDLED_TYPES = new Set(['compose', 'group'])

function isRetiredHandled(node: CanvasNode): boolean {
  return RETIRED_HANDLED_TYPES.has(node.type)
}

/**
 * 预检项目文件：检测未知 nodeType、边引用不存在的 portId、高于当前注册表的
 * contractVersion、以及非 v1 文件版本。纯函数，不修改原数据。
 */
export function inspectProjectFile(file: ProjectFile): ProjectWarning[] {
  const warnings: ProjectWarning[] = []

  // 1. 文件版本
  if (file.version !== 1) {
    warnings.push({
      level: 'error',
      message: `项目文件版本为 v${String(file.version)}，当前应用期望 v1`,
      suggestion: '请使用匹配版本的编辑器打开此项目'
    })
  }

  // 构建节点查找表，并为已知类型提取当前 spec 的端口集合
  const nodeMap = new Map<string, CanvasNode>()
  /** nodeId → 当前 spec 的端口 ID 集合（dir:id 格式） */
  const currentPortKeys = new Map<string, Set<string>>()

  for (const node of file.nodes) {
    nodeMap.set(node.id, node)
    const spec = getNodeType(node.type)
    if (spec) {
      const keys = new Set<string>()
      for (const p of spec.ports.in) keys.add(`in:${p.id}`)
      for (const p of spec.ports.out) keys.add(`out:${p.id}`)
      currentPortKeys.set(node.id, keys)
    }
  }

  // 2. 检查每个节点
  for (const node of file.nodes) {
    const spec = getNodeType(node.type)

    // 已退役旧类型由 planLegacyMigrations 处理，迁移 toast 已覆盖，不重复警告
    if (!spec && isRetiredHandled(node)) continue

    // 未知 nodeType
    if (!spec) {
      warnings.push({
        level: 'warn',
        nodeId: node.id,
        nodeType: node.type,
        message: `节点类型 "${node.type}"（${node.title}）未注册，可能来自更高版本或已移除的节点`,
        suggestion: '该节点将显示为冻结占位，不参与运行；可右键删除'
      })
      continue
    }

    // contractVersion 高于当前注册表
    if (node.contractVersion > spec.contractVersion) {
      warnings.push({
        level: 'warn',
        nodeId: node.id,
        nodeType: node.type,
        message: `节点"${node.title}"的契约版本 v${String(node.contractVersion)} 高于当前注册的 v${String(spec.contractVersion)}`,
        suggestion: '部分端口可能不兼容，请检查连线'
      })
    }
  }

  // 3. 检查边引用的端口是否存在
  for (const edge of file.edges) {
    const fromNode = nodeMap.get(edge.from.nodeId)
    const toNode = nodeMap.get(edge.to.nodeId)

    // 引用不存在的节点
    if (!fromNode) {
      warnings.push({
        level: 'error',
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
        message: `连线引用了不存在的来源节点 ${edge.from.nodeId}`,
        suggestion: '该连线将被清理'
      })
    }
    if (!toNode) {
      warnings.push({
        level: 'error',
        edgeId: edge.id,
        nodeId: edge.to.nodeId,
        message: `连线引用了不存在的目标节点 ${edge.to.nodeId}`,
        suggestion: '该连线将被清理'
      })
    }

    // 引用当前 spec 中不存在的端口（仅在节点类型已知时检查）
    const fromPorts = currentPortKeys.get(edge.from.nodeId)
    if (fromNode && fromPorts && !fromPorts.has(`out:${edge.from.portId}`)) {
      warnings.push({
        level: 'warn',
        edgeId: edge.id,
        nodeId: edge.from.nodeId,
        portId: edge.from.portId,
        message: `节点"${fromNode.title}"的输出端口 "${edge.from.portId}" 在当前版本中不存在`,
        suggestion: '该连线将被冻结标记，不参与运行'
      })
    }
    const toPorts = currentPortKeys.get(edge.to.nodeId)
    if (toNode && toPorts && !toPorts.has(`in:${edge.to.portId}`)) {
      warnings.push({
        level: 'warn',
        edgeId: edge.id,
        nodeId: edge.to.nodeId,
        portId: edge.to.portId,
        message: `节点"${toNode.title}"的输入端口 "${edge.to.portId}" 在当前版本中不存在`,
        suggestion: '该连线将被冻结标记，不参与运行'
      })
    }
  }

  return warnings
}
