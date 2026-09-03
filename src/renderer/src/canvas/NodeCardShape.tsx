// NodeCard tldraw 自定义形状：所有节点类型的统一卡片容器
import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from '@tldraw/tlschema'
import { BaseBoxShapeUtil, T, type RecordProps, type TLBaseShape } from 'tldraw'
import { NodeCardView } from './NodeCardView'

// 声明合并：把 node-card 并入 tldraw 的 TLShape 联合类型（官方扩展点）
declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    'node-card': NodeCardProps
  }
}

export interface NodeCardProps {
  w: number
  h: number
  nodeType: string
  title: string
  /** 节点固定配置。与用户正文 text、运行记录和运行结果严格分离。 */
  config: string
  text: string
  mediaId: string
  mediaPath: string
  mediaMime: string
  exec: string
}

export type NodeCardShape = TLBaseShape<'node-card', NodeCardProps>

const nodeCardMigrationIds = createShapePropsMigrationIds('node-card', {
  addStructuredConfig: 1
})

export class NodeCardUtil extends BaseBoxShapeUtil<NodeCardShape> {
  static override type = 'node-card' as const
  /**
   * tldraw 将自定义形状的持久化 schema 与 props 迁移序列绑定。显式声明首个
   * 版本，既让旧快照可以补齐 config，也避免已保存 schema 中的 node-card 定义
   * 在恢复时成为“无定义记录类型”。
   */
  static override migrations = createShapePropsMigrationSequence({
    sequence: [
      {
        id: nodeCardMigrationIds.addStructuredConfig,
        up: (props) => {
          if (typeof props.config !== 'string') props.config = ''
        },
        down: 'retired'
      }
    ]
  })
  static override props: RecordProps<NodeCardShape> = {
    w: T.number,
    h: T.number,
    nodeType: T.string,
    title: T.string,
    config: T.string,
    text: T.string,
    mediaId: T.string,
    mediaPath: T.string,
    mediaMime: T.string,
    exec: T.string
  }

  override getDefaultProps(): NodeCardProps {
    return {
      w: 340,
      h: 200,
      nodeType: 'text',
      title: '文本',
      config: '',
      text: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    }
  }

  override component(shape: NodeCardShape): React.JSX.Element {
    return <NodeCardView shape={shape} />
  }

  /** 禁止旋转：调整节点只需缩放，旋转没有实际意义。 */
  override hideRotateHandle(): boolean {
    return true
  }

  /** 文本节点允许进入 tldraw 编辑态——编辑期间 tldraw 不再拦截键盘事件。 */
  override canEdit(shape: NodeCardShape): boolean {
    return shape.props.nodeType === 'text'
  }

  /** 选中时不再绘制节点外框实线，只保留 tldraw 自带的圆形缩放手柄。 */
  override indicator(shape: NodeCardShape): React.JSX.Element {
    const pad = 3
    return (
      <rect
        x={-pad}
        y={-pad}
        width={shape.props.w + pad * 2}
        height={shape.props.h + pad * 2}
        rx={16}
        fill="none"
        stroke="none"
      />
    )
  }
}
