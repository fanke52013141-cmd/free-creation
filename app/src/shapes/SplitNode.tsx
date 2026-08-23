import { BaseBoxShapeUtil, T, useEditor, type RecordProps, type TLShape } from 'tldraw'
import { describeSource, getCompatibleSources, getTextValue, markNodeAndDependentsDirty, replaceDataDependency } from './dependencies'
import { SPLIT_TYPE, type SplitNodeShape } from './types'
import { splitText } from './runtime'
import { NodePortMarkers } from './NodePortMarkers'

export class SplitNodeUtil extends BaseBoxShapeUtil<SplitNodeShape> {
  static override type = SPLIT_TYPE
  static override props: RecordProps<SplitNodeShape> = { w: T.number, h: T.number, inputRef: T.string, delimiter: T.string, itemsJson: T.string, runState: T.string, lastError: T.string }
  override getDefaultProps(): SplitNodeShape['props'] {
    return { w: 360, h: 360, inputRef: '', delimiter: 'auto', itemsJson: '[]', runState: 'idle', lastError: '' }
  }
  component(shape: SplitNodeShape) { return <SplitNodeComponent shape={shape} /> }
  getIndicatorPath(shape: SplitNodeShape) { const path = new Path2D(); path.roundRect(0, 0, shape.props.w, shape.props.h, 10); return path }
}

function SplitNodeComponent({ shape }: { shape: SplitNodeShape }) {
  const editor = useEditor()
  const props = shape.props
  const sources = getCompatibleSources(editor, shape.type, 'text', shape.id)
  const update = (patch: Partial<SplitNodeShape['props']>) => editor.updateShape({ id: shape.id, type: SPLIT_TYPE, props: patch })
  const run = () => {
    const source = props.inputRef ? editor.getShape(props.inputRef as TLShape['id']) : null
    const manualInput = typeof shape.meta.manualInput === 'string' ? shape.meta.manualInput : ''
    const text = source ? getTextValue(source) : manualInput
    if (!text || Array.isArray(text)) return update({ runState: 'error', lastError: '请连接有内容的单条文本输入。' })
    const items = splitText(text, props.delimiter)
    update({ itemsJson: JSON.stringify(items), runState: 'done', lastError: '' })
    markNodeAndDependentsDirty(editor, shape.id, false)
  }
  let items: string[] = []
  try { const parsed: unknown = JSON.parse(props.itemsJson); if (Array.isArray(parsed)) items = parsed.filter((item): item is string => typeof item === 'string') } catch { /* invalid cache is displayed as empty */ }
  return <div style={{ pointerEvents: 'all' }} className="w-full h-full flex flex-col node-card node-card-split"><NodePortMarkers type={shape.type} />
    <header className="node-header"><span className="node-kicker">⇶</span><span className="node-title">Split 拆分</span></header>
    <div onPointerDown={(event) => event.stopPropagation()} className="node-body space-y-2 text-xs">
      <label className="block text-neutral-500">输入（Text）
        <select value={props.inputRef} onChange={(event) => replaceDataDependency(editor, shape, 'text', event.target.value, (inputRef) => update({ inputRef }))} className="mt-1 w-full p-1.5 border rounded"><option value="">— 选择来源 —</option>{sources.map((source) => <option key={source.id} value={source.id}>{describeSource(source)}</option>)}</select>
      </label>
      {!props.inputRef && <textarea value={typeof shape.meta.manualInput === 'string' ? shape.meta.manualInput : ''} onChange={(event) => editor.updateShape({ id: shape.id, type: SPLIT_TYPE, meta: { ...shape.meta, manualInput: event.target.value }, props: { runState: 'dirty', lastError: '' } })} placeholder="手动输入文本" rows={3} className="w-full p-2 border rounded resize-none" />}
      <label className="block text-neutral-500">分隔规则 <select value={props.delimiter} onChange={(event) => update({ delimiter: event.target.value, runState: 'dirty' })} className="ml-2 p-1 border rounded"><option value="auto">自动：换行 / === / ---</option><option value="\\n">仅换行</option><option value="===">===</option><option value="---">---</option><option value=",">逗号</option></select></label>
      <p className="text-neutral-400">输出 Text[]：{items.length} 项</p>
      {items.slice(0, 4).map((item, index) => <p key={index} className="p-1.5 rounded bg-neutral-50 text-neutral-600 truncate">{index + 1}. {item}</p>)}
    </div>
    {props.runState === 'error' && <div className="node-error">⚠ {props.lastError}</div>}
    <footer onPointerDown={(event) => event.stopPropagation()} className="node-footer"><button onClick={run} className="node-primary">拆分</button></footer>
  </div>
}
