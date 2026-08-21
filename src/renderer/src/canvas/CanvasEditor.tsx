import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta, MediaAsset, NodeTypeId } from '@shared/types'
import { NodeCardUtil, type NodeCardProps } from './NodeCardShape'
import { NodeCreateMenu } from './NodeCreateMenu'
import { getNodeType } from '../nodes/registry'
import { registerBaseNodeTypes } from '../nodes/specs'
import { toast } from '../stores/toast'

registerBaseNodeTypes()

interface CanvasEditorProps {
  project: ProjectMeta
  initialSnapshot: unknown
}

interface MenuState {
  x: number
  y: number
}

export function CanvasEditor({ project, initialSnapshot }: CanvasEditorProps): React.JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 快照恢复失败后置位：跳过一切自动保存，避免把空画布写回覆盖原数据
  const restoreFailedRef = useRef(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [addDrag, setAddDrag] = useState<{ x: number; y: number } | null>(null)

  // 左侧栏「＋」按住拖动：跟手显示浮标，松开时在落点弹创建菜单（拖动式添加）
  const startAddDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    setAddDrag({ x: e.clientX, y: e.clientY })
    const onMove = (ev: PointerEvent): void => {
      setAddDrag({ x: ev.clientX, y: ev.clientY })
    }
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setAddDrag(null)
      setMenu({ x: ev.clientX, y: ev.clientY })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const flushSave = (): void => {
    if (restoreFailedRef.current) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const editor = editorRef.current
    if (!editor) return
    void window.api.saveProject({
      id: project.id,
      tldrawSnapshot: editor.store.getStoreSnapshot()
    })
  }

  useEffect(() => {
    // 关窗时异步 invoke 可能赶不上页面销毁，用同步 IPC 确保落盘
    const onBeforeUnload = (): void => {
      if (restoreFailedRef.current) return
      const editor = editorRef.current
      if (!editor) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      window.api.saveProjectSync({
        id: project.id,
        tldrawSnapshot: editor.store.getStoreSnapshot()
      })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // 双击空白画布弹节点菜单（LibTV 1.2.1 交互）；捕获阶段拦截，阻止 tldraw 默认建文本
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onDblClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (
        target.closest('.tl-shape') ||
        target.closest('.tlui-layout') ||
        target.closest('.tl-overlays')
      )
        return
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY })
    }
    el.addEventListener('dblclick', onDblClick, { capture: true })
    return () => {
      el.removeEventListener('dblclick', onDblClick, { capture: true })
    }
  }, [])

  const createNodeAt = (type: NodeTypeId, screenX: number, screenY: number): void => {
    const editor = editorRef.current
    if (!editor) return
    const spec = getNodeType(type)
    if (!spec) return
    const point = editor.screenToPage({ x: screenX, y: screenY })
    editor.createShape({
      type: 'node-card',
      x: point.x - spec.defaultSize.w / 2,
      y: point.y - spec.defaultSize.h / 2,
      props: {
        nodeType: type,
        title: spec.label,
        w: spec.defaultSize.w,
        h: spec.defaultSize.h
      } satisfies Partial<NodeCardProps>
    })
  }

  const createMediaNodes = (assets: MediaAsset[], screenX: number, screenY: number): void => {
    const editor = editorRef.current
    if (!editor) return
    assets.forEach((asset, i) => {
      // 文本类文件（txt/md/json）：内容直接填进文本节点，可编辑
      const isTextFile = asset.kind === 'file'
      const spec = getNodeType(isTextFile ? 'text' : asset.kind)
      if (!spec) return
      const point = editor.screenToPage({ x: screenX + i * 24, y: screenY + i * 24 })
      editor.createShape({
        type: 'node-card',
        x: point.x,
        y: point.y,
        props: {
          nodeType: isTextFile ? 'text' : asset.kind,
          title: asset.name ?? spec.label,
          text: asset.textContent ?? '',
          w: spec.defaultSize.w,
          h: isTextFile ? 200 : spec.defaultSize.h,
          mediaId: asset.id,
          mediaPath: asset.path,
          mediaMime: asset.mime
        } satisfies Partial<NodeCardProps>
      })
    })
  }

  const reportImport = (errors: { path: string; reason: string }[]): void => {
    if (errors.length === 0) return
    const first = errors[0]
    const extra = errors.length > 1 ? ` 等 ${errors.length} 个文件` : ''
    toast(`导入失败：${first.path.split(/[\\/]/).pop()}（${first.reason}）${extra}`)
  }

  const handleUpload = async (screenX: number, screenY: number): Promise<void> => {
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) {
      toast(`上传失败：${res.error.message}`)
      return
    }
    if (res.data.assets.length > 0) createMediaNodes(res.data.assets, screenX, screenY)
    reportImport(res.data.errors)
  }

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = files.map((f) => window.api.getDroppedFilePath(f))
    const res = await window.api.importMedia({ projectId: project.id, paths })
    if (!res.ok) {
      toast(`导入失败：${res.error.message}`)
      return
    }
    if (res.data.assets.length > 0) createMediaNodes(res.data.assets, e.clientX, e.clientY)
    reportImport(res.data.errors)
  }

  const handleMount = (editor: Editor): void => {
    editorRef.current = editor
    if (initialSnapshot) {
      try {
        editor.store.loadStoreSnapshot(editor.store.migrateSnapshot(initialSnapshot as never))
      } catch (e) {
        console.error('快照恢复失败', e)
        restoreFailedRef.current = true
        toast('画布数据恢复失败，已暂停自动保存，以防覆盖原有数据', 6000)
        return
      }
    }
    editor.store.listen(
      () => {
        if (restoreFailedRef.current) return
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(flushSave, 800)
      },
      { scope: 'document' }
    )
  }

  return (
    <div
      className={`canvas-host ${dragOver ? 'drag-over' : ''}`}
      ref={wrapRef}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
    >
      <Tldraw
        onMount={handleMount}
        shapeUtils={[NodeCardUtil]}
        components={{
          Toolbar: null,
          StylePanel: null,
          HelpMenu: null,
          PageMenu: null,
          DebugPanel: null
        }}
      />
      <div className="canvas-rail">
        <button
          className="rail-btn"
          title="添加（点击或按住拖到画布）"
          onPointerDown={startAddDrag}
        >
          ＋
        </button>
        <button
          className="rail-btn"
          title="工作流（即将上线）"
          onClick={() => toast('工作流功能将在后续版本开放')}
        >
          ⛓
        </button>
        <button
          className="rail-btn"
          title="资产（即将上线）"
          onClick={() => toast('资产功能将在后续版本开放')}
        >
          📦
        </button>
        <button
          className="rail-btn"
          title="历史记录（即将上线）"
          onClick={() => toast('历史记录功能将在后续版本开放')}
        >
          🕘
        </button>
        <button
          className="rail-btn"
          title="教程（即将上线）"
          onClick={() => toast('教程功能将在后续版本开放')}
        >
          📖
        </button>
      </div>
      {addDrag && (
        <div className="add-drag-ghost" style={{ left: addDrag.x + 14, top: addDrag.y + 14 }}>
          松开在这里添加节点
        </div>
      )}
      {dragOver && <div className="drop-hint">松开鼠标，上传到画布</div>}
      {menu && (
        <NodeCreateMenu
          x={menu.x}
          y={menu.y}
          onPick={(type) => {
            createNodeAt(type, menu.x, menu.y)
            setMenu(null)
          }}
          onUpload={() => {
            void handleUpload(menu.x, menu.y)
            setMenu(null)
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
