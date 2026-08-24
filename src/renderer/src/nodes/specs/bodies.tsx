// 节点内容组件（LibTV 式卡片内容区）：五类基础节点 + 脚本节点
// M4 起 Image/Chat/Video 节点接入模型网关（生成 / 流式对话 / 异步任务）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createShapeId, stopEventPropagation, useEditor, type TLShapeId } from 'tldraw'
import type { VideoGenParams } from '@shared/types'
import { mediaUrl, type NodeBodyProps } from '../registry'
import { toast } from '../../stores/toast'
import { markUndoPoint } from '../../canvas/history'
import {
  gatherUpstreamJson,
  gatherUpstreamMedia,
  gatherUpstreamText,
  hasIncomingConnection
} from '../../canvas/graph'
import { parseChat } from '../chatData'
import { generateSlashPrompts, parseSlashCommand } from '../slash-commands'
import { useAppStore } from '../../stores/app'
import { modelsByModality, useGatewayStore } from '../../stores/gateway'
import { Icon } from '../../components/Icon'

// shape.props.text 里的 JSON 解析：失败时返回 fallback（兼容旧纯文本数据，ScriptBody 同款约定）
function parseJsonProp<T>(text: string, validate: (v: unknown) => T | null, fallback: T): T {
  if (!text) return fallback
  try {
    const v = JSON.parse(text) as unknown
    const r = validate(v)
    if (r !== null) return r
  } catch {
    // 非结构化内容按 fallback 处理
  }
  return fallback
}

// 节点内模型选择下拉（按模态过滤全部供应商的模型）
function ModelSelect({
  value,
  options,
  onChange
}: {
  value: string
  options: ReturnType<typeof modelsByModality>
  onChange: (key: string) => void
}): React.JSX.Element {
  return (
    <select
      className="gen-select"
      value={value}
      onPointerDown={(e) => stopEventPropagation(e)}
      onChange={(e) => onChange(e.target.value)}
    >
      {!options.some((o) => o.key === value) && <option value="">选择模型…</option>}
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// 未配置任何对应模态模型时的占位引导
function NoModelHint({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <div className="gen-empty">
      <span>尚未配置可用模型</span>
      <button
        className="btn-ghost small"
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        打开模型设置
      </button>
    </div>
  )
}

// 点击 vs 拖拽判定：拖动卡片时元素随指针移动，pointerup 仍会触发 click，
// 位移超过阈值视为拖拽，不触发预览
function useClickGuard(): {
  onPointerDown: (e: React.PointerEvent) => void
  onClick: (e: React.MouseEvent, open: () => void) => void
} {
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e) => {
      downRef.current = { x: e.clientX, y: e.clientY }
    },
    onClick: (e, open) => {
      const d = downRef.current
      downRef.current = null
      if (!d) return
      if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) return
      e.stopPropagation()
      open()
    }
  }
}

// 卡片内可滚动区域：内容可滚时截断 wheel 冒泡，避免滚动手势被画布抢走（缩放/平移）。
// 必须用原生监听：tldraw 的 wheel 监听在容器上，React 合成事件的 stopPropagation 到不了它
function useWheelScroll(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const canScroll =
        e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
      if (canScroll) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [ref])
}

export function TextBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

  // Slash 指令检测：/九宫格 /25宫格 /三视图
  const slashCmd = parseSlashCommand(shape.props.text)

  const commit = (): void => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
      markUndoPoint(editor, 'text-edit')
    }
  }

  // 一键生成宫格图片节点
  const generateSlashGrid = (): void => {
    if (!slashCmd || !slashCmd.subject) {
      toast('请在指令后输入主题，例如：/三视图 穿和服的女孩')
      return
    }
    const prompts = generateSlashPrompts(slashCmd.command, slashCmd.subject)
    const cols = slashCmd.command.cols
    const startX = shape.x + shape.props.w + 60
    const startY = shape.y - 40
    const nodeW = 340
    const nodeH = 260
    const gap = 12
    const ids: TLShapeId[] = []

    editor.run(() => {
      prompts.forEach((prompt, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const id = createShapeId()
        ids.push(id)
        editor.createShape({
          id,
          type: 'node-card',
          x: startX + col * (nodeW + gap),
          y: startY + row * (nodeH + gap),
          props: {
            nodeType: 'image-gen',
            title: `${slashCmd.command.label} ${i + 1}`,
            w: 340,
            h: 260,
            text: JSON.stringify({ prompt, modelKey: '', size: 'auto' })
          }
        })
      })
    })
    markUndoPoint(editor, 'slash-generate')
    toast(`已创建 ${prompts.length} 个生图节点，逐个点击生成`)
  }

  if (editing) {
    return (
      <textarea
        className="node-textarea"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') commit()
        }}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
    )
  }

  return (
    <div
      className="node-text"
      ref={scrollRef}
      onPointerDown={(e) => stopEventPropagation(e)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(shape.props.text)
        setEditing(true)
      }}
    >
      {shape.props.text || <span className="node-hint">双击输入文本内容</span>}
      {slashCmd && (
        <div className="slash-cmd-bar">
          <div className="slash-cmd-info">
            <span className="slash-cmd-icon">
              <Icon name={slashCmd.command.icon} size={14} />
            </span>
            <span>{slashCmd.command.label}</span>
            {slashCmd.subject ? (
              <span className="slash-cmd-subject">：{slashCmd.subject.slice(0, 20)}</span>
            ) : (
              <span className="slash-cmd-warn">（请输入主题）</span>
            )}
          </div>
          <button
            className="slash-cmd-gen"
            disabled={!slashCmd.subject}
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              generateSlashGrid()
            }}
          >
            <>
              <Icon name="spark" size={13} /> 生成{slashCmd.command.count}图
            </>
          </button>
        </div>
      )}
    </div>
  )
}

// 图片生成节点：props.text 存 {prompt, modelKey, size}（旧纯文本数据视为提示词）
interface ImageGenData {
  prompt: string
  modelKey: string
  size: string
}

function parseImageGen(text: string): ImageGenData {
  return parseJsonProp(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null && typeof o.prompt === 'string') {
        return {
          prompt: o.prompt,
          modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
          size: typeof o.size === 'string' ? o.size : 'auto'
        }
      }
      return null
    },
    { prompt: '', modelKey: '', size: 'auto' }
  )
}

const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']

/**
 * 图片资产与生图职责分离：资产节点只表示一份可复用图片数据，
 * 不再混入模型、提示词或生成按钮。
 */
export function ImageBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)

  const chooseAsset = async (): Promise<void> => {
    if (!project) return
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) return toast(`导入失败：${res.error.message}`)
    const asset = res.data.assets.find((item) => item.kind === 'image')
    if (!asset) return toast('请选择一张图片文件')
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        title: asset.name || '图片',
        mediaId: asset.id,
        mediaPath: asset.path,
        mediaMime: asset.mime
      }
    })
    markUndoPoint(editor, 'image-asset-import')
  }

  if (!shape.props.mediaPath) {
    return (
      <div className="asset-empty">
        <Icon name="image" size={24} />
        <span>图片资产</span>
        <small>上传或粘贴图片后，可连接给生图、视频等节点。</small>
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void chooseAsset()
          }}
        >
          导入图片
        </button>
      </div>
    )
  }

  return (
    <div
      className="node-media"
      onPointerDown={guard.onPointerDown}
      onClick={(e) =>
        guard.onClick(e, () =>
          openPreview({
            kind: 'image',
            url: mediaUrl(shape.props.mediaPath),
            title: shape.props.title
          })
        )
      }
    >
      <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
    </div>
  )
}

export function ImageGenerateBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'image')
  const data = parseImageGen(shape.props.text)
  const [draft, setDraft] = useState(data.prompt)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const update = (next: ImageGenData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  const refImage = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')

  const generate = async (): Promise<void> => {
    const opt = options.find((o) => o.key === data.modelKey)
    if (!opt) return toast('请先选择图片模型')
    const upstream = gatherUpstreamText(editor, shape.id)
    const prompt = upstream ? `${upstream}\n\n---\n\n${draft.trim()}` : draft.trim()
    if (!prompt) return toast('请输入提示词或连接上游文本')
    if (!project) return toast('项目未就绪')
    setBusy(true)
    const res = await window.api.gateway.imageGenerate({
      projectId: project.id,
      providerId: opt.provider.id,
      modelId: opt.model.id,
      prompt,
      size: data.size,
      ...(refImage ? { referenceMediaId: refImage.mediaId } : {})
    })
    setBusy(false)
    if (!res.ok) return toast(`生成失败：${res.error.message}`)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        mediaId: res.data.id,
        mediaPath: res.data.path,
        mediaMime: res.data.mime,
        title: res.data.name || res.data.id
      }
    })
    markUndoPoint(editor, 'image-gen')
  }

  if (shape.props.mediaPath) {
    return (
      <div
        className="node-media"
        onPointerDown={guard.onPointerDown}
        onClick={(e) =>
          guard.onClick(e, () =>
            openPreview({
              kind: 'image',
              url: mediaUrl(shape.props.mediaPath),
              title: shape.props.title
            })
          )
        }
      >
        <img src={mediaUrl(shape.props.mediaPath)} alt={shape.props.title} draggable={false} />
      </div>
    )
  }

  if (!options.length) return <NoModelHint onOpen={openSettings} />

  return (
    <div className="gen-panel">
      {refImage && (
        <div className="ref-image-bar">
          <img
            src={mediaUrl(refImage.mediaPath)}
            className="ref-image-thumb"
            draggable={false}
            alt="参考图"
          />
          <span className="ref-image-label">
            <Icon name="attach" size={13} />
            参考图已连接
          </span>
        </div>
      )}
      <div className="gen-row">
        <ModelSelect
          value={data.modelKey}
          options={options}
          onChange={(key) => update({ ...data, modelKey: key })}
        />
        <select
          className="gen-select w92"
          value={data.size}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, size: e.target.value })}
        >
          {IMAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s === 'auto' ? '默认尺寸' : s}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="gen-prompt"
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder="描述要生成的画面…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => update({ ...data, prompt: draft })}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
      <button
        className="btn-primary small gen-go"
        disabled={busy}
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void generate()
        }}
      >
        {busy ? (
          '生成中…'
        ) : (
          <>
            <Icon name="spark" size={14} />
            生成图片
          </>
        )}
      </button>
    </div>
  )
}

// 视频节点：props.text 存 {prompt, modelKey, params, taskId}；
// 生成走异步任务（MiniMax H3 / Seedance），进度经网关事件推送
interface VideoGenData {
  prompt: string
  modelKey: string
  params: VideoGenParams
  taskId: string
}

function parseVideoGen(text: string): VideoGenData {
  return parseJsonProp<VideoGenData>(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null && typeof o.prompt === 'string') {
        const params = (typeof o.params === 'object' && o.params !== null ? o.params : {}) as {
          ratio?: unknown
          duration?: unknown
          resolution?: unknown
        }
        return {
          prompt: o.prompt,
          modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
          params: {
            ratio: typeof params.ratio === 'string' ? params.ratio : undefined,
            duration: typeof params.duration === 'number' ? params.duration : undefined,
            resolution: typeof params.resolution === 'string' ? params.resolution : undefined
          },
          taskId: typeof o.taskId === 'string' ? o.taskId : ''
        }
      }
      return null
    },
    { prompt: '', modelKey: '', params: {}, taskId: '' }
  )
}

const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']
const VIDEO_DURATIONS = [4, 5, 6, 8, 10, 12, 15]

export function VideoBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'video')
  const data = parseVideoGen(shape.props.text)
  const [draft, setDraft] = useState(data.prompt)
  const [status, setStatus] = useState<string>(data.taskId ? 'running' : '')
  const [submitting, setSubmitting] = useState(false)
  const dataRef = useRef(data)
  useLayoutEffect(() => {
    dataRef.current = data
  }, [data])

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const update = (next: VideoGenData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  // 挂载时核对持久化的任务：成功则补媒体，终态失败则允许重试，进行中则等事件
  useEffect(() => {
    if (!data.taskId) return
    void (async () => {
      const res = await window.api.gateway.videoTask(data.taskId)
      if (!res.ok || !res.data) return
      if (res.data.status === 'success' && res.data.mediaPath) {
        editor.updateShape({
          id: shape.id,
          type: 'node-card',
          props: {
            mediaId: res.data.mediaId ?? '',
            mediaPath: res.data.mediaPath,
            mediaMime: 'video/mp4',
            title: 'video'
          }
        })
      } else if (res.data.status === 'failed' || res.data.status === 'cancelled') {
        setStatus('')
        update({ ...dataRef.current, taskId: '' })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.taskId])

  // 网关事件：本节点任务的视频进度
  useEffect(() => {
    const off = window.api.gateway.onEvent((e) => {
      if (e.taskId !== dataRef.current.taskId) return
      if (e.kind === 'video-status') {
        setStatus(e.status)
      } else if (e.kind === 'video-done') {
        editor.updateShape({
          id: shape.id,
          type: 'node-card',
          props: {
            mediaId: e.mediaId,
            mediaPath: e.mediaPath,
            mediaMime: e.mime,
            title: e.name
          }
        })
        markUndoPoint(editor, 'video-gen')
      } else if (e.kind === 'video-error') {
        toast(`视频生成失败：${e.error}`)
        setStatus('')
        update({ ...dataRef.current, taskId: '' })
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (): Promise<void> => {
    const opt = options.find((o) => o.key === data.modelKey)
    if (!opt) return toast('请先选择视频模型')
    const upstream = gatherUpstreamText(editor, shape.id)
    const prompt = upstream ? `${upstream}\n\n---\n\n${draft.trim()}` : draft.trim()
    if (!prompt) return toast('请输入提示词或连接上游文本')
    if (!project) return toast('项目未就绪')
    const firstFrameMediaId = gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')?.mediaId
    setSubmitting(true)
    const res = await window.api.gateway.videoSubmit({
      projectId: project.id,
      nodeId: shape.id,
      providerId: opt.provider.id,
      modelId: opt.model.id,
      prompt,
      params: data.params,
      ...(firstFrameMediaId ? { firstFrameMediaId } : {})
    })
    setSubmitting(false)
    if (!res.ok) return toast(`提交失败：${res.error.message}`)
    update({ ...data, prompt: draft, taskId: res.data.taskId })
    setStatus('running')
  }

  const cancel = async (): Promise<void> => {
    if (!data.taskId) return
    await window.api.gateway.videoCancel(data.taskId)
    setStatus('')
    update({ ...data, taskId: '' })
  }

  if (shape.props.mediaPath) {
    return (
      <div
        className="node-media"
        onPointerDown={guard.onPointerDown}
        onClick={(e) =>
          guard.onClick(e, () =>
            openPreview({
              kind: 'video',
              url: mediaUrl(shape.props.mediaPath),
              title: shape.props.title
            })
          )
        }
      >
        <video src={mediaUrl(shape.props.mediaPath)} preload="metadata" muted playsInline />
        <span className="play-badge">▶</span>
      </div>
    )
  }

  if (status === 'running' || status === 'submitted') {
    return (
      <div className="gen-panel">
        <div className="gen-running">
          <span className="gen-spin">◌</span>
          <div>
            <div>视频生成中…（约 1~5 分钟）</div>
            <div className="dim">任务已持久化，可关闭窗口稍后回来</div>
          </div>
        </div>
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            void cancel()
          }}
        >
          取消任务
        </button>
      </div>
    )
  }

  if (!options.length) return <NoModelHint onOpen={openSettings} />

  // 分辨率选项跟随供应商（MiniMax: 768P/2K，Seedance: 480p/720p/1080p）
  const opt = options.find((o) => o.key === data.modelKey)
  const resolutions =
    opt?.provider.specId === 'minimax' ? ['768P', '2K'] : ['480p', '720p', '1080p']

  return (
    <div className="gen-panel">
      <ModelSelect
        value={data.modelKey}
        options={options}
        onChange={(key) => update({ ...data, modelKey: key })}
      />
      <textarea
        className="gen-prompt"
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder="描述视频内容、镜头与氛围…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => update({ ...data, prompt: draft })}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
      <div className="gen-row">
        <select
          className="gen-select"
          value={data.params.ratio ?? '16:9'}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, params: { ...data.params, ratio: e.target.value } })}
        >
          {VIDEO_RATIOS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          className="gen-select w70"
          value={String(data.params.duration ?? 5)}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) =>
            update({ ...data, params: { ...data.params, duration: Number(e.target.value) } })
          }
        >
          {VIDEO_DURATIONS.map((d) => (
            <option key={d} value={d}>
              {d}s
            </option>
          ))}
        </select>
        <select
          className="gen-select w86"
          value={data.params.resolution ?? resolutions[1]}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) =>
            update({ ...data, params: { ...data.params, resolution: e.target.value } })
          }
        >
          {resolutions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <button
        className="btn-primary small gen-go"
        disabled={submitting}
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void submit()
        }}
      >
        {submitting ? (
          '提交中…'
        ) : (
          <>
            <Icon name="video" size={14} />
            生成视频
          </>
        )}
      </button>
    </div>
  )
}

type AudioMode = 'upload' | 'generate'

interface AudioData {
  mode: AudioMode
  modelKey: string
  text: string
  voice: string
  format: string
}

function parseAudioGen(text: string): AudioData {
  return parseJsonProp(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null) {
        return {
          mode: o.mode === 'generate' ? 'generate' : 'upload',
          modelKey: typeof o.modelKey === 'string' ? o.modelKey : '',
          text: typeof o.text === 'string' ? o.text : '',
          voice: typeof o.voice === 'string' ? o.voice : 'alloy',
          format: typeof o.format === 'string' ? o.format : 'mp3'
        }
      }
      return null
    },
    { mode: 'upload', modelKey: '', text: '', voice: 'alloy', format: 'mp3' }
  )
}

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
const AUDIO_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']

export function AudioBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'audio')
  const data = parseAudioGen(shape.props.text)
  const [draft, setDraft] = useState(data.text)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const update = (next: AudioData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  const uploadAudio = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    const res = await window.api.pickMedia(project.id)
    if (!res.ok) return toast(`上传失败：${res.error.message}`)
    const audioAsset = res.data.assets.find((a) => a.kind === 'audio')
    if (!audioAsset) return
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        mediaId: audioAsset.id,
        mediaPath: audioAsset.path,
        mediaMime: audioAsset.mime,
        title: audioAsset.name ?? shape.props.title
      }
    })
    markUndoPoint(editor, 'audio-upload')
  }

  const togglePlay = (): void => {
    if (!shape.props.mediaPath) return
    if (playing) {
      audioRef.current?.pause()
      setPlaying(false)
    } else {
      const el = audioRef.current ?? new Audio(mediaUrl(shape.props.mediaPath))
      audioRef.current = el
      el.loop = true
      el.currentTime = 0
      void el.play().then(() => setPlaying(true))
      el.onended = () => setPlaying(false)
      el.onpause = () => setPlaying(false)
    }
  }

  const removeAudio = (): void => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlaying(false)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { mediaId: '', mediaPath: '', mediaMime: '' }
    })
    markUndoPoint(editor, 'audio-remove')
  }

  const generate = async (): Promise<void> => {
    const opt = options.find((o) => o.key === data.modelKey)
    if (!opt) return toast('请先选择音频模型')
    const upstream = gatherUpstreamText(editor, shape.id)
    const text = upstream ? `${upstream}\n\n---\n\n${draft.trim()}` : draft.trim()
    if (!text) return toast('请输入要朗读的文本或连接上游文本')
    if (!project) return toast('项目未就绪')
    setBusy(true)
    const res = await window.api.gateway.audioGenerate({
      projectId: project.id,
      providerId: opt.provider.id,
      modelId: opt.model.id,
      text,
      voice: data.voice,
      format: data.format
    })
    setBusy(false)
    if (!res.ok) return toast(`生成失败：${res.error.message}`)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        mediaId: res.data.id,
        mediaPath: res.data.path,
        mediaMime: res.data.mime,
        title: res.data.name || res.data.id
      }
    })
    markUndoPoint(editor, 'audio-gen')
  }

  // ── 已有音频文件：播放器视图（上传或生成共用） ──
  if (shape.props.mediaPath) {
    const isGenerated = data.mode === 'generate'
    return (
      <div className="node-audio-player">
        <div className={`audio-player-wave ${playing ? 'playing' : ''}`}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
        </div>
        <div className="audio-player-info">
          <span className="audio-player-name">{shape.props.title}</span>
        </div>
        <div className="audio-player-actions">
          <button
            className="audio-play-btn"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              togglePlay()
            }}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <button
            className="btn-ghost small"
            title="打开播放器"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              if (playing) {
                audioRef.current?.pause()
                setPlaying(false)
              }
              openPreview({
                kind: 'audio',
                url: mediaUrl(shape.props.mediaPath),
                title: shape.props.title
              })
            }}
          >
            展开
          </button>
          <button
            className="btn-ghost small danger"
            title={isGenerated ? '重新生成' : '替换文件'}
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              if (isGenerated) {
                removeAudio()
              } else {
                void uploadAudio()
              }
            }}
          >
            {isGenerated ? '重新生成' : '替换'}
          </button>
        </div>
      </div>
    )
  }

  // ── 无音频文件：模式切换 ──
  return (
    <div className="node-audio-empty">
      <div className="audio-mode-tabs">
        <button
          className={`audio-tab ${data.mode === 'upload' ? 'active' : ''}`}
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            update({ ...data, mode: 'upload' })
          }}
        >
          <>
            <Icon name="upload" size={14} />
            上传文件
          </>
        </button>
        <button
          className={`audio-tab ${data.mode === 'generate' ? 'active' : ''}`}
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            update({ ...data, mode: 'generate' })
          }}
        >
          <>
            <Icon name="audio" size={14} />
            语音合成
          </>
        </button>
      </div>

      {data.mode === 'upload' ? (
        <div className="audio-upload-zone" onPointerDown={(e) => stopEventPropagation(e)}>
          <button
            className="audio-upload-btn"
            onClick={(e) => {
              e.stopPropagation()
              void uploadAudio()
            }}
          >
            <span className="audio-upload-icon">
              <Icon name="audio" size={22} />
            </span>
            <span className="audio-upload-text">点击上传音频文件</span>
            <span className="audio-upload-hint">支持 mp3 / wav / aac / flac 等</span>
          </button>
        </div>
      ) : (
        <div className="node-audio-gen">
          <div className="gen-toolbar">
            {options.length === 0 ? (
              loaded ? (
                <span className="hint">未配置音频模型</span>
              ) : (
                <span className="hint">加载中…</span>
              )
            ) : (
              <ModelSelect
                value={data.modelKey}
                options={options}
                onChange={(key) => update({ ...data, modelKey: key })}
              />
            )}
            {loaded && options.length === 0 && (
              <button
                className="btn-ghost small"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  void openSettings()
                }}
              >
                配置
              </button>
            )}
          </div>
          <textarea
            className="gen-textarea audio"
            value={draft}
            placeholder="输入要朗读的文本…"
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="audio-options">
            <label className="opt-label">音色</label>
            <select
              className="gen-select small"
              value={data.voice}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => update({ ...data, voice: e.target.value })}
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <label className="opt-label">格式</label>
            <select
              className="gen-select small"
              value={data.format}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => update({ ...data, format: e.target.value })}
            >
              {AUDIO_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn-generate"
            disabled={busy}
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              void generate()
            }}
          >
            {busy ? (
              '生成中…'
            ) : (
              <>
                <Icon name="audio" size={14} />
                生成语音
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

/** 对话节点卡片内的紧凑展示：选中后通过右侧 ChatSidePanel 进行完整对话 */
export function ChatBody({ shape }: NodeBodyProps): React.JSX.Element {
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const options = modelsByModality(providers, 'text')
  const data = parseChat(shape.props.text)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const selectedModel = options.find((o) => o.key === data.modelKey)
  const modelName = selectedModel
    ? selectedModel.model.name || selectedModel.model.id
    : '未选择模型'

  return (
    <div className="chat-body-compact">
      <div className="chat-compact-model">
        <Icon name="chat" size={14} />
        {modelName}
      </div>
      <div className="chat-compact-stats">
        {data.messages.length > 0 ? `${data.messages.length} 条对话` : '暂无对话'}
        {' · '}T{data.temperature.toFixed(1)} · {data.maxTokens} tok
      </div>
      <div className="chat-compact-hint">选中此节点 → 右侧面板对话</div>
    </div>
  )
}

// ── 脚本节点（LibTV 式 AI 分镜）──
// 数据存 shape.props.text（JSON 字符串），不改 tldraw 形状 schema，旧快照零迁移：
// 解析失败时把原文当作剧本文本，兼容「文本节点内容直接粘贴」的旧数据
// shape.props.text 里的 JSON 结构：{ source, shots, modelKey }
interface ScriptShot {
  id: string
  scene: string
  dialogue: string
  duration: string
  [key: string]: unknown
}

interface ScriptOutputField {
  id: string
  path: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
}

interface ScriptData {
  source: string
  shots: ScriptShot[]
  /** AI 拆解用的对话模型 key（`${providerId}::${modelId}`），空串表示未选 */
  modelKey?: string
  outputFields: ScriptOutputField[]
}

const DEFAULT_SCRIPT_FIELDS: ScriptOutputField[] = [
  { id: 'scene', path: 'scene', label: '画面描述', type: 'string', description: '镜头画面与构图' },
  {
    id: 'dialogue',
    path: 'dialogue',
    label: '台词',
    type: 'string',
    description: '角色台词或旁白'
  },
  {
    id: 'sound',
    path: 'sound',
    label: '音效',
    type: 'string',
    description: '环境声、动作声或音乐'
  },
  { id: 'duration', path: 'duration', label: '时长', type: 'string', description: '例如 3s' }
]

const emptyShot = (): ScriptShot => ({
  id: Math.random().toString(36).slice(2, 9),
  scene: '',
  dialogue: '',
  sound: '',
  duration: ''
})

function normalizeShot(v: unknown): ScriptShot {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    ...o,
    id: typeof o.id === 'string' ? o.id : Math.random().toString(36).slice(2, 9),
    scene: typeof o.scene === 'string' ? o.scene : '',
    dialogue: typeof o.dialogue === 'string' ? o.dialogue : '',
    duration: typeof o.duration === 'string' ? o.duration : ''
  }
}

function parseScript(text: string): ScriptData {
  if (!text) return { source: '', shots: [], outputFields: DEFAULT_SCRIPT_FIELDS }
  try {
    const v = JSON.parse(text) as {
      source?: unknown
      shots?: unknown
      modelKey?: unknown
      outputFields?: unknown
    }
    if (v && typeof v === 'object' && Array.isArray(v.shots)) {
      const outputFields = Array.isArray(v.outputFields)
        ? v.outputFields
            .map((field) => field as Partial<ScriptOutputField>)
            .filter(
              (field): field is ScriptOutputField =>
                typeof field.id === 'string' &&
                typeof field.path === 'string' &&
                typeof field.label === 'string' &&
                ['string', 'number', 'boolean', 'object', 'array'].includes(field.type ?? '')
            )
            .map((field) => ({ ...field, description: field.description ?? '' }))
        : DEFAULT_SCRIPT_FIELDS
      return {
        source: typeof v.source === 'string' ? v.source : '',
        shots: v.shots.map(normalizeShot),
        modelKey: typeof v.modelKey === 'string' ? v.modelKey : undefined,
        outputFields: outputFields.length > 0 ? outputFields : DEFAULT_SCRIPT_FIELDS
      }
    }
  } catch {
    // 非结构化内容视为剧本文本
  }
  return { source: text, shots: [], outputFields: DEFAULT_SCRIPT_FIELDS }
}

const SCRIPT_MAX_H = 640

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return
  let current = target
  for (const part of parts.slice(0, -1)) {
    const existing = current[part]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function getNestedValue(target: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined
      return (current as Record<string, unknown>)[part]
    }, target)
}

function buildStoryboardSystemPrompt(fields: ScriptOutputField[]): string {
  const example: Record<string, unknown> = {}
  for (const field of fields) {
    const sample =
      field.type === 'number'
        ? 0
        : field.type === 'boolean'
          ? false
          : field.type === 'array'
            ? []
            : field.type === 'object'
              ? {}
              : field.description || field.label
    setNestedValue(example, field.path, sample)
  }
  const definitions = fields
    .map((field) => `- ${field.path} (${field.type})：${field.description || field.label}`)
    .join('\n')
  return `你是一位专业的影视分镜导演。请将用户提供的剧本文本拆解为分镜列表。
输出要求：
1. 只输出一个 JSON 数组，不要添加其他文字或 Markdown 标记
2. 每个数组元素必须严格遵守以下字段定义，不能改名：
${definitions}
3. 字段路径中的点表示 JSON 层级，例如 camera.angle 表示 {"camera":{"angle":"..."}}
4. 根据剧情节奏合理划分镜头，画面描述应具体、可视化
单个元素结构示例：${JSON.stringify(example)}`
}

// 从 AI 响应中提取 JSON 数组
function extractShotsJson(raw: string): ScriptShot[] | null {
  const text = raw.trim()
  // 尝试直接解析
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v.map(normalizeShot)
  } catch {
    // 继续
  }
  // 尝试提取 ```json ... ``` 或 [ ... ] 块
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      const v = JSON.parse(jsonMatch[1].trim())
      if (Array.isArray(v)) return v.map(normalizeShot)
    } catch {
      // 继续
    }
  }
  const bracketStart = text.indexOf('[')
  const bracketEnd = text.lastIndexOf(']')
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    try {
      const v = JSON.parse(text.slice(bracketStart, bracketEnd + 1))
      if (Array.isArray(v)) return v.map(normalizeShot)
    } catch {
      // 继续
    }
  }
  return null
}

export function ScriptBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseScript(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 离散操作（加/删/移镜头）的分段点名：不在 handler 里立即打点，
  // 等下方布局副作用把自动撑高的 h 变更并入同一步后再打，避免污染撤销粒度
  const pendingMarkRef = useRef<string | null>(null)
  useWheelScroll(scrollRef)

  // AI 拆解状态
  const [breaking, setBreaking] = useState(false)
  const [showOutputSettings, setShowOutputSettings] = useState(false)
  const breakTaskRef = useRef<string | null>(null)
  const breakBufRef = useRef<string>('')
  const providers = useGatewayStore((s) => s.providers)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const chatModels = modelsByModality(providers, 'text')

  const update = (next: ScriptData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  // 离开输入框时打撤销分段点：连续敲键在 pendingDiff 里自然合并为一步，
  // 分段点保证「本次编辑会话」与后续操作（加镜头等）不粘连
  const markSession = (): void => markUndoPoint(editor, 'script-edit')

  const patchShot = (id: string, patch: Partial<ScriptShot>): void => {
    update({ ...data, shots: data.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }

  const patchShotPath = (id: string, path: string, value: unknown): void => {
    update({
      ...data,
      shots: data.shots.map((shot) => {
        if (shot.id !== id) return shot
        const next = structuredClone(shot) as ScriptShot
        setNestedValue(next, path, value)
        return next
      })
    })
  }

  const moveShot = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= data.shots.length) return
    const shots = [...data.shots]
    ;[shots[index], shots[target]] = [shots[target], shots[index]]
    update({ ...data, shots })
    pendingMarkRef.current = 'shot-move'
  }

  // ── AI 拆解剧本：调用对话模型将剧本文本转为结构化分镜 ──
  useEffect(() => {
    const off = window.api.gateway.onEvent((e) => {
      if (!breakTaskRef.current || e.taskId !== breakTaskRef.current) return
      if (e.kind === 'chat-delta') {
        breakBufRef.current += e.text
      } else if (e.kind === 'chat-done') {
        const shots = extractShotsJson(breakBufRef.current)
        breakTaskRef.current = null
        breakBufRef.current = ''
        setBreaking(false)
        if (shots && shots.length > 0) {
          update({ ...data, shots })
          pendingMarkRef.current = 'shot-breakdown'
          toast(`AI 拆解完成，生成 ${shots.length} 个镜头`)
        } else {
          toast('AI 拆解结果解析失败，请检查模型输出或换一个模型重试')
        }
      } else if (e.kind === 'chat-error') {
        breakTaskRef.current = null
        breakBufRef.current = ''
        setBreaking(false)
        toast(`AI 拆解失败：${e.error}`)
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const breakdown = async (): Promise<void> => {
    if (breaking) {
      // 正在拆解中 → 取消
      if (breakTaskRef.current) {
        await window.api.gateway.chatCancel(breakTaskRef.current)
      }
      breakTaskRef.current = null
      breakBufRef.current = ''
      setBreaking(false)
      return
    }
    const upstream = gatherUpstreamText(editor, shape.id)
    const source = upstream ? `${upstream}\n\n---\n\n${data.source.trim()}` : data.source.trim()
    if (!source) {
      toast('请先输入剧本文本或连接上游文本')
      return
    }
    const modelKey = data.modelKey ?? ''
    const opt = chatModels.find((m) => m.key === modelKey) ?? chatModels[0]
    if (!opt) {
      toast('请先在设置中配置对话模型')
      return
    }
    // 持久化选中的 modelKey
    if (data.modelKey !== opt.key) {
      update({ ...data, modelKey: opt.key })
    }
    breakBufRef.current = ''
    setBreaking(true)
    const res = await window.api.gateway.chatStart({
      providerId: opt.provider.id,
      modelId: opt.model.id,
      system: buildStoryboardSystemPrompt(data.outputFields),
      messages: [{ role: 'user', content: source }]
    })
    if (!res.ok) {
      setBreaking(false)
      toast(`发送失败：${res.error.message}`)
      return
    }
    breakTaskRef.current = res.data.taskId
  }

  // 内容增高时自动撑高卡片（只增不减，上限后内部滚动），手动缩放不被覆盖
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const need = el.scrollHeight + 2
    if (need > shape.props.h && shape.props.h < SCRIPT_MAX_H) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { h: Math.min(SCRIPT_MAX_H, need) }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.shots.length, data.source.length, data.outputFields.length, showOutputSettings])

  // 在高度副作用之后执行：此刻文本+高度变更都已落入同一段 pendingDiff，再打分段点
  useLayoutEffect(() => {
    const name = pendingMarkRef.current
    if (!name) return
    pendingMarkRef.current = null
    markUndoPoint(editor, name)
  })

  return (
    <div className="script-body" ref={scrollRef}>
      <textarea
        className="script-source"
        value={data.source}
        rows={3}
        spellCheck={false}
        placeholder="输入或粘贴剧本文本…（点击「AI 拆解」可一键生成分镜）"
        onChange={(e) => update({ ...data, source: e.target.value })}
        onBlur={markSession}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
      {showOutputSettings && (
        <div className="script-output-settings">
          <div className="script-output-head">
            <div>
              <strong>输出结构</strong>
              <span>支持用点号定义层级，如 camera.angle</span>
            </div>
            <button
              className="btn-ghost small"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                setShowOutputSettings(false)
              }}
            >
              完成
            </button>
          </div>
          <div className="script-field-list">
            {data.outputFields.map((field, index) => (
              <div className="script-field-row" key={field.id}>
                <input
                  value={field.label}
                  aria-label={`字段 ${index + 1} 名称`}
                  placeholder="名称"
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    update({
                      ...data,
                      outputFields: data.outputFields.map((item) =>
                        item.id === field.id ? { ...item, label: e.target.value } : item
                      )
                    })
                  }
                />
                <input
                  value={field.path}
                  aria-label={`字段 ${index + 1} 路径`}
                  placeholder="字段路径"
                  spellCheck={false}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    update({
                      ...data,
                      outputFields: data.outputFields.map((item) =>
                        item.id === field.id ? { ...item, path: e.target.value } : item
                      )
                    })
                  }
                />
                <select
                  value={field.type}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    update({
                      ...data,
                      outputFields: data.outputFields.map((item) =>
                        item.id === field.id
                          ? { ...item, type: e.target.value as ScriptOutputField['type'] }
                          : item
                      )
                    })
                  }
                >
                  {VARIABLE_TYPES.filter((item) => item.value !== 'any').map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  className="shot-op danger"
                  title="删除字段"
                  disabled={data.outputFields.length <= 1}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onClick={() =>
                    update({
                      ...data,
                      outputFields: data.outputFields.filter((item) => item.id !== field.id)
                    })
                  }
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={() =>
              update({
                ...data,
                outputFields: [
                  ...data.outputFields,
                  {
                    id: Math.random().toString(36).slice(2, 9),
                    path: `field_${data.outputFields.length + 1}`,
                    label: `字段${data.outputFields.length + 1}`,
                    type: 'string',
                    description: ''
                  }
                ]
              })
            }
          >
            <Icon name="add" size={13} /> 添加字段
          </button>
        </div>
      )}
      {data.shots.length > 0 && (
        <div className="script-shots">
          {data.shots.map((shot, i) => (
            <div className="shot-row" key={shot.id}>
              <span className="shot-no">{i + 1}</span>
              <div className="shot-fields">
                <textarea
                  className="shot-scene"
                  value={shot.scene}
                  rows={2}
                  spellCheck={false}
                  placeholder="画面描述…"
                  onChange={(e) => patchShot(shot.id, { scene: e.target.value })}
                  onBlur={markSession}
                  onPointerDown={(e) => stopEventPropagation(e)}
                />
                <div className="shot-meta">
                  <input
                    className="shot-dialogue"
                    value={shot.dialogue}
                    spellCheck={false}
                    placeholder="台词 / 音效"
                    onChange={(e) => patchShot(shot.id, { dialogue: e.target.value })}
                    onBlur={markSession}
                    onPointerDown={(e) => stopEventPropagation(e)}
                  />
                  <input
                    className="shot-duration"
                    value={shot.duration}
                    spellCheck={false}
                    placeholder="时长"
                    onChange={(e) => patchShot(shot.id, { duration: e.target.value })}
                    onBlur={markSession}
                    onPointerDown={(e) => stopEventPropagation(e)}
                  />
                </div>
                {data.outputFields
                  .filter((field) => !['scene', 'dialogue', 'duration'].includes(field.path))
                  .map((field) => {
                    const raw = getNestedValue(shot, field.path)
                    const value =
                      typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
                    return (
                      <label className="shot-custom-field" key={field.id}>
                        <span>{field.label || field.path}</span>
                        <input
                          value={value}
                          spellCheck={false}
                          placeholder={field.path}
                          onPointerDown={(e) => stopEventPropagation(e)}
                          onChange={(e) => patchShotPath(shot.id, field.path, e.target.value)}
                          onBlur={markSession}
                        />
                      </label>
                    )
                  })}
              </div>
              <div className="shot-ops">
                <button
                  className="shot-op"
                  title="上移"
                  disabled={i === 0}
                  onClick={() => moveShot(i, -1)}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  ↑
                </button>
                <button
                  className="shot-op"
                  title="下移"
                  disabled={i === data.shots.length - 1}
                  onClick={() => moveShot(i, 1)}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  ↓
                </button>
                <button
                  className="shot-op danger"
                  title="删除镜头"
                  onClick={() => {
                    update({ ...data, shots: data.shots.filter((s) => s.id !== shot.id) })
                    pendingMarkRef.current = 'shot-delete'
                  }}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="script-foot">
        <button
          className={`btn-ghost small ${showOutputSettings ? 'active' : ''}`}
          onClick={() => setShowOutputSettings((value) => !value)}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <Icon name="settings" size={14} /> 输出结构
        </button>
        <button
          className="btn-ghost small"
          onClick={() => {
            update({ ...data, shots: [...data.shots, emptyShot()] })
            pendingMarkRef.current = 'shot-add'
          }}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <>
            <Icon name="add" size={14} />
            添加镜头
          </>
        </button>
        {chatModels.length > 0 ? (
          <>
            <button
              className={`btn-breakdown ${breaking ? 'running' : ''}`}
              onClick={() => void breakdown()}
              disabled={!data.source.trim() && !breaking}
              onPointerDown={(e) => stopEventPropagation(e)}
            >
              {breaking ? (
                '取消拆解…'
              ) : (
                <>
                  <Icon name="spark" size={14} />
                  AI 拆解
                </>
              )}
            </button>
            <select
              className="script-model-select"
              value={data.modelKey ?? chatModels[0]?.key ?? ''}
              title="选择拆解用的对话模型"
              onChange={(e) => update({ ...data, modelKey: e.target.value })}
              onPointerDown={(e) => stopEventPropagation(e)}
            >
              {chatModels.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <button
            className="btn-ghost small"
            title="点击配置对话模型"
            onClick={(e) => {
              e.stopPropagation()
              openSettings()
            }}
            onPointerDown={(e) => stopEventPropagation(e)}
          >
            <>
              <Icon name="spark" size={14} />
              AI 拆解（需配置模型）
            </>
          </button>
        )}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// 数据处理节点：只负责显式变量映射与透传，不隐藏任何业务逻辑。
// ──────────────────────────────────────────────

type VariableValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'

interface ProcessorData {
  inputName: string
  outputName: string
  valueType: VariableValueType
  fallback: string
}

function parseProcessor(text: string): ProcessorData {
  return parseJsonProp(
    text,
    (value) => {
      const data = value as Record<string, unknown>
      if (!data || typeof data !== 'object') return null
      const allowed: VariableValueType[] = ['string', 'number', 'boolean', 'object', 'array', 'any']
      return {
        inputName: typeof data.inputName === 'string' ? data.inputName : 'input',
        outputName: typeof data.outputName === 'string' ? data.outputName : 'output',
        valueType: allowed.includes(data.valueType as VariableValueType)
          ? (data.valueType as VariableValueType)
          : 'any',
        fallback: typeof data.fallback === 'string' ? data.fallback : ''
      }
    },
    { inputName: 'input', outputName: 'output', valueType: 'any', fallback: '' }
  )
}

const VARIABLE_TYPES: { value: VariableValueType; label: string }[] = [
  { value: 'any', label: '任意' },
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'object', label: '对象' },
  { value: 'array', label: '数组' }
]

export function ProcessorBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseProcessor(shape.props.text)

  const update = (next: ProcessorData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  const hasInput = hasIncomingConnection(editor, shape.id, 'in-value')

  return (
    <div className="processor-body">
      <div className="variable-section-title">变量映射</div>
      <div className="variable-row input">
        <span className="variable-direction">输入</span>
        <input
          value={data.inputName}
          aria-label="输入变量名"
          spellCheck={false}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, inputName: e.target.value || 'input' })}
        />
        <select
          value={data.valueType}
          aria-label="变量类型"
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, valueType: e.target.value as VariableValueType })}
        >
          {VARIABLE_TYPES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="variable-map-arrow">↓ 原样传递</div>
      <div className="variable-row output">
        <span className="variable-direction">输出</span>
        <input
          value={data.outputName}
          aria-label="输出变量名"
          spellCheck={false}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, outputName: e.target.value || 'output' })}
        />
        <span className="variable-type-badge">{data.valueType}</span>
      </div>
      {!hasInput && (
        <input
          className="processor-fallback"
          value={data.fallback}
          placeholder="未连线时使用的固定值（可选）"
          spellCheck={false}
          onPointerDown={(e) => stopEventPropagation(e)}
          onChange={(e) => update({ ...data, fallback: e.target.value })}
        />
      )}
      <div className={`processor-status ${hasInput ? 'connected' : ''}`}>
        {hasInput ? '输入变量已由连线填充' : '等待连线或填写固定值'}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// JSON / Code / Storyboard
// ──────────────────────────────────────────────

function JsonValueCards({ value }: { value: unknown }): React.JSX.Element {
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { shots?: unknown }).shots)
      ? (value as { shots: unknown[] }).shots
      : null

  if (rows) {
    return (
      <div className="json-card-list">
        {rows.slice(0, 40).map((row, index) => {
          const fields =
            typeof row === 'object' && row !== null
              ? Object.entries(row as Record<string, unknown>)
              : [['value', row]]
          return (
            <article className="json-data-card" key={index}>
              <span className="json-card-index">{index + 1}</span>
              <div className="json-card-fields">
                {fields.slice(0, 10).map(([key, field]) => (
                  <div className="json-card-field" key={key}>
                    <span>{key}</span>
                    <strong>{typeof field === 'string' ? field : JSON.stringify(field)}</strong>
                  </div>
                ))}
              </div>
            </article>
          )
        })}
        {rows.length > 40 && <div className="json-card-more">还有 {rows.length - 40} 项未显示</div>}
      </div>
    )
  }

  if (typeof value === 'object' && value !== null) {
    return (
      <div className="json-object-card">
        {Object.entries(value as Record<string, unknown>).map(([key, field]) => (
          <div className="json-card-field" key={key}>
            <span>{key}</span>
            <strong>{typeof field === 'string' ? field : JSON.stringify(field)}</strong>
          </div>
        ))}
      </div>
    )
  }

  return <pre className="json-pre">{JSON.stringify(value, null, 2)}</pre>
}

// JSON 节点：结构化数据查看器 + 编辑器
export function JsonBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

  const commit = (): void => {
    setEditing(false)
    if (draft !== shape.props.text) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text: draft } })
      markUndoPoint(editor, 'json-edit')
    }
  }

  if (editing) {
    return (
      <textarea
        className="node-textarea code-edit"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') commit()
          // Tab key 支持
          if (e.key === 'Tab') {
            e.preventDefault()
            const target = e.currentTarget
            const start = target.selectionStart
            const end = target.selectionEnd
            const newVal = draft.slice(0, start) + '  ' + draft.slice(end)
            setDraft(newVal)
            requestAnimationFrame(() => {
              target.selectionStart = target.selectionEnd = start + 2
            })
          }
        }}
        onPointerDown={(e) => stopEventPropagation(e)}
        spellCheck={false}
      />
    )
  }

  const text = shape.props.text || ''
  let formatted = text
  let parsedJson: unknown = null
  try {
    parsedJson = JSON.parse(text)
    formatted = JSON.stringify(parsedJson, null, 2)
  } catch {
    // 非合法 JSON 原样展示
  }

  const formatJson = (): void => {
    try {
      const parsed = JSON.parse(text)
      const pretty = JSON.stringify(parsed, null, 2)
      if (pretty !== text) {
        editor.updateShape({ id: shape.id, type: 'node-card', props: { text: pretty } })
        markUndoPoint(editor, 'json-format')
      }
    } catch {
      toast('JSON 格式有误，无法格式化')
    }
  }

  return (
    <div className="json-body" ref={scrollRef}>
      {text ? (
        <div
          className="json-preview"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
          }}
        >
          {parsedJson === null ? (
            <pre className="json-pre">{formatted}</pre>
          ) : (
            <JsonValueCards value={parsedJson} />
          )}
        </div>
      ) : (
        <div
          className="node-hint center"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
          }}
        >
          双击输入 JSON 数据
        </div>
      )}
      <div className="code-toolbar">
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(shape.props.text)
            setEditing(true)
          }}
        >
          <>
            <Icon name="edit" size={14} />
            {text ? '编辑' : '输入'}
          </>
        </button>
        {text && (
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              formatJson()
            }}
          >
            <>
              <Icon name="spark" size={14} />
              格式化
            </>
          </button>
        )}
      </div>
    </div>
  )
}

interface CodeConfig {
  source: string
  inputName: string
  inputType: VariableValueType
  outputName: string
  outputType: VariableValueType
}

function parseCodeConfig(text: string): CodeConfig {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value && typeof value === 'object' && typeof value.source === 'string') {
      const allowed: VariableValueType[] = ['string', 'number', 'boolean', 'object', 'array', 'any']
      return {
        source: value.source,
        inputName: typeof value.inputName === 'string' ? value.inputName : 'input',
        inputType: allowed.includes(value.inputType as VariableValueType)
          ? (value.inputType as VariableValueType)
          : 'any',
        outputName: typeof value.outputName === 'string' ? value.outputName : 'output',
        outputType: allowed.includes(value.outputType as VariableValueType)
          ? (value.outputType as VariableValueType)
          : 'any'
      }
    }
  } catch {
    // 旧版本纯代码文本直接迁移为 source。
  }
  return {
    source: text,
    inputName: 'input',
    inputType: 'any',
    outputName: 'output',
    outputType: 'any'
  }
}

// Code 节点：显式变量契约 + 代码片段编辑器
export function CodeBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseCodeConfig(shape.props.text)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.source)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

  const commit = (): void => {
    setEditing(false)
    if (draft !== data.source) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { text: JSON.stringify({ ...data, source: draft }) }
      })
      markUndoPoint(editor, 'code-edit')
    }
  }

  const updateConfig = (next: CodeConfig): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  if (editing) {
    return (
      <textarea
        className="node-textarea code-edit"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') commit()
          if (e.key === 'Tab') {
            e.preventDefault()
            const target = e.currentTarget
            const start = target.selectionStart
            const end = target.selectionEnd
            const newVal = draft.slice(0, start) + '  ' + draft.slice(end)
            setDraft(newVal)
            requestAnimationFrame(() => {
              target.selectionStart = target.selectionEnd = start + 2
            })
          }
        }}
        onPointerDown={(e) => stopEventPropagation(e)}
        spellCheck={false}
      />
    )
  }

  const text = data.source
  return (
    <div className="code-body" ref={scrollRef}>
      <div className="code-variable-contract">
        <div className="variable-row input">
          <span className="variable-direction">输入</span>
          <input
            value={data.inputName}
            aria-label="代码输入变量名"
            spellCheck={false}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => updateConfig({ ...data, inputName: e.target.value || 'input' })}
          />
          <select
            value={data.inputType}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) =>
              updateConfig({ ...data, inputType: e.target.value as VariableValueType })
            }
          >
            {VARIABLE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="variable-row output">
          <span className="variable-direction">输出</span>
          <input
            value={data.outputName}
            aria-label="代码输出变量名"
            spellCheck={false}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) => updateConfig({ ...data, outputName: e.target.value || 'output' })}
          />
          <select
            value={data.outputType}
            onPointerDown={(e) => stopEventPropagation(e)}
            onChange={(e) =>
              updateConfig({ ...data, outputType: e.target.value as VariableValueType })
            }
          >
            {VARIABLE_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="code-variable-help">
          代码中读取 <code>input.{data.inputName}</code>，return 值写入{' '}
          <code>{data.outputName}</code>
        </div>
      </div>
      {text ? (
        <pre
          className="code-pre"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(data.source)
            setEditing(true)
          }}
        >
          {text}
        </pre>
      ) : (
        <div
          className="node-hint center"
          onPointerDown={(e) => stopEventPropagation(e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraft(data.source)
            setEditing(true)
          }}
        >
          双击输入代码片段（可处理文本 / JSON 数据）
        </div>
      )}
      <div className="code-toolbar">
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            setDraft(data.source)
            setEditing(true)
          }}
        >
          <>
            <Icon name="edit" size={14} />
            {text ? '编辑' : '输入'}
          </>
        </button>
      </div>
    </div>
  )
}

// Storyboard 节点：分镜板（支持逐镜生图 + 全部生图）
interface StoryboardShot {
  id: string
  scene: string
  dialogue: string
  duration: string
  imageMediaId?: string
  imageMediaPath?: string
}

interface StoryboardData {
  shots: StoryboardShot[]
  imageModelKey?: string
}

function parseStoryboard(text: string): StoryboardData {
  if (!text) return { shots: [] }
  try {
    const v = JSON.parse(text) as { shots?: unknown; imageModelKey?: unknown }
    if (v && typeof v === 'object' && Array.isArray(v.shots)) {
      return {
        shots: v.shots.map(
          (s) =>
            ({
              id:
                typeof (s as Record<string, unknown>).id === 'string'
                  ? (s as { id: string }).id
                  : Math.random().toString(36).slice(2, 9),
              scene:
                typeof (s as Record<string, unknown>).scene === 'string'
                  ? (s as { scene: string }).scene
                  : '',
              dialogue:
                typeof (s as Record<string, unknown>).dialogue === 'string'
                  ? (s as { dialogue: string }).dialogue
                  : '',
              duration:
                typeof (s as Record<string, unknown>).duration === 'string'
                  ? (s as { duration: string }).duration
                  : '',
              imageMediaId:
                typeof (s as Record<string, unknown>).imageMediaId === 'string'
                  ? (s as { imageMediaId: string }).imageMediaId
                  : undefined,
              imageMediaPath:
                typeof (s as Record<string, unknown>).imageMediaPath === 'string'
                  ? (s as { imageMediaPath: string }).imageMediaPath
                  : undefined
            }) as StoryboardShot
        ),
        imageModelKey: typeof v.imageModelKey === 'string' ? v.imageModelKey : undefined
      }
    }
  } catch {
    // 非结构化内容
  }
  return { shots: [] }
}

const STORYBOARD_MAX_H = 640

export function StoryboardBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const imgOptions = modelsByModality(providers, 'image')
  const data = parseStoryboard(shape.props.text)
  const [generatingShots, setGeneratingShots] = useState<Set<string>>(new Set())
  const [editingInput, setEditingInput] = useState(false)
  const [draftInput, setDraftInput] = useState(shape.props.text)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const update = (next: StoryboardData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  // 从上游接收分镜数据。监听画布变更，保证“先创建节点、后连接连线”也能同步。
  useEffect(() => {
    const importUpstream = (): void => {
      if (data.shots.length > 0) return
      const upstream = gatherUpstreamJson(editor, shape.id)
      const parsed = Array.isArray(upstream)
        ? { shots: upstream }
        : (upstream as { shots?: unknown } | null)
      if (parsed && Array.isArray(parsed.shots) && parsed.shots.length > 0) {
        update({
          shots: parsed.shots.map(
            (s) =>
              ({
                id: Math.random().toString(36).slice(2, 9),
                scene: (s as Record<string, string>).scene ?? '',
                dialogue: (s as Record<string, string>).dialogue ?? '',
                duration: (s as Record<string, string>).duration ?? ''
              }) as StoryboardShot
          )
        })
        markUndoPoint(editor, 'storyboard-import')
      }
    }
    importUpstream()
    return editor.store.listen(importUpstream, { scope: 'document' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, shape.id, data.shots.length])

  // 自动撑高
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const need = el.scrollHeight + 80
    if (need > shape.props.h && shape.props.h < STORYBOARD_MAX_H) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { h: Math.min(STORYBOARD_MAX_H, need) }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.shots.length])

  // 逐镜生图
  const generateShotImage = async (shotId: string): Promise<void> => {
    const shot = data.shots.find((s) => s.id === shotId)
    if (!shot?.scene) return toast('该镜头没有画面描述')
    if (!data.imageModelKey) return toast('请先选择图片模型')
    const opt = imgOptions.find((o) => o.key === data.imageModelKey)
    if (!opt) return toast('图片模型不可用')
    if (!project) return toast('项目未就绪')
    setGeneratingShots((prev) => new Set(prev).add(shotId))
    const res = await window.api.gateway.imageGenerate({
      projectId: project.id,
      providerId: opt.provider.id,
      modelId: opt.model.id,
      prompt: shot.scene
    })
    setGeneratingShots((prev) => {
      const next = new Set(prev)
      next.delete(shotId)
      return next
    })
    if (!res.ok) return toast(`生成失败：${res.error.message}`)
    const nextShots = data.shots.map((s) =>
      s.id === shotId ? { ...s, imageMediaId: res.data.id, imageMediaPath: res.data.path } : s
    )
    update({ ...data, shots: nextShots })
    markUndoPoint(editor, 'storyboard-shotgen')
  }

  // 全部生图（顺序执行）
  const generateAll = async (): Promise<void> => {
    const pending = data.shots.filter((s) => !s.imageMediaPath && s.scene)
    if (pending.length === 0) return toast('没有待生成的镜头')
    for (const shot of pending) {
      await generateShotImage(shot.id)
    }
    toast(`${pending.length} 个镜头已生成`)
  }

  const commitInput = (): void => {
    let raw: unknown
    try {
      raw = JSON.parse(draftInput)
    } catch {
      toast('分镜 JSON 格式有误')
      return
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { shots?: unknown }).shots)) {
      toast('分镜 JSON 需要包含 shots 数组')
      return
    }
    const next = parseStoryboard(draftInput)
    setEditingInput(false)
    update(next)
    markUndoPoint(editor, 'storyboard-json-edit')
  }

  if (data.shots.length === 0) {
    if (editingInput) {
      return (
        <textarea
          className="node-textarea code-edit"
          autoFocus
          value={draftInput}
          placeholder='{"shots":[{"scene":"画面描述","dialogue":"","duration":"3s"}]}'
          onChange={(e) => setDraftInput(e.target.value)}
          onBlur={commitInput}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setEditingInput(false)
              setDraftInput(shape.props.text)
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') commitInput()
          }}
          onPointerDown={(e) => stopEventPropagation(e)}
          spellCheck={false}
        />
      )
    }
    return (
      <div
        className="node-hint center"
        onPointerDown={(e) => stopEventPropagation(e)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          setDraftInput(shape.props.text)
          setEditingInput(true)
        }}
      >
        将脚本节点连入此节点，
        <br />
        或双击输入分镜 JSON
        <button
          className="btn-ghost small"
          onPointerDown={(e) => stopEventPropagation(e)}
          onClick={(e) => {
            e.stopPropagation()
            setDraftInput(shape.props.text)
            setEditingInput(true)
          }}
        >
          <Icon name="edit" size={14} />
          输入 JSON
        </button>
      </div>
    )
  }

  const hasModel = imgOptions.length > 0
  const pendingCount = data.shots.filter((s) => !s.imageMediaPath && s.scene).length

  return (
    <div className="storyboard-body" ref={scrollRef}>
      {/* 图片模型选择栏 */}
      <div className="storyboard-toolbar">
        {hasModel ? (
          <>
            <ModelSelect
              value={data.imageModelKey ?? ''}
              options={imgOptions}
              onChange={(key) => update({ ...data, imageModelKey: key })}
            />
            {pendingCount > 0 && data.imageModelKey && (
              <button
                className="btn-ghost small"
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  void generateAll()
                }}
              >
                全部生图 ({pendingCount})
              </button>
            )}
          </>
        ) : (
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              openSettings()
            }}
          >
            配置图片模型
          </button>
        )}
      </div>
      {/* 分镜卡片 */}
      {data.shots.map((shot, i) => (
        <div key={shot.id} className="storyboard-card">
          <div className="storyboard-num">#{i + 1}</div>
          {shot.imageMediaPath ? (
            <div
              className="storyboard-thumb"
              onClick={(e) => {
                e.stopPropagation()
                openPreview({
                  kind: 'image',
                  url: mediaUrl(shot.imageMediaPath!),
                  title: `镜头 ${i + 1}`
                })
              }}
            >
              <img src={mediaUrl(shot.imageMediaPath!)} alt={shot.scene} draggable={false} />
            </div>
          ) : generatingShots.has(shot.id) ? (
            <div className="storyboard-thumb-empty generating">⏳</div>
          ) : (
            <button
              className="storyboard-thumb-gen"
              disabled={!shot.scene || !data.imageModelKey}
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                void generateShotImage(shot.id)
              }}
            >
              {shot.scene ? (
                <>
                  <Icon name="image" size={13} />
                  生图
                </>
              ) : (
                <Icon name="image" size={13} />
              )}
            </button>
          )}
          <div className="storyboard-info">
            <div className="storyboard-scene">{shot.scene || '（无画面描述）'}</div>
            {shot.dialogue && (
              <div className="storyboard-dialogue">
                <Icon name="chat" size={12} />
                {shot.dialogue}
              </div>
            )}
            {shot.duration && <div className="storyboard-duration">⏱ {shot.duration}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
