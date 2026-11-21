import { useMemo, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { toast } from '../stores/toast'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'
import { extractTemplateFromSelection, useWorkflowStore } from '../stores/workflow'
import { deriveGraph } from './graph'
import { buildCompositeManifestFromGraph } from '../composite/build-manifest'
import type { CompositeManifest } from '@shared/composite/manifest'
import type { NodeCardShape } from './NodeCardShape'
import '../library/library.css'
import { useAppStore } from '../stores/app'

interface Props {
  editor: Editor
  nodeIds: TLShapeId[]
  onClose: () => void
  onSaved: (kind: 'template' | 'resource' | 'composite', name?: string) => void
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
  const [saveKind, setSaveKind] = useState<'template' | 'resource' | 'composite'>('template')
  const [capabilityId, setCapabilityId] = useState('')
  const [version, setVersion] = useState('1.0')
  const [compositeDraft, setCompositeDraft] = useState<CompositeManifest | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const saveWorkflow = useWorkflowStore((state) => state.save)
  const nodes = useMemo(
    () =>
      nodeIds
        .map((id) => editor.getShape<NodeCardShape>(id))
        .filter((shape): shape is NodeCardShape => shape?.type === 'node-card'),
    [editor, nodeIds]
  )

  // 进入组合模式时构建一次可编辑边界；用户之后增删/改映射直接改这份草稿。
  const buildBoundary = (): void => {
    const graph = deriveGraph(editor)
    const built = buildCompositeManifestFromGraph({
      capabilityId: capabilityId.trim() || slugify(name) || `composite-${Date.now()}`,
      name: name.trim() || '未命名组合',
      version: version.trim() || '1.0',
      nodes: graph.nodes,
      edges: graph.edges,
      selectedNodeIds: nodes.map((node) => node.id)
    })
    if (built.ok) {
      setCompositeDraft(built.manifest)
      setError('')
    } else {
      setCompositeDraft(null)
      setError(built.issues.map((issue) => `${issue.path}: ${issue.message}`).join('；'))
    }
  }

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
      } else if (saveKind === 'composite') {
        if (!compositeDraft) throw new Error('组合边界尚未构建，请先检查选区与映射')
        const id = capabilityId.trim() || slugify(title) || `composite-${Date.now()}`
        const edited: CompositeManifest = {
          ...compositeDraft,
          capabilityId: id,
          name: title,
          version: version.trim() || '1.0'
        }
        const validated = await window.api.composite.validate({ manifest: edited })
        if (!validated.ok) throw new Error(validated.error.message)
        if (!validated.data.ok) {
          throw new Error(
            validated.data.issues
              .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
              .join('；')
          )
        }
        const draft = await window.api.composite.draftSave({ manifest: edited })
        if (!draft.ok) throw new Error(draft.error.message)
        const published = await window.api.composite.publish({
          manifest: edited,
          expectedRevision: draft.data.revision
        })
        if (!published.ok) throw new Error(published.error.message)
        // 发布只登记到节点流库，不自动落画布；需要实例时从节点流面板点击/拖拽添加。
      } else await saveWorkflow(title, extractTemplateFromSelection(nodes, edges))
      const kindLabel =
        saveKind === 'resource' ? '素材资源' : saveKind === 'composite' ? '组合节点' : '流程模板'
      toast(`已保存${kindLabel}「${title}」`)
      onSaved(saveKind, title)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      size="m"
      title="保存节点"
      className="workflow-save-dialog"
      ariaLabel="保存节点"
      onClose={() => !busy && onClose()}
      closeOnEscape={!busy}
      closeOnOverlay={!busy}
      initialFocusRef={nameRef}
      footerLeft={`${nodes.length} 个节点`}
      footer={
        <>
          <button
            type="button"
            className={modalBtn('secondary')}
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className={modalBtn('primary')}
            disabled={busy}
            onClick={() => void save()}
          >
            {busy
              ? '保存中…'
              : saveKind === 'resource'
                ? '保存素材资源'
                : saveKind === 'composite'
                  ? '保存并发布组合'
                  : '保存流程模板'}
          </button>
        </>
      }
    >
      {/* 2026-11-21 弹窗统一：壳换 ModalShell，内容类（library-form-field /
          workflow-save-*）为无作用域样式原样保留；Enter 提交与按键防护不变。 */}
      <div
        onKeyDown={(event) => {
          event.stopPropagation()
          if (
            event.key === 'Enter' &&
            !busy &&
            event.target instanceof HTMLInputElement &&
            event.target.type === 'text' &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            void save()
          }
        }}
      >
        <label className="library-form-field">
          <span>内容名称</span>
          <input
            ref={nameRef}
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
            placeholder="例如：角色设定到分镜"
          />
        </label>
        <fieldset className="workflow-save-options" disabled={busy}>
          <legend>选择保存方式</legend>
          <label>
            <input
              type="radio"
              name="reuse-kind"
              checked={saveKind === 'template'}
              onChange={() => setSaveKind('template')}
            />
            流程模板
          </label>
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
            素材资源
          </label>
          <label>
            <input
              type="radio"
              name="reuse-kind"
              checked={saveKind === 'composite'}
              disabled={nodes.length < 1}
              onChange={() => {
                setSaveKind('composite')
                buildBoundary()
              }}
            />
            组合节点
          </label>
        </fieldset>
        {saveKind === 'composite' && (
          <div className="workflow-save-composite">
            <div className="workflow-save-composite-fields">
              <label className="library-form-field">
                <span>组合 ID（留空由名称生成）</span>
                <input
                  maxLength={80}
                  value={capabilityId}
                  onChange={(event) => {
                    setCapabilityId(event.target.value)
                    setError('')
                  }}
                  placeholder="character-design"
                />
              </label>
              <label className="library-form-field">
                <span>版本</span>
                <input
                  maxLength={20}
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                  placeholder="1.0"
                />
              </label>
            </div>
            {compositeDraft ? (
              <p className="workflow-save-boundary-hint">
                公开输入/输出按内部节点规范自动推导：
                {compositeDraft.inputs.length} 个输入 · {compositeDraft.outputs.length} 个输出
              </p>
            ) : null}
          </div>
        )}
        {error && (
          <div className="modal-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>
    </ModalShell>
  )
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
