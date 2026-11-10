import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from '@tldraw/tlschema'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  type RecordProps,
  type TLBaseShape,
  type TLShapeId
} from 'tldraw'
import { BackdropControls } from './BackdropControls'
import { moveBackdrop } from './backdrop-layout'

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    backdrop: BackdropProps
  }
}

interface BackdropProps {
  w: number
  h: number
  color: string
  fillOpacity: number
  title: string
  memberIds: TLShapeId[]
  padding: { top: number; right: number; bottom: number; left: number }
}

export type BackdropShape = TLBaseShape<'backdrop', BackdropProps>

const defaultPadding = { top: 48, right: 24, bottom: 24, left: 24 }
const migrations = createShapePropsMigrationIds('backdrop', { addMembership: 1, addTitle: 2 })

export class BackdropShapeUtil extends BaseBoxShapeUtil<BackdropShape> {
  static override type = 'backdrop' as const
  static override migrations = createShapePropsMigrationSequence({
    sequence: [
      {
        id: migrations.addMembership,
        up: (props) => {
          props.memberIds ??= []
          props.padding ??= { ...defaultPadding }
        },
        down: 'retired'
      },
      {
        id: migrations.addTitle,
        up: (props) => {
          props.title ??= ''
        },
        down: 'retired'
      }
    ]
  })
  static override props: RecordProps<BackdropShape> = {
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
    title: T.string,
    color: T.string.refine((value) => {
      if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Expected a six-digit hex color')
      return value
    }),
    fillOpacity: T.number.refine((value) => {
      if (value < 0 || value > 1) throw new Error('Expected opacity between 0 and 1')
      return value
    }),
    memberIds: T.arrayOf(
      T.string.refine((value) => {
        if (!value.startsWith('shape:')) throw new Error('Expected a shape ID')
        return value as TLShapeId
      })
    ),
    padding: T.object({
      top: T.positiveNumber,
      right: T.positiveNumber,
      bottom: T.positiveNumber,
      left: T.positiveNumber
    })
  }

  override getDefaultProps(): BackdropProps {
    return {
      w: 420,
      h: 260,
      color: '#D2DDFE',
      fillOpacity: 0.5,
      title: '',
      memberIds: [],
      padding: { ...defaultPadding }
    }
  }

  override canResize(): boolean {
    return false
  }

  override hideRotateHandle(): boolean {
    return true
  }

  private dragPosition = new Map<TLShapeId, { x: number; y: number }>()

  override onTranslateStart(shape: BackdropShape): void {
    const point = this.editor.getShapePageTransform(shape)?.point()
    if (point) this.dragPosition.set(shape.id, point)
  }

  override onTranslate(initial: BackdropShape, current: BackdropShape): void {
    const previous = this.dragPosition.get(initial.id)
    const point = this.editor.getShapePageTransform(current)?.point()
    if (!previous || !point) return
    this.dragPosition.set(initial.id, point)
    // tldraw has already moved the board and any other selected shapes for this frame.
    moveBackdrop(this.editor, current, point.x - previous.x, point.y - previous.y, this.editor.getSelectedShapeIds())
  }

  override onTranslateEnd(initial: BackdropShape): void {
    this.dragPosition.delete(initial.id)
  }

  override onTranslateCancel(initial: BackdropShape): void {
    this.dragPosition.delete(initial.id)
  }

  override component(shape: BackdropShape): React.JSX.Element {
    const { w, h, color, fillOpacity } = shape.props
    return (
      <HTMLContainer data-canvas-backdrop={shape.id} style={{ width: w, height: h }}>
        <div
          aria-hidden="true"
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 12,
            backgroundColor: color,
            opacity: fillOpacity
          }}
        />
        <BackdropControls shape={shape} />
      </HTMLContainer>
    )
  }

  override indicator(shape: BackdropShape): React.JSX.Element {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} />
  }
}
