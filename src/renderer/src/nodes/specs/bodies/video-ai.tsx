import { GenerationLoadingOverlay } from '../../../canvas/GenerationLoadingOverlay'
import { NodeIdentity, NodePrimaryButton } from '../../../canvas/NodePresentation'
import { Icon } from '../../../components/Icon'
import { stopEventPropagation, useEditor } from 'tldraw'
import { useCallback, useEffect, useState } from 'react'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import type { VideoEngineStatus } from '@shared/contracts'
import { AppSelect } from '../../../components/AppSelect'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { useGatewayStore } from '../../../stores/gateway'
import {
  DEFAULT_VIDEO_CLAY_CONFIG,
  DEFAULT_VIDEO_DEPTH_CONFIG,
  VIDEO_CLAY_PRESETS,
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
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const [submitting, setSubmitting] = useState(false)
  const mode: Mode = shape.props.nodeType === 'video-depth' ? 'depth' : 'clay'
  const config = mode === 'depth'
    ? parseVideoDepthConfig(shape.props.config || DEFAULT_VIDEO_DEPTH_CONFIG)
    : parseVideoClayConfig(shape.props.config)
  const clayV1 = mode === 'clay' && config.version === 1
  const engineBusy = ['queued', 'running', 'pending'].includes(shape.props.exec)

  const run = async (): Promise<void> => {
    if (!project) return
    setSubmitting(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="video-ai-body">
      {mode === 'clay' ? (
        <ClayOptions config={parseVideoClayConfig(shape.props.config)} onChange={(patch) => {
          editor.updateShape({ id: shape.id, type: 'node-card', props: {
            config: serializeVideoClayConfig({ ...parseVideoClayConfig(shape.props.config), ...patch })
          } })
        }} />
      ) : null}
      <NodeIdentity />
      {/* 2026-11-02 用户裁决：配置行置顶、身份图标居中，补齐与其他节点一致的底部主操作。
          v1 旧配置保留“升级白模效果”入口，此时不重复出运行按钮。 */}
      {!clayV1 && (
        <NodePrimaryButton
          disabled={submitting || engineBusy}
          title={engineBusy && !submitting ? '当前节点已在运行或排队' : undefined}
          onPointerDown={stopEventPropagation}
          onClick={(e) => {
            e.stopPropagation()
            void run()
          }}
        >
          {submitting ? (
            '生成中…'
          ) : engineBusy ? (
            '节点执行中，稍候…'
          ) : (
            <>
              <span>{mode === 'depth' ? '生成深度视频' : '生成白模视频'}</span>
              <Icon name="spark" size={14} />
            </>
          )}
        </NodePrimaryButton>
      )}
    </div>
  )
}

function ClayOptions({ config, onChange }: {
  config: VideoClayConfig
  onChange: (patch: Partial<VideoClayConfig>) => void
}): React.JSX.Element {
  if (config.version === 1) return (
    <NodePrimaryButton onClick={() => onChange({ version: 2 })}>
      <Icon name="spark" size={16} />
      升级白模效果
    </NodePrimaryButton>
  )
  return <div className="video-clay-options">
    <div className="settings-field">
      <AppSelect aria-label="白模效果" className="gen-select" value={config.preset} onChange={(event) => {
        const preset = event.currentTarget.value as VideoClayConfig['preset']
        onChange({ preset, ...VIDEO_CLAY_PRESETS[preset] })
      }}>
        <option value="soft">柔和白模</option>
        <option value="studio">立体白模</option>
        <option value="structure">结构白模</option>
      </AppSelect>
    </div>
    <div className="settings-field">
      <AppSelect aria-label="质量" className="gen-select" value={config.quality} onChange={(event) => {
        const quality = event.currentTarget.value as VideoClayConfig['quality']
        onChange({ quality, maxResolution: quality === 'fast' ? 512 : quality === 'fine' ? 1024 : 768 })
      }}>
        <option value="fast">快速</option>
        <option value="standard">标准</option>
        <option value="fine">精细</option>
      </AppSelect>
    </div>
  </div>
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
    let active = true
    void window.api.getVideoEngineStatus().then((response) => {
      if (!active) return
      if (response.ok) setStatus(response.data)
      else setError(response.error.message)
    }).catch((statusError: unknown) => {
      if (!active) return
      setError(statusError instanceof Error ? statusError.message : String(statusError))
    })
    return () => { active = false }
  }, [])

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
      {!status || status.installing ? (
        <GenerationLoadingOverlay title={statusText(status)} compact />
      ) : (
        <div className={`video-ai-engine-state ${status.ready ? 'is-ready' : ''}`}>
          <span className="video-ai-state-dot" />
          <span>{status.message}</span>
        </div>
      )}
      {!status?.ready && !status?.installing && (
        <>
          <p>需要 Python 3.12、NVIDIA 显卡和 FFmpeg。首次安装会下载约 3.4 GB 的 CUDA 推理依赖与模型，建议预留 10 GB 磁盘空间；不会改系统 Python 环境。</p>
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
  const clay = parseVideoClayConfig(shape.props.config)

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
      {mode === 'clay' && <ClayOptions config={clay} onChange={saveClay} />}
      <label className="settings-field">
        最大输出分辨率
        <AppSelect
          className="gen-select"
          value={String(mode === 'depth' ? depth.maxResolution : clay.maxResolution)}
          onChange={(event) => {
            const maxResolution = Number(event.currentTarget.value) as 512 | 768 | 1024
            if (mode === 'depth') saveDepth({ maxResolution })
            else saveClay({ maxResolution })
          }}
        >
          <option value={512}>512 px · 默认</option>
          <option value={768}>768 px · 高质量</option>
          <option value={1024}>1024 px · 文件体积较大</option>
        </AppSelect>
      </label>
      {mode === 'depth' ? (
        <>
          <label className="settings-field">
            近景灰度
            <AppSelect
              className="gen-select"
              value={depth.nearColor}
              onChange={(event) => saveDepth({ nearColor: event.currentTarget.value as 'white' | 'black' })}
            >
              <option value="white">白色</option>
              <option value="black">黑色</option>
            </AppSelect>
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
          <RangeField label={clay.version === 1 ? '浮雕强度' : '立体程度'} min={0.25} max={5} step={0.05} value={clay.reliefStrength} onChange={(reliefStrength) => saveClay({ reliefStrength })} />
          <RangeField label="光线方向" min={0} max={359} step={1} value={clay.lightAzimuth} onChange={(lightAzimuth) => saveClay({ lightAzimuth })} suffix="°" />
          <RangeField label="光线高度" min={5} max={85} step={1} value={clay.lightElevation} onChange={(lightElevation) => saveClay({ lightElevation })} suffix="°" />
          <RangeField label="环境光" min={0} max={0.9} step={0.01} value={clay.ambientLight} onChange={(ambientLight) => saveClay({ ambientLight })} />
          {clay.version === 2 && <>
            <RangeField label="阴影强度" min={0} max={1} step={0.05} value={clay.shadowStrength} onChange={(shadowStrength) => saveClay({ shadowStrength })} />
            <RangeField label="时间稳定程度" min={0} max={1} step={0.05} value={clay.temporalStability} onChange={(temporalStability) => saveClay({ temporalStability })} />
            <RangeField label="视角估计" min={25} max={90} step={1} value={clay.fieldOfView} onChange={(fieldOfView) => saveClay({ fieldOfView })} suffix="°" />
          </>}
          <button type="button" className="btn-ghost small" onClick={() => saveClay(DEFAULT_VIDEO_CLAY_CONFIG)}>恢复默认设置</button>
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
        最多处理 1800 帧。白模基于可见表面深度和估计视角渲染；输出为视频。精细档提高推理尺寸，需要更多显存。
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
