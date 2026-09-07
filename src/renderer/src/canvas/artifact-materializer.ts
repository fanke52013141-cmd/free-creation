import { createShapeId, type Editor } from 'tldraw'
import type { ProducedArtifact } from '@shared/engine/executor-types'
import { getNodeType } from '../nodes/registry'
import type { NodeCardProps, NodeCardShape } from './NodeCardShape'

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
  const assetNodeType = artifact.kind === 'video' ? 'video-asset' : artifact.kind
  const spec = getNodeType(assetNodeType)
  if (!spec) return
  const siblings = editor
    .getCurrentPageShapes()
    .filter(
      (shape) =>
        shape.type === 'node-card' &&
        (shape.meta as Record<string, unknown> | undefined)?.artifactProducerId === producer.id
    ).length
  const column = siblings % 3
  const row = Math.floor(siblings / 3)
  const gap = 28
  const id = createShapeId()
  editor.createShape({
    id,
    type: 'node-card',
    x: producer.x + producer.props.w + 96 + column * (spec.defaultSize.w + gap),
    y: producer.y + row * (spec.defaultSize.h + gap),
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
