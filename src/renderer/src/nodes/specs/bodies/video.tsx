// 视频节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { VideoGenParams } from '@shared/types'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import { ModelSelect, NoModelHint, useClickGuard, parseJsonProp } from './shared'

interface VideoGenData {
  prompt: string
  modelKey: string
  params: VideoGenParams
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
          }
        }
      }
      return null
    },
    { prompt: '', modelKey: '', params: {} }
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
  const [submitting, setSubmitting] = useState(false)

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

  const submit = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    // 配置先落盘，再由统一运行器读取真实端口输入、校验契约并调用视频执行器。
    update({ ...data, prompt: draft })
    setSubmitting(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setSubmitting(false)
    }
  }

  if (shape.props.mediaPath) {
    return (
      <div className="node-media-wrap">
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
        <div className="node-media-actions">
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={(e) => {
              e.stopPropagation()
              // 重新生成：清空成片，回到配置面板重新跑一遍
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                props: { mediaId: '', mediaPath: '', mediaMime: '' }
              })
              markUndoPoint(editor, 'video-regenerate')
            }}
          >
            <Icon name="reset" size={13} />
            重新生成
          </button>
        </div>
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
