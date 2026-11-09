// 背景板（backdrop）tldraw 自定义形状。
//
// 用户需求（2026-11-09）：在多选节点后加一个「背景板」，把节点铺在一块**颜色很淡的
// 可伸缩矩形**上，用来做归类/分区；横向拉宽、纵向拉高都自由，且**不能像分组那样给节点
// 盖一层蒙版**——节点必须保持清晰。
//
// 实现要点：
// - 使用 BaseBoxShapeUtil（自带 8 个缩放手柄，可直接拖拽改宽高）；
// - 填充是低透明度纯色 + 1px 细描边，位于节点**下方**（创建时 sendToBack）；
// - 不把节点设为子元素：背景板与节点互相独立，拖动背景板不会带走内容，避免误操作；
// - 颜色只允许 5 个低饱和档位（与设计系统一致，不引入高饱和色）。
import { createShapePropsMigrationSequence } from '@tldraw/tlschema'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  type RecordProps,
  type TLBaseShape
} from 'tldraw'

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    backdrop: BackdropProps
  }
}

export type BackdropColorKey = 'teal' | 'indigo' | 'amber' | 'rose' | 'slate'

export interface BackdropPaletteEntry {
  fill: string
  border: string
  label: string
  dot: string
}

/** 只提供"淡色"档位：填充 8–12% 不透明度，保证节点在上方依然清晰。 */
export const BACKDROP_PALETTE: Record<BackdropColorKey, BackdropPaletteEntry> = {
  teal: {
    fill: 'rgba(6, 182, 212, 0.10)',
    border: 'rgba(6, 182, 212, 0.34)',
    label: 'rgba(226, 232, 240, 0.78)',
    dot: '#06b6d4'
  },
  indigo: {
    fill: 'rgba(99, 102, 241, 0.12)',
    border: 'rgba(129, 140, 248, 0.34)',
    label: 'rgba(226, 232, 240, 0.78)',
    dot: '#818cf8'
  },
  amber: {
    fill: 'rgba(245, 158, 11, 0.10)',
    border: 'rgba(251, 191, 36, 0.32)',
    label: 'rgba(226, 232, 240, 0.78)',
    dot: '#fbbf24'
  },
  rose: {
    fill: 'rgba(244, 114, 182, 0.10)',
    border: 'rgba(244, 114, 182, 0.32)',
    label: 'rgba(226, 232, 240, 0.78)',
    dot: '#f472b6'
  },
  slate: {
    fill: 'rgba(148, 163, 184, 0.10)',
    border: 'rgba(148, 163, 184, 0.30)',
    label: 'rgba(226, 232, 240, 0.78)',
    dot: '#94a3b8'
  }
}

export const BACKDROP_COLOR_KEYS = Object.keys(BACKDROP_PALETTE) as BackdropColorKey[]

export interface BackdropProps {
  w: number
  h: number
  color: BackdropColorKey
  label: string
}

export type BackdropShape = TLBaseShape<'backdrop', BackdropProps>

export class BackdropShapeUtil extends BaseBoxShapeUtil<BackdropShape> {
  static override type = 'backdrop' as const
  static override props: RecordProps<BackdropShape> = {
    w: T.number,
    h: T.number,
    // 颜色是 5 个受控档位；加档位时在此追加并同步 BACKDROP_PALETTE。
    color: T.literalEnum('teal', 'indigo', 'amber', 'rose', 'slate'),
    label: T.string
  }
  // 全新形状没有历史快照需要迁移；显式声明空序列，避免 store 校验缺定义。
  static override migrations = createShapePropsMigrationSequence({ sequence: [] })

  override canResize = (): boolean => true
  override canEdit = (): boolean => false
  override hideResizeHandles = (): boolean => false

  getDefaultProps(): BackdropProps {
    return { w: 420, h: 260, color: 'teal', label: '背景板' }
  }

  override component(shape: BackdropShape): React.JSX.Element {
    const palette = BACKDROP_PALETTE[(shape.props.color as BackdropColorKey) ?? 'teal'] ?? BACKDROP_PALETTE.teal
    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: shape.props.w,
          height: shape.props.h,
          borderRadius: 12,
          background: palette.fill,
          border: `1px solid ${palette.border}`,
          pointerEvents: 'all'
        }}
      >
        <div className="backdrop-label" style={{ color: palette.label }}>
          <span className="backdrop-label-dot" style={{ background: palette.dot }} />
          <span>{shape.props.label || '背景板'}</span>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: BackdropShape): React.JSX.Element {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />
  }
}
