// NodeCard tldraw 自定义形状：所有节点类型的统一卡片容器
import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from '@tldraw/tlschema'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
  type RecordProps,
  type TLBaseShape,
  type TLResizeInfo,
  type TLShapeId,
  type TLShapePartial
} from 'tldraw'
import { NodeCardView } from './NodeCardView'
import { shouldMountNodeCardView } from './node-viewport-gate'
import { NODE_UI } from './node-ui-tokens'
import { getNodeType } from '../nodes/registry'

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

// eslint-disable-next-line react-refresh/only-export-components
function NodeCardViewportGate({ shape }: { shape: NodeCardShape }): React.JSX.Element {
  const editor = useEditor()
  const mounted = useValue(
    'node-card viewport gate',
    () => shouldMountNodeCardView(editor, shape),
    [editor, shape.id, shape.props.exec]
  )
  if (!mounted) {
    return (
      <HTMLContainer
        id={shape.id}
        style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'auto' }}
      >
        <div
          className="node-card-dormant-shell"
          data-node-id={shape.id}
          data-node-type={shape.props.nodeType}
        />
      </HTMLContainer>
    )
  }
  return <NodeCardView shape={shape} />
}

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
    // 默认尺寸与 Registry 的 STANDARD_NODE_SIZE 同源（呈现规范 §24A：
    // 修复双真值——此处曾为 340×200，与 Registry 强制的 340×260 不一致）。
    return {
      w: NODE_UI.width,
      h: NODE_UI.height.default,
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
    return <NodeCardViewportGate shape={shape} />
  }

  override onBeforeCreate(shape: NodeCardShape): NodeCardShape {
    if (shape.props.nodeType !== 'processor' || shape.props.config.trim()) return shape
    return {
      ...shape,
      props: {
        ...shape.props,
        // 二-2：默认透传（pass）——pick 需要 JSON 输入与字段路径，新建节点喂文本
        // 必失败（R1 实测根因）；提取字段/模板由用户在设置里显式选择。
        config: JSON.stringify({
          operation: 'pass',
          valueType: 'any',
          fallback: '',
          path: '',
          template: ''
        })
      }
    }
  }

  /** 禁止旋转：调整节点只需缩放，旋转没有实际意义。 */
  override hideRotateHandle(): boolean {
    return true
  }

  /** 文本节点允许进入 tldraw 编辑态——编辑期间 tldraw 不再拦截键盘事件。 */
  override canEdit(shape: NodeCardShape): boolean {
    // 时间线在选中片段期间也进入编辑态：tldraw 会关闭自己的键盘快捷键，
    // 于是 Delete 不会被画布拿去删整张节点，只由时间线删片段。
    return shape.props.nodeType === 'text' || shape.props.nodeType === 'timeline'
  }

  /**
   * 分组缩放时（tldraw 会以 mode='scale_shape' 通知组内子节点）返回 undefined，
   * 让编辑器走“仅平移”分支：卡片 w/h 保持不变，只随缩放比例重新定位。
   * 卡片头部与正文是固定像素 CSS（§22 起头部内嵌卡体、36px 行高，字号不随 w/h 变化；
   * 2026-11-20 注释校准，旧实现曾是悬浮 header top:-34px），
   * w/h 被缩放后与它们错位——这正是“打组后缩放、节点相对位置和文字大小漂移”的根因。
   * 直接拖单个节点自己的缩放手柄时（mode='resize_bounds'）仍正常缩放 w/h。
   */
  override onResize(
    shape: NodeCardShape,
    info: TLResizeInfo<NodeCardShape>
  ): Omit<TLShapePartial<NodeCardShape>, 'id' | 'type'> | undefined {
    if (info.mode === 'scale_shape') return undefined
    const resized = super.onResize(shape, info)
    if (info.mode !== 'resize_bounds') return resized
    const height = resized?.props?.h ?? shape.props.h
    // content/free 尺寸节点（分镜板、时间线）不夹取高度：内容自适应或用户拖动说了算。
    // 统一档位只约束 standard 节点，这里不再按具体节点类型写白名单。
    const sizePolicy = getNodeType(shape.props.nodeType)?.sizePolicy
    if (sizePolicy === 'content' || sizePolicy === 'free') {
      return {
        ...resized,
        meta: {
          ...(this.editor.getShape<NodeCardShape>(shape.id)?.meta ?? shape.meta),
          nodeHeightMode: 'manual'
        }
      }
    }
    // 视频生成节点允许拖到专用上限（引用多图时输出参数不能被裁掉）；其余节点共用通用上限。
    const manualCap =
      shape.props.nodeType === 'video' ? NODE_UI.height.autoMaxVideoGen : NODE_UI.height.manualMax
    const clamped = Math.max(NODE_UI.height.min, Math.min(manualCap, height))
    const anchor = info.handle.startsWith('top')
      ? 1
      : info.handle === 'left' || info.handle === 'right'
        ? 0.5
        : 0
    const offset = info.scaleY >= 0 ? (height - clamped) * anchor : 0

    // 所有节点共用高度边界；手动拖动后由用户控制高度，标题可恢复自动模式。
    // 该标记放在 shape meta，不参与节点业务配置或运行契约。
    return {
      ...(resized ?? {}),
      x: (resized?.x ?? shape.x) - Math.sin(shape.rotation) * offset,
      y: (resized?.y ?? shape.y) + Math.cos(shape.rotation) * offset,
      props: {
        ...resized?.props,
        h: clamped
      },
      meta: {
        ...(this.editor.getShape<NodeCardShape>(shape.id)?.meta ?? shape.meta),
        nodeHeightMode: 'manual'
      }
    }
  }

  /** 循环体容器拖动：框卡平移时带动成员（循环体节点 + 输入/输出圆点），不用 tldraw group。 */
  private templateDrag: Map<string, { x: number; y: number }> | null = null

  override onTranslateStart(shape: NodeCardShape): void {
    const loopId = (shape.meta as Record<string, unknown>)?.iterationTemplateCard
    if (typeof loopId !== 'string') {
      this.templateDrag = null
      return
    }
    const members = new Map<string, { x: number; y: number }>()
    for (const s of this.editor.getCurrentPageShapes()) {
      if (s.type !== 'node-card') continue
      const m = s.meta as Record<string, unknown>
      if (m?.iterationTemplateLoopId !== loopId) continue
      if (!m?.iterationTemplateMember) continue
      members.set(s.id, { x: s.x, y: s.y })
    }
    this.templateDrag = members
  }

  override onTranslate(initial: NodeCardShape, current: NodeCardShape): void {
    if (!this.templateDrag || this.templateDrag.size === 0) return
    const dx = current.x - initial.x
    const dy = current.y - initial.y
    if (dx === 0 && dy === 0) return
    const updates = [...this.templateDrag.entries()].map(([id, p]) => ({
      id: id as TLShapeId,
      type: 'node-card' as const,
      x: p.x + dx,
      y: p.y + dy
    }))
    this.editor.updateShapes(updates)
  }

  override onTranslateEnd(): void {
    this.templateDrag = null
  }

  override onTranslateCancel(): void {
    this.templateDrag = null
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
