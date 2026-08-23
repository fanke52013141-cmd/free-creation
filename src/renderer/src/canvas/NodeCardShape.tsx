// NodeCard tldraw 自定义形状：所有节点类型的统一卡片容器
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
  text: string
  mediaId: string
  mediaPath: string
  mediaMime: string
  exec: string
}

export type NodeCardShape = TLBaseShape<'node-card', NodeCardProps>

export class NodeCardUtil extends BaseBoxShapeUtil<NodeCardShape> {
  static override type = 'node-card' as const
  static override props: RecordProps<NodeCardShape> = {
    w: T.number,
    h: T.number,
    nodeType: T.string,
    title: T.string,
    text: T.string,
    mediaId: T.string,
    mediaPath: T.string,
    mediaMime: T.string,
    exec: T.string
  }

  override getDefaultProps(): NodeCardProps {
    return {
      w: 520,
      h: 300,
      nodeType: 'text',
      title: '文本',
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

  override indicator(shape: NodeCardShape): React.JSX.Element {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} />
  }
}
