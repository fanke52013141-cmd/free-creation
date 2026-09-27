import { useMemo, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import { extractTemplateFromSelection, useWorkflowStore } from '../stores/workflow'
import type { NodeCardShape } from './NodeCardShape'
import '../library/library.css'

interface Props {
  editor: Editor
  nodeIds: TLShapeId[]
  onClose: () => void
  onSaved: () => void
}

export function WorkflowSaveDialog({ editor, nodeIds, onClose, onSaved }: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saveWorkflow = useWorkflowStore((state) => state.save)
  const nodes = useMemo(() => nodeIds.map((id) => editor.getShape<NodeCardShape>(id))
    .filter((shape): shape is NodeCardShape => shape?.type === 'node-card'), [editor, nodeIds])

  const save = async (): Promise<void> => {
    const title = name.trim()
    if (!title) return setError('请填写工作流名称')
    if (nodes.length < 2) return setError('请至少选择两个节点')
    const positions = new Map(nodes.map((node, index) => [node.id, index]))
    const edges: { fromIdx: number; toIdx: number; fromPort?: string; toPort?: string }[] = []
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'arrow') continue
      const bindings = editor.getBindingsFromShape(shape.id, 'arrow')
      const start = bindings.find((binding) => binding.props.terminal === 'start')
      const end = bindings.find((binding) => binding.props.terminal === 'end')
      const fromIdx = start ? positions.get(start.toId) : undefined
      const toIdx = end ? positions.get(end.toId) : undefined
      if (fromIdx === undefined || toIdx === undefined) continue
      edges.push({
        fromIdx,
        toIdx,
        fromPort: typeof shape.meta.fromPort === 'string' ? shape.meta.fromPort : undefined,
        toPort: typeof shape.meta.toPort === 'string' ? shape.meta.toPort : undefined
      })
    }
    setBusy(true)
    setError('')
    try {
      await saveWorkflow(title, extractTemplateFromSelection(nodes, edges))
      toast(`已保存工作流「${title}」`)
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="library-form-mask" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="library-form-dialog workflow-save-dialog" role="dialog" aria-modal="true" aria-label="保存工作流" onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' && !busy) onClose()
        if (event.key === 'Enter' && !busy) void save()
      }}>
        <header className="library-form-header">
          <div><span className="library-eyebrow">WORKFLOW</span><h2>保存工作流</h2></div>
          <button type="button" className="library-form-close" aria-label="关闭" disabled={busy} onClick={onClose}><Icon name="close" size={17} /></button>
        </header>
        <div className="library-form-scroll">
          <label className="library-form-field"><span>工作流名称</span>
            <input autoFocus maxLength={100} value={name} onChange={(event) => { setName(event.target.value); setError('') }} placeholder="例如：角色设定到分镜" />
          </label>
          <p className="side-panel-hint">将保存 {nodes.length} 个节点及它们之间的连线。媒体文件不会复制到工作流。</p>
          {error && <div className="library-form-error" role="alert">{error}</div>}
        </div>
        <footer className="library-form-footer">
          <span>{nodes.length} 个节点</span>
          <button type="button" className="library-form-secondary" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="library-form-primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存工作流'}</button>
        </footer>
      </section>
    </div>
  )
}
