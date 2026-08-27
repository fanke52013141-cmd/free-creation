// 节点悬浮工具栏：媒体节点 hover 出现的「第二功能」工具条（借鉴 infinite-atelier）
// 图片工具（裁剪/拆分/放大/替换）为纯前端 Canvas 处理；处理产物入库后在画布生成新图片节点，
// 形成「原图 → 处理结果」的可视化链路，不破坏原节点。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createShapeId, stopEventPropagation, useEditor, type TLShapeId } from 'tldraw'
import { Icon, type IconName } from '../../components/Icon'
import { useAppStore } from '../../stores/app'
import { useMediaStore } from '../../stores/media'
import { toast } from '../../stores/toast'
import { getNodeType, mediaUrl } from '../../nodes/registry'
import { nodeData } from '../../nodes/nodeData'
import type { NodeCardProps } from '../../canvas/NodeCardShape'
import { markUndoPoint } from '../history'
import type { NodeCardShape } from '../NodeCardShape'
import {
  cropToDataUrl,
  dataUrlToBytes,
  loadImage,
  splitToDataUrls,
  upscaleToDataUrl
} from './imageProcessing'
import {
  readToolbarConfig,
  TOOLBAR_TOOLS,
  writeToolbarConfig,
  type NodeToolbarToolId,
  type ToolbarConfig
} from './nodeToolbarTools'

export interface ToolbarPreviewPayload {
  url: string
  kind: 'image' | 'video' | 'audio'
  title: string
}

type DialogKind = 'crop' | 'split' | 'upscale'

interface DialogState {
  kind: DialogKind
  url: string
  title: string
}

export function NodeHoverToolbar({
  shape,
  onPreview
}: {
  shape: NodeCardShape
  onPreview: (p: ToolbarPreviewPayload) => void
}): React.JSX.Element | null {
  const editor = useEditor()
  const [config, setConfig] = useState<ToolbarConfig>(() => readToolbarConfig())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 命名为 card 而非 props：局部变量叫 props 会被 react/prop-types 误判为组件 props
  const card = shape.props
  const mediaKinds: Record<string, 'image' | 'video' | 'audio'> = {
    image: 'image',
    'image-gen': 'image',
    video: 'video',
    audio: 'audio'
  }
  const kind = mediaKinds[card.nodeType]
  const hasMedia = !!card.mediaPath && kind !== undefined
  const isImage = kind === 'image' && !!card.mediaPath
  if (!hasMedia) return null

  const url = mediaUrl(card.mediaPath)
  const prompt =
    card.nodeType === 'image-gen' && typeof nodeData(card).prompt === 'string'
      ? (nodeData(card).prompt as string)
      : ''

  const available: NodeToolbarToolId[] = isImage
    ? [
        'view',
        ...(prompt.trim() ? (['copyPrompt'] as NodeToolbarToolId[]) : []),
        'crop',
        'split',
        'upscale',
        'replace',
        'reveal'
      ]
    : ['view', 'reveal']
  const visible = TOOLBAR_TOOLS.filter(
    (tool) => available.includes(tool.id) && config.ids.includes(tool.id)
  )

  const runTool = (id: NodeToolbarToolId): void => {
    if (id === 'view') {
      onPreview({ url, kind, title: card.title })
    } else if (id === 'reveal') {
      void window.api.revealMedia(card.mediaId)
    } else if (id === 'copyPrompt') {
      void navigator.clipboard.writeText(prompt)
      toast('提示词已复制到剪贴板')
    } else if (id === 'replace') {
      fileInputRef.current?.click()
    } else {
      setDialog({ kind: id, url, title: card.title })
    }
  }

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const project = useAppStore.getState().currentProject
    if (!file || !project) return
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件')
      return
    }
    setBusy(true)
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const res = await window.api.importMediaBuffer({
        projectId: project.id,
        mime: file.type,
        name: file.name,
        data
      })
      if (!res.ok) {
        toast(`替换失败：${res.error.message}`)
        return
      }
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: {
          mediaId: res.data.id,
          mediaPath: res.data.path,
          mediaMime: res.data.mime
        }
      })
      markUndoPoint(editor, 'node-image-replace')
      void useMediaStore.getState().refresh(project.id)
      toast('已替换图片')
    } finally {
      setBusy(false)
    }
  }

  const commitImages = async (dataUrls: string[], namePrefix: string): Promise<void> => {
    const project = useAppStore.getState().currentProject
    if (!project || dataUrls.length === 0) return
    const spec = getNodeType('image')
    if (!spec) return
    setBusy(true)
    try {
      const created: TLShapeId[] = []
      for (const [i, dataUrl] of dataUrls.entries()) {
        const data = await dataUrlToBytes(dataUrl)
        const res = await window.api.importMediaBuffer({
          projectId: project.id,
          mime: 'image/png',
          name: `${namePrefix}-${i + 1}`,
          data
        })
        if (!res.ok) continue
        const id = createShapeId()
        created.push(id)
        editor.createShape({
          id,
          type: 'node-card',
          x: shape.x + card.w + 70 + Math.floor(i / 3) * (spec.defaultSize.w + 40),
          y: shape.y + (i % 3) * (spec.defaultSize.h + 40),
          props: {
            nodeType: 'image',
            title: `${namePrefix} ${i + 1}`,
            text: '',
            w: spec.defaultSize.w,
            h: spec.defaultSize.h,
            mediaId: res.data.id,
            mediaPath: res.data.path,
            mediaMime: res.data.mime
          } satisfies Partial<NodeCardProps>
        })
      }
      if (created.length > 0) {
        editor.select(...created)
        markUndoPoint(editor, 'node-image-tool')
        void useMediaStore.getState().refresh(project.id)
        toast(`已生成 ${created.length} 个图片节点`)
      } else {
        toast('处理失败：图片未能保存')
      }
    } catch (err) {
      toast(`处理失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const dialogDone = (dataUrls: string[]): void => {
    if (!dialog) return
    const prefix =
      dialog.kind === 'crop'
        ? `裁剪·${dialog.title}`
        : dialog.kind === 'split'
          ? `拆分·${dialog.title}`
          : `放大·${dialog.title}`
    void commitImages(dataUrls, prefix)
    setDialog(null)
  }

  return (
    <>
      <div className="node-toolbar" onPointerDown={(e) => stopEventPropagation(e)}>
        {visible.map((tool) => (
          <button
            key={tool.id}
            className="node-toolbar-btn"
            title={tool.title}
            onClick={() => runTool(tool.id)}
          >
            <Icon name={tool.icon as IconName} size={14} />
            {config.showLabels && <span>{tool.label}</span>}
          </button>
        ))}
        <button
          className="node-toolbar-btn"
          title="配置工具栏按钮"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="more" size={14} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void handleReplaceFile(e)}
      />

      {busy &&
        createPortal(
          <div className="node-tool-mask processing">
            <span>正在处理…</span>
          </div>,
          document.body
        )}

      {dialog?.kind === 'crop' && (
        <CropDialog url={dialog.url} onCancel={() => setDialog(null)} onConfirm={dialogDone} />
      )}
      {dialog?.kind === 'split' && (
        <SplitDialog url={dialog.url} onCancel={() => setDialog(null)} onConfirm={dialogDone} />
      )}
      {dialog?.kind === 'upscale' && (
        <UpscaleDialog url={dialog.url} onCancel={() => setDialog(null)} onConfirm={dialogDone} />
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            writeToolbarConfig(next)
            setConfig(next)
            setSettingsOpen(false)
          }}
        />
      )}
    </>
  )
}

// ── 通用弹窗壳 ──
function ToolModal({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return createPortal(
    <div className="node-tool-mask" onPointerDown={onClose}>
      <div className="node-tool-modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="node-tool-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  )
}

// ── 图片加载态 ──
// 弹窗每次打开都是全新挂载，url 在生命周期内不变，无需在 effect 里重置状态
function useLoadedImage(url: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    let alive = true
    loadImage(url)
      .then((loaded) => {
        if (alive) setImg(loaded)
      })
      .catch(() => toast('图片加载失败'))
    return () => {
      alive = false
    }
  }, [url])
  return img
}

interface DialogProps {
  url: string
  onCancel: () => void
  onConfirm: (dataUrls: string[]) => void
}

// ── 裁剪：拖拽选区 ──
function CropDialog({ url, onCancel, onConfirm }: DialogProps): React.JSX.Element {
  const img = useLoadedImage(url)
  const [sel, setSel] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const scale = img ? Math.min(640 / img.naturalWidth, 420 / img.naturalHeight, 1) : 1
  const dispW = img ? Math.round(img.naturalWidth * scale) : 0
  const dispH = img ? Math.round(img.naturalHeight * scale) : 0

  const pointOf = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = boxRef.current?.getBoundingClientRect()
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 }
  }

  const confirm = async (): Promise<void> => {
    if (!img || !sel) return
    const rect = {
      x: sel.x / scale,
      y: sel.y / scale,
      w: sel.w / scale,
      h: sel.h / scale
    }
    onConfirm([await cropToDataUrl(img, rect)])
  }

  return (
    <ToolModal title="裁剪图片" onClose={onCancel}>
      <div className="node-tool-tip">在图片上拖拽选择要保留的区域，裁剪结果将生成新的图片节点</div>
      <div
        ref={boxRef}
        className="node-tool-stage"
        style={{ width: dispW || undefined, height: dispH || undefined }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          const p = pointOf(e)
          dragRef.current = p
          setSel({ x: p.x, y: p.y, w: 0, h: 0 })
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return
          const p = pointOf(e)
          const start = dragRef.current
          setSel({
            x: Math.min(start.x, p.x),
            y: Math.min(start.y, p.y),
            w: Math.abs(p.x - start.x),
            h: Math.abs(p.y - start.y)
          })
        }}
        onPointerUp={() => {
          dragRef.current = null
          setSel((current) => (current && current.w >= 8 && current.h >= 8 ? current : null))
        }}
      >
        {img && <img src={url} alt="裁剪源图" width={dispW} height={dispH} draggable={false} />}
        {sel && sel.w > 0 && (
          <div
            className="node-tool-sel"
            style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
          />
        )}
      </div>
      <div className="node-tool-foot">
        <span className="node-tool-info">
          {sel && sel.w >= 8
            ? `选区 ${Math.round(sel.w / scale)} × ${Math.round(sel.h / scale)} px`
            : '未选择区域'}
        </span>
        <div className="node-tool-actions">
          <button className="node-tool-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="node-tool-btn primary"
            disabled={!img || !sel || sel.w < 8 || sel.h < 8}
            onClick={() => void confirm()}
          >
            确认裁剪
          </button>
        </div>
      </div>
    </ToolModal>
  )
}

// ── 拆分：行×列网格 ──
function SplitDialog({ url, onCancel, onConfirm }: DialogProps): React.JSX.Element {
  const img = useLoadedImage(url)
  const [cols, setCols] = useState(2)
  const [rows, setRows] = useState(2)

  const scale = img ? Math.min(560 / img.naturalWidth, 360 / img.naturalHeight, 1) : 1
  const dispW = img ? Math.round(img.naturalWidth * scale) : 0
  const dispH = img ? Math.round(img.naturalHeight * scale) : 0

  const confirm = async (): Promise<void> => {
    if (!img) return
    onConfirm(await splitToDataUrls(img, cols, rows))
  }

  return (
    <ToolModal title="拆分图片" onClose={onCancel}>
      <div className="node-tool-tip">按行列把图片切成多块，每块生成一个独立图片节点</div>
      <div className="node-tool-split-layout">
        <div className="node-tool-stage" style={{ width: dispW || 320, height: dispH || 200 }}>
          {img && <img src={url} alt="拆分源图" width={dispW} height={dispH} draggable={false} />}
          {Array.from({ length: cols - 1 }, (_, i) => (
            <div
              key={`v${i}`}
              className="node-tool-gridline-v"
              style={{ left: `${((i + 1) / cols) * 100}%` }}
            />
          ))}
          {Array.from({ length: rows - 1 }, (_, i) => (
            <div
              key={`h${i}`}
              className="node-tool-gridline-h"
              style={{ top: `${((i + 1) / rows) * 100}%` }}
            />
          ))}
        </div>
        <div className="node-tool-split-controls">
          <label className="node-tool-field">
            <span>列数</span>
            <Stepper value={cols} min={1} max={5} onChange={setCols} />
          </label>
          <label className="node-tool-field">
            <span>行数</span>
            <Stepper value={rows} min={1} max={5} onChange={setRows} />
          </label>
          <div className="node-tool-info">将生成 {cols * rows} 个图片节点</div>
        </div>
      </div>
      <div className="node-tool-foot">
        <span className="node-tool-info">
          {img ? `原图 ${img.naturalWidth} × ${img.naturalHeight} px` : '加载中…'}
        </span>
        <div className="node-tool-actions">
          <button className="node-tool-btn" onClick={onCancel}>
            取消
          </button>
          <button className="node-tool-btn primary" disabled={!img} onClick={() => void confirm()}>
            确认拆分
          </button>
        </div>
      </div>
    </ToolModal>
  )
}

function Stepper({
  value,
  min,
  max,
  onChange
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <span className="node-tool-stepper">
      <button
        className="node-tool-step-btn"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <b>{value}</b>
      <button
        className="node-tool-step-btn"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </span>
  )
}

// ── 放大：2x / 4x ──
function UpscaleDialog({ url, onCancel, onConfirm }: DialogProps): React.JSX.Element {
  const img = useLoadedImage(url)
  const [scale, setScale] = useState(2)

  const longEdge = img ? Math.max(img.naturalWidth, img.naturalHeight) : 0
  const capped = longEdge >= 4096
  const ratio = longEdge > 0 ? Math.min(4096 / longEdge, scale) : 1

  const confirm = async (): Promise<void> => {
    if (!img) return
    onConfirm([await upscaleToDataUrl(img, scale)])
  }

  return (
    <ToolModal title="放大图片" onClose={onCancel}>
      <div className="node-tool-tip">
        高质量重采样放大（最长边上限 4096px），结果生成新的图片节点
      </div>
      <div className="node-tool-stage still" style={{ width: 'fit-content' }}>
        {img && (
          <img
            src={url}
            alt="放大源图"
            style={{ maxWidth: 420, maxHeight: 280 }}
            draggable={false}
          />
        )}
      </div>
      <div className="node-tool-foot">
        <span className="node-tool-info">
          {img
            ? capped
              ? `原图 ${img.naturalWidth} × ${img.naturalHeight} px · 已达放大上限`
              : `原图 ${img.naturalWidth} × ${img.naturalHeight} px · 放大后约 ${Math.round(img.naturalWidth * ratio)} × ${Math.round(img.naturalHeight * ratio)}`
            : '加载中…'}
        </span>
        <div className="node-tool-actions">
          <button
            className={`node-tool-btn ${scale === 2 ? 'primary' : ''}`}
            disabled={capped}
            onClick={() => setScale(2)}
          >
            2x
          </button>
          <button
            className={`node-tool-btn ${scale === 4 ? 'primary' : ''}`}
            disabled={capped}
            onClick={() => setScale(4)}
          >
            4x
          </button>
          <button className="node-tool-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="node-tool-btn primary"
            disabled={!img || capped}
            onClick={() => void confirm()}
          >
            确认放大
          </button>
        </div>
      </div>
    </ToolModal>
  )
}

// ── 工具栏设置 ──
function SettingsModal({
  config,
  onClose,
  onSave
}: {
  config: ToolbarConfig
  onClose: () => void
  onSave: (next: ToolbarConfig) => void
}): React.JSX.Element {
  const [ids, setIds] = useState<NodeToolbarToolId[]>(config.ids)
  const [showLabels, setShowLabels] = useState(config.showLabels)

  const toggle = (id: NodeToolbarToolId): void => {
    setIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )
  }

  return (
    <ToolModal title="配置节点工具栏" onClose={onClose}>
      <div className="node-tool-tip">勾选悬浮工具栏显示的按钮；图片工具只对图片类节点生效</div>
      <div className="node-tool-settings-list">
        {TOOLBAR_TOOLS.map((tool) => (
          <label key={tool.id} className="node-tool-setting-row">
            <input
              type="checkbox"
              checked={ids.includes(tool.id)}
              onChange={() => toggle(tool.id)}
            />
            <Icon name={tool.icon as IconName} size={14} />
            <span className="node-tool-setting-label">{tool.label}</span>
            <span className="node-tool-setting-hint">{tool.title}</span>
          </label>
        ))}
        <label className="node-tool-setting-row">
          <input type="checkbox" checked={showLabels} onChange={() => setShowLabels((v) => !v)} />
          <Icon name="text" size={14} />
          <span className="node-tool-setting-label">文字标签</span>
          <span className="node-tool-setting-hint">按钮上显示文字</span>
        </label>
      </div>
      <div className="node-tool-foot">
        <span className="node-tool-info">{ids.length} 个按钮</span>
        <div className="node-tool-actions">
          <button className="node-tool-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="node-tool-btn primary"
            onClick={() => onSave({ ids: ids.length > 0 ? ids : ['view'], showLabels })}
          >
            保存
          </button>
        </div>
      </div>
    </ToolModal>
  )
}
