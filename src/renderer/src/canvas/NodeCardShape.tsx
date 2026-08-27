// NodeCard tldraw 自定义形状：所有节点类型的统一卡片容器
import {
  BaseBoxShapeUtil,
  T,
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  type RecordProps,
  type TLBaseShape
} from 'tldraw'
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
  /** 用户可见内容：文本正文、对话 messages、分镜 shots、JSON 数据（R8 字段三分） */
  text: string
  /** 节点固定配置 JSON：模型 key、系统提示词、参数、seed 等（按 CONFIG_KEYS 拆分） */
  config: string
  /** 上次运行的登记结果（NodeValue JSON），输出投影的优先来源 */
  result: string
  mediaId: string
  mediaPath: string
  mediaMime: string
  exec: string
  /** R8/WP2 节点级运行元数据 JSON（RunMeta 序列化），空串表示未运行过 */
  runMeta: string
}

export type NodeCardShape = TLBaseShape<'node-card', NodeCardProps>

// R8/WP1：新增 config / result 字段；旧快照加载时由 tldraw 迁移补空串，
// 数据内容的拆分（text → config/text/result）由 planLegacyMigrations 在项目打开时完成
const Versions = createShapePropsMigrationIds('node-card', {
  AddConfigResult: 1,
  AddRunMeta: 2
})

/** node-card shape props 版本号（供迁移与测试引用） */
export const nodeCardShapeVersions = Versions

export const nodeCardShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions.AddConfigResult,
      up: (props) => {
        props.config = ''
        props.result = ''
      },
      down: (props) => {
        delete props.config
        delete props.result
      }
    },
    {
      id: Versions.AddRunMeta,
      up: (props) => {
        props.runMeta = ''
      },
      down: (props) => {
        delete props.runMeta
      }
    }
  ]
})

export class NodeCardUtil extends BaseBoxShapeUtil<NodeCardShape> {
  static override type = 'node-card' as const
  static override props: RecordProps<NodeCardShape> = {
    w: T.number,
    h: T.number,
    nodeType: T.string,
    title: T.string,
    text: T.string,
    config: T.string,
    result: T.string,
    mediaId: T.string,
    mediaPath: T.string,
    mediaMime: T.string,
    exec: T.string,
    runMeta: T.string
  }

  static override migrations = nodeCardShapeMigrations

  override getDefaultProps(): NodeCardProps {
    return {
      w: 340,
      h: 200,
      nodeType: 'text',
      title: '文本',
      text: '',
      config: '',
      result: '',
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle',
      runMeta: ''
    }
  }

  override component(shape: NodeCardShape): React.JSX.Element {
    return <NodeCardView shape={shape} />
  }

  override indicator(shape: NodeCardShape): React.JSX.Element {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} />
  }
}
