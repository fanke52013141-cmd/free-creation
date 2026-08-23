import { createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { parseMessages } from './types'
import { getNodeDefinition, getShapeOutputKinds, type PortDefinition, type ValueKind } from './nodeDefinitions'
export type { ValueKind } from './nodeDefinitions'

export interface DependencyMeta {
  kind: 'data-dependency'
  version: 1
  sourceId: string
  targetId: string
  targetPort: string
  valueKind: ValueKind
}

const INPUT_REF_FIELDS: Record<string, Record<string, string>> = {
  'chat-node': { context: 'contextRef' },
  'one-shot': { input: 'inputRef' },
  split: { text: 'inputRef' },
  merge: { items: 'inputRef' },
  'image-gen': { prompt: 'promptRef', references: 'referenceRef' },
  'video-gen': { prompt: 'promptRef', references: 'referenceRef' },
}

export function getOutputKind(shape: TLShape): ValueKind | null {
  return getShapeOutputKinds(shape)[0] ?? null
}

export function getInputPort(nodeType: string, portName: string): PortDefinition | undefined {
  return getNodeDefinition(nodeType)?.inputs.find((port) => port.name === portName)
}

export function getNodeInputRefs(shape: TLShape): Array<{ port: string; sourceId: string }> {
  const fields = INPUT_REF_FIELDS[shape.type]
  if (!fields) return []
  return Object.entries(fields)
    .map(([port, field]) => ({ port, sourceId: (shape.props as Record<string, unknown>)[field] }))
    .filter((input): input is { port: string; sourceId: string } => typeof input.sourceId === 'string' && Boolean(input.sourceId))
}

export function isCompatible(source: TLShape, targetType: string, targetPort: string): boolean {
  const output = getOutputKind(source)
  const input = getInputPort(targetType, targetPort)
  return Boolean(output && input?.kinds.includes(output))
}

export function getCompatibleSources(editor: Editor, targetType: string, targetPort: string, targetId: TLShapeId) {
  return editor
    .getCurrentPageShapes()
    .filter((shape) => shape.id !== targetId && isCompatible(shape, targetType, targetPort))
}

export function describeSource(shape: TLShape): string {
  if (shape.type === 'text-asset') {
    const text = (shape.props as { text?: string }).text?.trim() ?? ''
    return `文本资产：${text.slice(0, 24) || '（空）'}`
  }
  if (shape.type === 'chat-node') {
    return `聊天节点：${(shape.props as { title?: string }).title || '未命名'}`
  }
  if (shape.type === 'one-shot') {
    return `单次处理：${(shape.props as { title?: string }).title || '未命名'}`
  }
  if (shape.type === 'split') return 'Split 拆分结果'
  if (shape.type === 'merge') return 'Merge 合并结果'
  if (shape.type === 'image-asset') {
    return `图片资产：${(shape.props as { title?: string }).title || '未命名图片'}`
  }
  if (shape.type === 'image-gen') {
    return `图片生成：${(shape.props as { title?: string }).title || '未命名'}`
  }
  if (shape.type === 'video-gen') {
    return `视频生成：${(shape.props as { title?: string }).title || '未命名'}`
  }
  return shape.type
}

export function getTextValue(shape: TLShape): string | string[] {
  switch (shape.type) {
    case 'text-asset':
      return (shape.props as { text?: string }).text?.trim() ?? ''
    case 'chat-node': {
      const messages = parseMessages((shape.props as { messagesJson?: string }).messagesJson ?? '')
      return messages.map((message) => `${message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统'}：${message.content}`).join('\n\n').trim()
    }
    case 'one-shot': {
      const outputItems = shape.meta.outputItems
      if (Array.isArray(outputItems)) return outputItems.filter((item): item is string => typeof item === 'string')
      return (shape.props as { outputText?: string }).outputText?.trim() ?? ''
    }
    case 'merge':
      return (shape.props as { outputText?: string }).outputText?.trim() ?? ''
    case 'split': {
      const json = (shape.props as { itemsJson?: string }).itemsJson ?? '[]'
      try {
        const items: unknown = JSON.parse(json)
        return Array.isArray(items) ? items.filter((item): item is string => typeof item === 'string') : []
      } catch {
        return []
      }
    }
    default:
      return ''
  }
}

export function getImageUrls(shape: TLShape): string[] {
  if (shape.type === 'image-asset') {
    const url = (shape.props as { sourceUrl?: string }).sourceUrl?.trim()
    return url ? [url] : []
  }
  if (shape.type === 'image-gen') {
    try {
      const urls: unknown = JSON.parse((shape.props as { resultUrlsJson?: string }).resultUrlsJson ?? '[]')
      return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === 'string' && Boolean(url)) : []
    } catch {
      return []
    }
  }
  return []
}

export function getVideoUrls(shape: TLShape): string[] {
  if (shape.type !== 'video-gen') return []
  try {
    const urls: unknown = JSON.parse((shape.props as { resultUrlsJson?: string }).resultUrlsJson ?? '[]')
    return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === 'string' && Boolean(url)) : []
  } catch {
    return []
  }
}

export function getDependencyMeta(shape: TLShape): DependencyMeta | null {
  if (shape.type !== 'arrow') return null
  const candidate = (shape.meta as { dependency?: unknown }).dependency
  if (!candidate || typeof candidate !== 'object') return null
  const dependency = candidate as Partial<DependencyMeta>
  if (
    dependency.kind !== 'data-dependency' ||
    dependency.version !== 1 ||
    typeof dependency.sourceId !== 'string' ||
    typeof dependency.targetId !== 'string' ||
    typeof dependency.targetPort !== 'string' ||
    typeof dependency.valueKind !== 'string'
  ) {
    return null
  }
  return dependency as DependencyMeta
}

function updateRunState(editor: Editor, shape: TLShape, runState: 'dirty' | 'error', lastError = '') {
  const props = shape.props as Record<string, unknown>
  if (typeof props.runState !== 'string') return
  editor.updateShape({ id: shape.id, type: shape.type, props: { runState, lastError } } as never)
}

/** Mark a node and every data-dependent descendant stale without automatically running them. */
export function markNodeAndDependentsDirty(editor: Editor, nodeId: string, includeNode = true) {
  const shapes = editor.getCurrentPageShapes()
  const edges = shapes.map(getDependencyMeta).filter((edge): edge is DependencyMeta => Boolean(edge))
  const queue = includeNode ? [nodeId] : edges.filter((edge) => edge.sourceId === nodeId).map((edge) => edge.targetId)
  const seen = new Set<string>()
  while (queue.length) {
    const currentId = queue.shift()!
    if (seen.has(currentId)) continue
    seen.add(currentId)
    const current = editor.getShape(currentId as TLShapeId)
    if (current) updateRunState(editor, current, 'dirty')
    queue.push(...edges.filter((edge) => edge.sourceId === currentId).map((edge) => edge.targetId))
  }
}

function wouldCreateCycle(editor: Editor, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true
  const adjacency = new Map<string, string[]>()
  for (const shape of editor.getCurrentPageShapes()) {
    const edge = getDependencyMeta(shape)
    if (!edge) continue
    const targets = adjacency.get(edge.sourceId) ?? []
    targets.push(edge.targetId)
    adjacency.set(edge.sourceId, targets)
  }
  const seen = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (nodeId === sourceId) return true
    if (seen.has(nodeId)) return false
    seen.add(nodeId)
    return (adjacency.get(nodeId) ?? []).some(visit)
  }
  return visit(targetId)
}

/**
 * 数据依赖以“目标节点的输入引用 + 绑定箭头”成对保存。
 * 箭头被锁定，用户只能通过节点输入设置变更依赖，避免出现删线但仍读取数据的假象。
 */
export function replaceDataDependency(
  editor: Editor,
  target: TLShape,
  targetPort: string,
  sourceId: string,
  updateTargetInput: (source: string) => void,
) {
  const staleArrows = editor
    .getCurrentPageShapes()
    .filter((shape) => {
      const dependency = getDependencyMeta(shape)
      return dependency?.targetId === target.id && dependency.targetPort === targetPort
    })

  if (!sourceId) {
    if (staleArrows.length) editor.deleteShapes(staleArrows.map((shape) => shape.id))
    updateTargetInput('')
    return
  }

  const source = editor.getShape(sourceId as TLShapeId)
  if (!source || !isCompatible(source, target.type, targetPort)) {
    updateRunState(editor, target, 'error', '该输出与目标输入端口不兼容')
    return false
  }
  if (wouldCreateCycle(editor, source.id, target.id)) {
    updateRunState(editor, target, 'error', '不能建立环路依赖：请移除会回流到当前节点的上游连接')
    return false
  }

  if (staleArrows.length) editor.deleteShapes(staleArrows.map((shape) => shape.id))
  const arrowId = createShapeId()
  const dependency: DependencyMeta = {
    kind: 'data-dependency',
    version: 1,
    sourceId: source.id,
    targetId: target.id,
    targetPort,
    valueKind: getOutputKind(source)!,
  }

  editor.createShape({
    id: arrowId,
    type: 'arrow',
    x: 0,
    y: 0,
    isLocked: true,
    meta: { dependency },
    props: {
      color: 'blue',
      size: 's',
      arrowheadEnd: 'arrow',
    },
  } as never)
  editor.createBindings([
    {
      type: 'arrow',
      fromId: arrowId,
      toId: source.id,
      props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
    },
    {
      type: 'arrow',
      fromId: arrowId,
      toId: target.id,
      props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
    },
  ] as never)
  updateTargetInput(source.id)
  markNodeAndDependentsDirty(editor, target.id)
  return true
}
