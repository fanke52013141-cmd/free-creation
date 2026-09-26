import { useCallback, useEffect, useState } from 'react'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import type { VideoEngineStatus } from '@shared/contracts'
import { Icon } from '../../../components/Icon'
import {
  DEFAULT_VIDEO_CLAY_CONFIG,
  DEFAULT_VIDEO_DEPTH_CONFIG,
  parseVideoClayConfig,
  parseVideoDepthConfig,
  serializeVideoClayConfig,
  serializeVideoDepthConfig,
  type VideoClayConfig,
  type VideoDepthConfig
} from '@shared/video-conversion'
import './video-ai.css'

type Mode = 'depth' | 'clay'

function statusText(status: VideoEngineStatus | null): string {
  if (!status) return '正在读取本机推理环境…'
  if (status.installing) return status.progress || '正在安装本地推理环境…'
  return status.message
}

export function VideoAiBody({ shape }: NodeBodyProps): React.JSX.Element {
  const mode: Mode = shape.props.nodeType === 'video-depth' ? 'depth' : 'clay'
  const config = mode === 'depth'
    ? parseVideoDepthConfig(shape.props.config || DEFAULT_VIDEO_DEPTH_CONFIG)
    : parseVideoClayConfig(shape.props.config || DEFAULT_VIDEO_CLAY_CONFIG)
  return (
    <div className="video-ai-body">
      <div className="video-ai-body-title">
        <Icon name="video" size={15} />
        {mode === 'depth' ? '视频 → 深度视频' : '视频 → 白模视频'}
      </div>
      <p>连接源视频后运行，转换结果会作为独立视频资产添加到画布。</p>
      <div className="video-ai-body-meta">
        <span>上限 {config.maxResolution}px</span>
        <span>Video Depth Anything Small · 本地 CUDA</span>
      </div>
    </div>
  )
}

function EngineSetup(): React.JSX.Element {
  const [status, setStatus] = useState<VideoEngineStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await window.api.getVideoEngineStatus()
      if (response.ok) setStatus(response.data)
      else setError(response.error.message)
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : String(statusError))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!status?.installing) return
    const timer = window.setInterval(() => void refresh(), 1800)
    return () => window.clearInterval(timer)
  }, [status?.installing, refresh])

  const install = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const response = await window.api.installVideoEngine()
      if (response.ok) await refresh()
      else setError(response.error.message)
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="video-ai-engine">
      <div className={`video-ai-engine-state ${status?.ready ? 'is-ready' : ''}`}>
        <span className="video-ai-state-dot" />
        <span>{statusText(status)}</span>
      </div>
      {!status?.ready && !status?.installing && (
        <>
          <p>首次安装会下载 CUDA 版 PyTorch（约 3.3 GB）和 116 MB 的 Small 模型；推理环境与模型保存在应用数据目录，不改系统 Python 环境。</p>
          <button
            type="button"
            className="video-ai-install-button"
            disabled={busy || !status?.pythonAvailable}
            onClick={() => void install()}
          >
            {busy ? '正在启动…' : '安装本地推理环境'}
          </button>
          {!status?.pythonAvailable && status?.message && <small>{status.message}</small>}
        </>
      )}
      {status?.ready && status.gpuName && <small>推理设备：{status.gpuName}</small>}
      {error && <small className="video-ai-error">{error}</small>}
    </div>
  )
}

export function VideoAiSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const mode: Mode = shape.props.nodeType === 'video-depth' ? 'depth' : 'clay'
  const depth = parseVideoDepthConfig(shape.props.config || DEFAULT_VIDEO_DEPTH_CONFIG)
  const clay = parseVideoClayConfig(shape.props.config || DEFAULT_VIDEO_CLAY_CONFIG)

  const saveDepth = (patch: Partial<VideoDepthConfig>): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoDepthConfig({ ...depth, ...patch }) }
    })
  }
  const saveClay = (patch: Partial<VideoClayConfig>): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: serializeVideoClayConfig({ ...clay, ...patch }) }
    })
  }

  return (
    <section className="node-settings video-ai-settings">
      <EngineSetup />
      <label className="settings-field">
        最大输出分辨率
        <select
          value={mode === 'depth' ? depth.maxResolution : clay.maxResolution}
          onChange={(event) => {
            const maxResolution = Number(event.currentTarget.value) as 512 | 768 | 1024
            if (mode === 'depth') saveDepth({ maxResolution })
            else saveClay({ maxResolution })
          }}
        >
          <option value={512}>512 px · 默认</option>
          <option value={768}>768 px · 高质量</option>
          <option value={1024}>1024 px · 文件体积较大</option>
        </select>
      </label>
      {mode === 'depth' ? (
        <>
          <label className="settings-field">
            近景灰度
            <select
              value={depth.nearColor}
              onChange={(event) => saveDepth({ nearColor: event.currentTarget.value as 'white' | 'black' })}
            >
              <option value="white">白色</option>
              <option value="black">黑色</option>
            </select>
          </label>
          <label className="video-ai-checkbox">
            <input
              type="checkbox"
              checked={depth.preserveAudio}
              onChange={(event) => saveDepth({ preserveAudio: event.currentTarget.checked })}
            />
            保留源视频音频
          </label>
        </>
      ) : (
        <>
          <RangeField label="浮雕强度" min={0.25} max={5} step={0.05} value={clay.reliefStrength} onChange={(reliefStrength) => saveClay({ reliefStrength })} />
          <RangeField label="光线方向" min={0} max={359} step={1} value={clay.lightAzimuth} onChange={(lightAzimuth) => saveClay({ lightAzimuth })} suffix="°" />
          <RangeField label="光线高度" min={5} max={85} step={1} value={clay.lightElevation} onChange={(lightElevation) => saveClay({ lightElevation })} suffix="°" />
          <RangeField label="环境光" min={0} max={0.9} step={0.01} value={clay.ambientLight} onChange={(ambientLight) => saveClay({ ambientLight })} />
          <label className="video-ai-checkbox">
            <input
              type="checkbox"
              checked={clay.preserveAudio}
              onChange={(event) => saveClay({ preserveAudio: event.currentTarget.checked })}
            />
            保留源视频音频
          </label>
        </>
      )}
      <p className="contract-settings-hint">
        两种转换都直接接收视频。首版最多处理 1800 帧；白模由深度估计生成灰度材质与可调光照，不生成可编辑三维网格。
      </p>
    </section>
  )
}

function RangeField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  suffix = ''
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  suffix?: string
}): React.JSX.Element {
  return (
    <label className="video-ai-range">
      <span>{label}<b>{value.toFixed(step < 1 ? 2 : 0)}{suffix}</b></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  )
}
