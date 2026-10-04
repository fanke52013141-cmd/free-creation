import { useMemo, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { Icon } from '../components/Icon'
import { toast } from '../stores/toast'
import { extractTemplateFromSelection, useWorkflowStore } from '../stores/workflow'
import type { NodeCardShape } from './NodeCardShape'
import '../library/library.css'
import { useAppStore } from '../stores/app'

interface Props {
  editor: Editor
  nodeIds: TLShapeId[]
  onClose: () => void
  onSaved: (kind: 'template' | 'resource') => void
}

export function WorkflowSaveDialog({
  editor,
  nodeIds,
  onClose,
  onSaved
}: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saveKind, setSaveKind] = useState<'template' | 'resource'>('template')
  const saveWorkflow = useWorkflowStore((state) => state.save)
  const nodes = useMemo(
    () =>
      nodeIds
        .map((id) => editor.getShape<NodeCardShape>(id))
        .filter((shape): shape is NodeCardShape => shape?.type === 'node-card'),
    [editor, nodeIds]
  )

  const save = async (): Promise<void> => {
    const title = name.trim()
    if (!title) return setError('请填写内容名称')
    if (nodes.length === 0) return setError('请至少选择一个节点')
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
      if (saveKind === 'resource') {
        const projectId = useAppStore.getState().currentProject?.id
        if (!projectId) throw new Error('请在项目画布中保存素材')
        const result = await window.api.captureLibraryNodes({
          projectId,
          title,
          nodes: nodes.map((node) => ({
            nodeId: node.id,
            nodeType: node.props.nodeType,
            title: node.props.title,
            text: node.props.text,
            mediaId: node.props.mediaId || undefined,
            mediaMime: node.props.mediaMime || undefined
          }))
        })
        if (!result.ok) throw new Error(result.error.message)
      } else await saveWorkflow(title, extractTemplateFromSelection(nodes, edges))
      toast(`已保存${saveKind === 'resource' ? '素材资源' : '流程模板'}「${title}」`)
      onSaved(saveKind)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="library-form-mask"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        className="library-form-dialog workflow-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="保存为可复用内容"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onClose()
          if (event.key === 'Enter' && !busy) void save()
        }}
      >
        <header className="library-form-header">
          <div>
            <span className="library-eyebrow">NODE LIBRARY</span>
            <h2>保存为可复用内容</h2>
          </div>
          <button
            type="button"
            className="library-form-close"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="library-form-scroll">
          <fieldset disabled={busy}>
            <legend>选择保存方式</legend>
            <label>
              <input
                type="radio"
                name="reuse-kind"
                checked={saveKind === 'resource'}
                disabled={
                  !nodes.every(
                    (node) =>
                      node.props.nodeType === 'text' ||
                      (['image', 'audio', 'video', 'video-asset'].includes(node.props.nodeType) &&
                        Boolean(node.props.mediaId))
                  )
                }
                onChange={() => setSaveKind('resource')}
              />
              素材资源：保存文本与媒体资产，供以后引用
            </label>
            <label>
              <input
                type="radio"
                name="reuse-kind"
                checked={saveKind === 'template'}
                onChange={() => setSaveKind('template')}
              />
              流程模板：保存节点配置与连线，不复制媒体
            </label>
          </fieldset>
          <label className="library-form-field">
            <span>内容名称</span>
            <input
              autoFocus
              maxLength={100}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError('')
              }}
              placeholder="例如：角色设定到分镜"
            />
          </label>
          <p className="side-panel-hint">
            {saveKind === 'template'
              ? `将保存 ${nodes.length} 个节点及它们之间的连线，不复制媒体。`
              : `将保存 ${nodes.length} 个节点的可复用正文与媒体，不保存执行连线。`}
          </p>
          {error && (
            <div className="library-form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="library-form-footer">
          <span>{nodes.length} 个节点</span>
          <button
            type="button"
            className="library-form-secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="library-form-primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : saveKind === 'resource' ? '保存素材资源' : '保存流程模板'}
          </button>
        </footer>
      </section>
    </div>
  )
}
