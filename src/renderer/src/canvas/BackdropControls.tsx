import { useRef } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { Icon } from '../components/Icon'
import { applyBackdropAction } from './backdrop-actions'
import { arrangeBackdrop } from './backdrop-layout'
import type { BackdropShape } from './BackdropShape'
import './backdrop-controls.css'

const palette = [
  ['白色', '#FFFFFF'],
  ['浅灰', '#F2F3F5'],
  ['浅粉', '#F2BFBD'],
  ['浅橙', '#F8DCB6'],
  ['浅黄', '#FCF792'],
  ['浅绿', '#CDF0BF'],
  ['雾蓝', '#D2DDFE'],
  ['浅紫', '#DAC9FC'],
  ['银灰', '#E5E6E9'],
  ['中灰', '#BCBFC4'],
  ['珊瑚红', '#E66966'],
  ['橙色', '#F1A53C'],
  ['黄色', '#F9E917'],
  ['绿色', '#7CD24F'],
  ['蓝色', '#A9BBFF'],
  ['紫色', '#C2A5FB']
]

export function BackdropControls({ shape }: { shape: BackdropShape }): React.JSX.Element {
  const editor = useEditor()
  const popover = useRef<HTMLFormElement>(null)
  const colorButton = useRef<HTMLButtonElement>(null)
  const paletteId = `backdrop-palette-${shape.id}`
  const { title, color, fillOpacity, memberIds } = shape.props
  const updateColor = (value: string, opacity: number): void => {
    applyBackdropAction(editor, {
      action: 'backdrop.update',
      backdropId: shape.id,
      color: value,
      fillOpacity: opacity
    })
    popover.current?.hidePopover()
  }

  /** 横排/纵排属于视图整理操作：走本地历史点，失败时不会留下半成品。 */
  const arrange = (layout: 'horizontal' | 'vertical'): void => {
    if (memberIds.length < 2) return
    editor.markHistoryStoppingPoint(`backdrop-arrange-${layout}`)
    editor.run(() => arrangeBackdrop(editor, shape, layout))
    editor.markHistoryStoppingPoint('backdrop-arrange-complete')
  }

  return (
    <div className="backdrop-controls">
      <input
        key={title}
        className="backdrop-title"
        aria-label="背景板名称"
        placeholder="添加名称"
        defaultValue={title}
        maxLength={100}
        onPointerDown={stopEventPropagation}
        onBlur={(event) => {
          const value = event.currentTarget.value.trim()
          event.currentTarget.value = value
          if (value !== title)
            applyBackdropAction(editor, {
              action: 'backdrop.update',
              backdropId: shape.id,
              title: value
            })
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') event.currentTarget.value = title
          if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
        }}
      />
      <button
        type="button"
        className="backdrop-arrange"
        aria-label="整理背景板节点"
        title="整理背景板节点"
        disabled={memberIds.length < 2}
        onPointerDown={stopEventPropagation}
        onClick={() =>
          applyBackdropAction(editor, { action: 'backdrop.arrange', backdropId: shape.id })
        }
      >
        <Icon name="grid" size={26} />
      </button>
      <button
        type="button"
        className="backdrop-arrange"
        aria-label="横向排列背景板节点"
        title="横向排列：所有节点排成一行"
        disabled={memberIds.length < 2}
        onPointerDown={stopEventPropagation}
        onClick={() => arrange('horizontal')}
      >
        <Icon name="distribute-horizontal" size={26} />
      </button>
      <button
        type="button"
        className="backdrop-arrange"
        aria-label="纵向排列背景板节点"
        title="纵向排列：所有节点排成一列"
        disabled={memberIds.length < 2}
        onPointerDown={stopEventPropagation}
        onClick={() => arrange('vertical')}
      >
        <Icon name="distribute-vertical" size={26} />
      </button>
      <button
        ref={colorButton}
        type="button"
        className="backdrop-color"
        popoverTarget={paletteId}
        aria-label="背景板颜色"
        title="背景板颜色"
        style={{ backgroundColor: color }}
        onPointerDown={stopEventPropagation}
        onClick={() => popover.current?.reset()}
      />
      <form
        ref={popover}
        id={paletteId}
        popover="auto"
        className="backdrop-palette"
        onToggle={(event) => {
          if (event.newState !== 'open' || !colorButton.current) return
          const panel = event.currentTarget
          const anchor = colorButton.current.getBoundingClientRect()
          const { width, height } = panel.getBoundingClientRect()
          panel.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`
          panel.style.top = `${anchor.bottom + height + 16 <= window.innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - height - 8)}px`
        }}
        onPointerDown={stopEventPropagation}
        onKeyDown={stopEventPropagation}
        onSubmit={(event) => {
          event.preventDefault()
          const values = new FormData(event.currentTarget)
          updateColor(String(values.get('hex')), Number(values.get('opacity')) / 100)
        }}
      >
        <div className="backdrop-swatches">
          {palette.map(([label, value]) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              title={label}
              style={{ backgroundColor: value }}
              onClick={() => updateColor(value, 0.5)}
            />
          ))}
        </div>
        <label>
          HEX <input name="hex" required pattern="#[0-9a-fA-F]{6}" defaultValue={color} />
        </label>
        <label>
          不透明度 %{' '}
          <input
            name="opacity"
            type="number"
            required
            min={0}
            max={100}
            step="any"
            defaultValue={Math.round(fillOpacity * 1000) / 10}
          />
        </label>
        <button type="submit" className="btn-primary small">应用</button>
      </form>
    </div>
  )
}
