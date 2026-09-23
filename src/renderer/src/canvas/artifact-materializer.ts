import { createShapeId, type Editor } from 'tldraw'
import type { ProducedArtifact } from '@shared/engine/executor-types'
import { getNodeType } from '../nodes/registry'
import type { NodeCardProps, NodeCardShape } from './NodeCardShape'

import { parseImageSplitConfig } from '@shared/image-split'
import { readNodeConfig } from '@shared/engine/node-config'
import { assetNodeTypeFor } from './asset-node-type'

/**
 * 运行产物的唯一落点：创建独立、不可变的资产节点，并在 meta 中保存生产关系。
 * 生产关系不是数据边，不能影响 DAG 排序或导致拆图结果重复执行。
 */
export function materializeArtifact(
  editor: Editor,
  producer: NodeCardShape,
  artifact: ProducedArtifact,
  runId?: string
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
  editor.createShape({
    id,
    type: 'node-card',
    x: producer.x + producer.props.w + 100 + column * (spec.defaultSize.w + gapX),
    y: producer.y + row * (spec.defaultSize.h + gapY),
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
      artifactProducerId: producer.id,
      artifactProducerPortId: artifact.portId,
      artifactRunId: runId,
      artifactCreatedAt: Date.now()
    }
  })
}
