import { createShapeId, type Editor } from 'tldraw'
import type { ProducedArtifact } from '@shared/engine/executor-types'
import { getNodeType } from '../nodes/registry'
import type { NodeCardProps, NodeCardShape } from './NodeCardShape'

import { parseImageSplitConfig } from '@shared/image-split'
import { readNodeConfig } from '@shared/engine/node-config'
import { assetNodeTypeFor } from './asset-node-type'
import type { NodeValue } from '@shared/engine/values'

/** Keep the normal layout when visible, otherwise choose the nearest free viewport slot. */
function visibleArtifactPosition(
  editor: Editor,
  preferred: { x: number; y: number },
  { w, h }: { w: number; h: number }
): { x: number; y: number } {
  const viewport = editor.getViewportPageBounds?.()
  if (!viewport) return preferred
  const margin = 24
  const left = viewport.x + margin
  const top = viewport.y + margin
  const right = viewport.x + viewport.w - margin - w
  const bottom = viewport.y + viewport.h - margin - h
  if (right < left || bottom < top) return preferred
  if (preferred.x >= left && preferred.x <= right && preferred.y >= top && preferred.y <= bottom)
    return preferred

  const occupied = editor.getCurrentPageShapes()
    .filter((shape) => shape.type === 'node-card')
    .map((shape) => editor.getShapePageBounds(shape.id))
    .filter((bounds) => bounds && bounds.x < right + w && bounds.x + bounds.w > left &&
      bounds.y < bottom + h && bounds.y + bounds.h > top)
  const xs = [left, right, Math.max(left, Math.min(right, preferred.x))]
  const ys = [top, bottom, Math.max(top, Math.min(bottom, preferred.y))]
  for (const bounds of occupied) {
    if (!bounds) continue
    xs.push(bounds.x - w - margin, bounds.x + bounds.w + margin)
    ys.push(bounds.y - h - margin, bounds.y + bounds.h + margin)
  }
  let nearest = preferred
  let distance = Infinity
  for (const x of xs) {
    if (x < left || x > right) continue
    for (const y of ys) {
      if (y < top || y > bottom) continue
      const offset = (x - preferred.x) ** 2 + (y - preferred.y) ** 2
      if (offset >= distance || occupied.some((bounds) => bounds &&
        x < bounds.x + bounds.w && x + w > bounds.x &&
        y < bounds.y + bounds.h && y + h > bounds.y)) continue
      nearest = { x, y }
      distance = offset
    }
  }
  return nearest
}

/** Document results use the same provenance relation as media; no implicit DAG edges. */
export function materializeDocumentArtifact(
  editor: Editor,
  producer: NodeCardShape,
  portId: string,
  value: NodeValue,
  runId: string
): void {
  if (value.kind !== 'text' && value.kind !== 'markdown' && value.kind !== 'json') {
    throw new Error('该输出类型不支持文档产物')
  }
  const nodeType = value.kind === 'json' ? 'json' : 'text'
  const spec = getNodeType(nodeType)
  if (!spec) throw new Error('文档产物节点尚未注册')
  const text = value.kind === 'json' ? JSON.stringify(value.data, null, 2) : value.text
  const siblings = editor
    .getCurrentPageShapes()
    .filter(
      (shape) => shape.type === 'node-card' && shape.meta.artifactProducerId === producer.id
    ).length
  const position = visibleArtifactPosition(editor, {
    x: producer.x + producer.props.w + 100 + (siblings % 3) * (spec.defaultSize.w + 80),
    y: producer.y + Math.floor(siblings / 3) * (spec.defaultSize.h + 80)
  }, spec.defaultSize)
  editor.createShape({
    id: createShapeId(),
    type: 'node-card',
    ...position,
    props: {
      nodeType,
      title: `${producer.props.title || 'AI 处理'} · ${value.kind === 'json' ? 'JSON' : '文本'}结果`,
      text,
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    },
    meta: {
      artifactProducerId: producer.id,
      artifactProducerPortId: portId,
      artifactRunId: runId,
      runGroupId: runId,
      artifactCreatedAt: Date.now(),
      artifactDocumentKind: value.kind
    }
  })
}

/**
 * 运行产物的唯一落点：创建独立、不可变的资产节点，并在 meta 中保存生产关系。
 * 生产关系不是数据边，不能影响 DAG 排序或导致拆图结果重复执行。
 */
export function materializeArtifact(
  editor: Editor,
  producer: NodeCardShape,
  artifact: ProducedArtifact,
  runId?: string,
  options?: {
    /** 覆盖落点（循环泳道等运行投影排布）。 */
    position?: { x: number; y: number }
    /** 覆盖溯源父节点（泳道内产物挂在提示词卡下，真实生产节点另存 extraMeta）。 */
    producerId?: string
    producerPortId?: string
    extraMeta?: Record<string, unknown>
  }
): void {
  const assetNodeType = assetNodeTypeFor(artifact.kind)
  const spec = getNodeType(assetNodeType)
  if (!spec) return
  const siblings = editor
    .getCurrentPageShapes()
    .filter(
      (shape) =>
        shape.type === 'node-card' &&
        (shape.meta as Record<string, unknown> | undefined)?.artifactProducerId === producer.id
    ).length
  // 宫格拆分产物按拆分列数与行数精准排布（如 2×2 排 2 列 2 排，3×3 排 3 列 3 排），不再死板地写死 3 列。
  let cols = artifact.layoutColumns === 2 ? 2 : 3
  if (producer.props.nodeType === 'image-split') {
    const splitConfig = parseImageSplitConfig(readNodeConfig(producer))
    cols = Math.max(1, splitConfig.columns || 3)
  }
  const column = siblings % cols
  const row = Math.floor(siblings / cols)
  const gapX = 80
  // 悬浮标题向上伸出 34px，行间距预留足够空间（80px）确保上一张卡片底部与下一张卡片顶部标题不拥挤
  const gapY = 80
  const id = createShapeId()
  const position = options?.position ?? visibleArtifactPosition(editor, {
    x: producer.x + producer.props.w + 100 + column * (spec.defaultSize.w + gapX),
    y: producer.y + row * (spec.defaultSize.h + gapY)
  }, spec.defaultSize)
  editor.createShape({
    id,
    type: 'node-card',
    x: position.x,
    y: position.y,
    props: {
      nodeType: assetNodeType,
      title: artifact.title || `${producer.props.title || '运行'}的产物`,
      mediaId: artifact.mediaId,
      mediaPath: artifact.mediaPath,
      mediaMime: artifact.mime,
      w: spec.defaultSize.w,
      h: spec.defaultSize.h
    } satisfies Partial<NodeCardProps>,
    meta: {
      artifactProducerId: options?.producerId ?? producer.id,
      artifactProducerPortId: options?.producerPortId ?? artifact.portId,
      artifactRunId: runId,
      runGroupId: runId,
      artifactCreatedAt: Date.now(),
      ...(options?.extraMeta ?? {})
    }
  })
}
