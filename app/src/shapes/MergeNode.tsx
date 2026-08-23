import { BaseBoxShapeUtil, T, useEditor, type RecordProps, type TLShape } from 'tldraw'
import { describeSource, getCompatibleSources, getTextValue, markNodeAndDependentsDirty, replaceDataDependency } from './dependencies'
import { MERGE_TYPE, type MergeNodeShape } from './types'

export class MergeNodeUtil extends BaseBoxShapeUtil<MergeNodeShape> {
  static override type = MERGE_TYPE
  static override props: RecordProps<MergeNodeShape> = { w: T.number, h: T.number, inputRef: T.string, separator: T.string, outputText: T.string, runState: T.string, lastError: T.string }
  override getDefaultProps(): MergeNodeShape['props'] { return { w: 360, h: 360, inputRef: '', separator: '\n\n', outputText: '', runState: 'idle', lastError: '' } }
  component(shape: MergeNodeShape) { return <MergeNodeComponent shape={shape} /> }
  getIndicatorPath(shape: MergeNodeShape) { const path = new Path2D(); path.roundRect(0, 0, shape.props.w, shape.props.h, 10); return path }
}

function MergeNodeComponent({ shape }: { shape: MergeNodeShape }) {
  const editor = useEditor()
  const props = shape.props
  const sources = getCompatibleSources(editor, shape.type, 'items', shape.id)
  const update = (patch: Partial<MergeNodeShape['props']>) => editor.updateShape({ id: shape.id, type: MERGE_TYPE, props: patch })
  const run = () => {
    const source = props.inputRef ? editor.getShape(props.inputRef as TLShape['id']) : null
    const items = source ? getTextValue(source) : []
    if (!Array.isArray(items) || !items.length) return update({ runState: 'error', lastError: '请连接包含至少一项的 Text[] 输入。' })
    update({ outputText: items.join(props.separator.replaceAll('\\n', '\n')), runState: 'done', lastError: '' })
    markNodeAndDependentsDirty(editor, shape.id, false)
  }
  return <div style={{ pointerEvents: 'all' }} className="w-full h-full flex flex-col node-card node-card-merge">
    <header className="node-header"><span className="node-kicker">⊕</span><span className="node-title">Merge 合并</span></header>
    <div onPointerDown={(event) => event.stopPropagation()} className="node-body space-y-2 text-xs">
      <label className="block text-neutral-500">输入（Text[]）
        <select value={props.inputRef} onChange={(event) => replaceDataDependency(editor, shape, 'items', event.target.value, (inputRef) => update({ inputRef }))} className="mt-1 w-full p-1.5 border rounded"><option value="">— 选择来源 —</option>{sources.map((source) => <option key={source.id} value={source.id}>{describeSource(source)}</option>)}</select>
      </label>
      <label className="block text-neutral-500">连接符 <input value={props.separator} onChange={(event) => update({ separator: event.target.value, runState: 'dirty' })} className="ml-2 w-20 p-1 border rounded" /></label>
      <pre className="max-h-20 overflow-auto whitespace-pre-wrap font-sans text-neutral-600">{props.outputText || '运行后输出 Text'}</pre>
    </div>
    {props.runState === 'error' && <div className="node-error">⚠ {props.lastError}</div>}
    <footer onPointerDown={(event) => event.stopPropagation()} className="node-footer"><button onClick={run} className="node-primary">合并</button></footer>
  </div>
}
