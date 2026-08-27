// 视频节点 Body（路线图 R6：bodies.tsx 拆分；R0/WP3：提交收敛到 runNodeManually）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { VideoGenParams } from '@shared/types'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { gatherUpstreamText } from '../../../canvas/graph'
import { runNodeManually } from '../../../engine/executor'
import { useEngineStore } from '../../../engine/store'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import { ModelSelect, NoModelHint, useClickGuard, parseJsonProp } from './shared'

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

  // R0/WP3：提交统一走 runNodeManually（执行器负责提交/轮询/取消/落盘），Body 只保留
  // 配置写回与 UI 状态；进度由执行器写入 props.taskId 后的网关事件驱动显示。
  const submit = async (): Promise<void> => {
    const opt = options.find((o) => o.key === data.modelKey)
    if (!opt) return toast('请先选择视频模型')
    if (!draft.trim() && !gatherUpstreamText(editor, shape.id))
      return toast('请输入提示词或连接上游文本')
    if (!project) return toast('项目未就绪')
    if (draft !== data.prompt) update({ ...data, prompt: draft })
    setSubmitting(true)
    setStatus('running')
    const ok = await runNodeManually(editor, project.id, shape.id)
    setSubmitting(false)
    if (!ok) setStatus('')
  }

  // 取消对接 CancelSignal：引擎运行中（手动/全局）走 stop → waitForVideo 撤销任务；
  // 非运行态（应用重启后恢复的历史任务）直接撤销网关任务。
  const cancel = async (): Promise<void> => {
    if (useEngineStore.getState().phase === 'running') {
      useEngineStore.getState().stop?.()
      setStatus('')
      return
    }
    if (!data.taskId) return
    await window.api.gateway.videoCancel(data.taskId)
    setStatus('')
    update({ ...data, taskId: '' })
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
