import { useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import { Icon } from '../components/Icon'
import { applyBackdropAction } from './backdrop-actions'
import { arrangeBackdrop, DEFAULT_BACKDROP_GAP } from './backdrop-layout'
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
  const spacingPopover = useRef<HTMLDivElement>(null)
  const spacingButton = useRef<HTMLButtonElement>(null)
  const paletteId = `backdrop-palette-${shape.id}`
  const spacingId = `backdrop-spacing-${shape.id}`
  const { title, color, fillOpacity, memberIds } = shape.props
  const [gapX, setGapX] = useState(DEFAULT_BACKDROP_GAP)
  const [gapY, setGapY] = useState(DEFAULT_BACKDROP_GAP)
  const updateColor = (value: string, opacity: number): void => {
    applyBackdropAction(editor, {
      action: 'backdrop.update',
      backdropId: shape.id,
      color: value,
      fillOpacity: opacity
    })
    popover.current?.hidePopover()
  }

  /** 横排/纵排/整理：走本地历史点，并使用当前横纵间距设置。 */
  const arrange = (
    layout: 'grid' | 'horizontal' | 'vertical',
    nextGaps: { gapX: number; gapY: number } = { gapX, gapY }
  ): void => {
    if (memberIds.length < 2) return
    editor.markHistoryStoppingPoint(`backdrop-arrange-${layout}`)
    editor.run(() => arrangeBackdrop(editor, shape, layout, nextGaps))
    editor.markHistoryStoppingPoint('backdrop-arrange-complete')
  }

  const updateGap = (axis: 'x' | 'y', value: number): void => {
    const nextGaps = axis === 'x' ? { gapX: value, gapY } : { gapX, gapY: value }
    if (axis === 'x') setGapX(value)
    else setGapY(value)
    if (memberIds.length < 2) return
    editor.run(() => arrangeBackdrop(editor, shape, 'grid', nextGaps))
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
      <div className="backdrop-tools" role="group" aria-label="背景板工具">
        <button
          ref={spacingButton}
          type="button"
          className="backdrop-arrange"
          popoverTarget={spacingId}
          aria-label="调整背景板间距"
          title={`调整间距（横 ${gapX}px / 纵 ${gapY}px）`}
          disabled={memberIds.length < 2}
          onPointerDown={stopEventPropagation}
        >
          <Icon name="gap-horizontal" size={18} />
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
          <Icon name="distribute-horizontal" size={20} />
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
          <Icon name="distribute-vertical" size={20} />
        </button>
        <button
          type="button"
          className="backdrop-arrange"
          aria-label="自动整理背景板节点"
          title="自动整理背景板节点"
          disabled={memberIds.length < 2}
          onPointerDown={stopEventPropagation}
          onClick={() => arrange('grid')}
        >
          <Icon name="grid" size={20} />
        </button>
        <button
          ref={colorButton}
          type="button"
          className="backdrop-color"
          popoverTarget={paletteId}
          aria-label="背景板颜色"
          title="背景板颜色"
          onPointerDown={stopEventPropagation}
          onClick={() => popover.current?.reset()}
        >
          <span aria-hidden="true" style={{ backgroundColor: color }} />
        </button>
      </div>
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
        <button type="submit" className="btn-primary small">
          应用
        </button>
      </form>
      <div
        ref={spacingPopover}
        id={spacingId}
        popover="auto"
        className="backdrop-spacing-popover"
        onToggle={(event) => {
          if (event.newState !== 'open' || !spacingButton.current) return
          const panel = event.currentTarget
          const anchor = spacingButton.current.getBoundingClientRect()
          const { width, height } = panel.getBoundingClientRect()
          panel.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`
          panel.style.top = `${anchor.top - height - 8 >= 8 ? anchor.top - height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - height - 8)}px`
        }}
        onPointerDown={stopEventPropagation}
        onKeyDown={stopEventPropagation}
      >
        <div className="backdrop-spacing-row">
          <span className="backdrop-spacing-label">
            <Icon name="gap-horizontal" size={14} />
            横向间距
          </span>
          <input
            type="range"
            aria-label="横向间距滑块"
            min={0}
            max={300}
            step={4}
            value={Math.min(300, Math.max(0, gapX))}
            disabled={memberIds.length < 2}
            onPointerDown={() => {
              if (memberIds.length >= 2) editor.markHistoryStoppingPoint('backdrop-gap-x')
            }}
            onChange={(event) => updateGap('x', Number(event.currentTarget.value))}
          />
          <label className="backdrop-spacing-input-wrap">
            <input
              type="number"
              className="backdrop-spacing-input"
              aria-label="横向间距数值"
              min={0}
              max={1000}
              step={1}
              value={gapX}
              disabled={memberIds.length < 2}
              onFocus={() => {
                if (memberIds.length >= 2) editor.markHistoryStoppingPoint('backdrop-gap-x')
              }}
              onChange={(event) => {
                const next = Number(event.currentTarget.value)
                if (Number.isFinite(next) && next >= 0) updateGap('x', Math.min(1000, Math.round(next)))
              }}
            />
            <span>px</span>
          </label>
        </div>
        <div className="backdrop-spacing-row">
          <span className="backdrop-spacing-label">
            <Icon name="gap-vertical" size={14} />
            纵向间距
          </span>
          <input
            type="range"
            aria-label="纵向间距滑块"
            min={0}
            max={300}
            step={4}
            value={Math.min(300, Math.max(0, gapY))}
            disabled={memberIds.length < 2}
            onPointerDown={() => {
              if (memberIds.length >= 2) editor.markHistoryStoppingPoint('backdrop-gap-y')
            }}
            onChange={(event) => updateGap('y', Number(event.currentTarget.value))}
          />
          <label className="backdrop-spacing-input-wrap">
            <input
              type="number"
              className="backdrop-spacing-input"
              aria-label="纵向间距数值"
              min={0}
              max={1000}
              step={1}
              value={gapY}
              disabled={memberIds.length < 2}
              onFocus={() => {
                if (memberIds.length >= 2) editor.markHistoryStoppingPoint('backdrop-gap-y')
              }}
              onChange={(event) => {
                const next = Number(event.currentTarget.value)
                if (Number.isFinite(next) && next >= 0) updateGap('y', Math.min(1000, Math.round(next)))
              }}
            />
            <span>px</span>
          </label>
        </div>
      </div>
    </div>
  )
}
