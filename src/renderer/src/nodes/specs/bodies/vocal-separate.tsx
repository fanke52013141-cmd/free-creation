import { useEffect, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { mediaUrl } from '../../registry'
import { gatherUpstreamMedia } from '../../../canvas/graph'
import { markUndoPoint } from '../../../canvas/history'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { MediaFileActions, MediaSourceBadge, useClickGuard } from './shared'
import { parseVocalSeparationResult } from '../../../engine/executors/vocalSeparate'
import { parseVocalSeparationConfig } from '@shared/video-transform'
import type { VocalMode } from '@shared/video-transform'

export function VocalSeparateBody({ shape, openPreview }: NodeBodyProps): React.JSX.Element {
  const guard = useClickGuard()
  const record = parseVocalSeparationResult(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const openSettings = (): void =>
    useNodePanelStore.getState().open('contract', shape.id, 'settings')
  if (!record) {
    return (
      <div className="asset-empty crop-empty">
        <Icon name="audio" size={24} />
        <span>人声分离</span>
        <small>连接音频后在右侧选择模式；快速增强输出人声，高质量 AI 分离可额外输出伴奏。</small>
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={openSettings}
        >
          配置人声分离
        </button>
      </div>
    )
  }
  // 构建结果列表：人声始终存在，伴奏仅在 outputAccompaniment=true 时产出
  const tracks: ReadonlyArray<
    readonly [string, { mediaId: string; mediaPath: string; mime: string }]
  > = record.accompaniment
    ? [
        ['人声', record.vocals],
        ['伴奏', record.accompaniment]
      ]
    : [['人声', record.vocals]]

  return (
    <div className="vocal-result-card">
      {tracks.map(([label, media]) => (
        <button
          key={label}
          className="vocal-result-row"
          onPointerDown={guard.onPointerDown}
          onClick={(event) =>
            guard.onClick(event, () =>
              openPreview({ kind: 'audio', url: mediaUrl(media.mediaPath), title: label })
            )
          }
        >
          <Icon name="audio" size={15} /> <span>{label}</span>
          <small>试听</small>
        </button>
      ))}
      <div className="node-media-actions">
        <button
          className="btn-ghost small"
          onPointerDown={stopEventPropagation}
          onClick={openSettings}
        >
          <Icon name="edit" size={13} /> 调整
        </button>
        <MediaSourceBadge
          shape={shape}
          fallback={record.mode === 'quality' ? '本地 AI 模型' : 'FFmpeg 增强'}
        />
        <MediaFileActions shape={shape} />
      </div>
    </div>
  )
}

export function VocalSeparateSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const source = gatherUpstreamMedia(editor, shape.id, 'in-audio', 'audio')
  const config = parseVocalSeparationConfig(readNodeConfig(shape))
  const [localCapabilities, setLocalCapabilities] = useState<Awaited<
    ReturnType<typeof window.api.getLocalMediaCapabilities>
  > | null>(null)

  useEffect(() => {
    let active = true
    void window.api.getLocalMediaCapabilities().then((result) => {
      if (active) setLocalCapabilities(result)
    })
    return () => {
      active = false
    }
  }, [])

  const ffmpegReady = localCapabilities?.ok ? localCapabilities.data.ffmpeg.available : null
  const separatorReady = localCapabilities?.ok
    ? localCapabilities.data.audioSeparator.available
    : null

  const saveMode = (mode: VocalMode): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: {
        config: JSON.stringify({
          version: 1,
          mode,
          // FFmpeg 快速模式不具备真实伴奏分离能力，切换时主动清除该请求。
          outputAccompaniment: mode === 'quality' && config.outputAccompaniment
        })
      }
    })
    markUndoPoint(editor, 'vocal-separate-mode')
  }

  const toggleAccompaniment = (outputAccompaniment: boolean): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify({ version: 1, mode: config.mode, outputAccompaniment }) }
    })
    markUndoPoint(editor, 'vocal-separate-accompaniment')
  }

  return (
    <section className="contract-section video-transform-settings">
      <h4>人声分离</h4>
      <p className="contract-settings-hint">
        输入 in-audio；运行后输出 out-vocals；仅高质量模式可额外输出
        out-accompaniment。绝不修改原音频。
      </p>
      {config.mode === 'fast' && ffmpegReady === false && (
        <div className="local-capability-alert" role="alert">
          <strong>快速增强不可用</strong>
          <span>
            {localCapabilities?.ok
              ? localCapabilities.data.ffmpeg.message
              : '无法读取 FFmpeg 状态。'}
          </span>
        </div>
      )}
      {config.mode === 'quality' && separatorReady === false && (
        <div className="local-capability-alert" role="alert">
          <strong>高质量分离不可用</strong>
          <span>
            {localCapabilities?.ok
              ? localCapabilities.data.audioSeparator.message
              : '无法读取 audio-separator 状态。'}
          </span>
          <small>可切换为“快速增强”，或安装本地 AI 分离器后重新打开此面板。</small>
        </div>
      )}
      {source ? (
        <audio className="vocal-source-preview" controls src={mediaUrl(source.mediaPath)} />
      ) : (
        <div className="crop-no-source">请将音频连线到“源音频”。</div>
      )}

      <label className="audio-isolation-mode">
        分离模式
        <AppSelect
          value={config.mode}
          onChange={(event) => saveMode(event.currentTarget.value as VocalMode)}
        >
          <option value="fast">快速增强（FFmpeg 滤镜）</option>
          <option value="quality">高质量分离（本地 AI 模型）</option>
        </AppSelect>
      </label>

      {config.mode === 'fast' ? (
        <p className="crop-coordinate-hint">
          快速模式使用 FFmpeg 中置声道提取 + EQ + 降噪，速度极快但无法保证完全移除背景音乐。
        </p>
      ) : (
        <p className="crop-coordinate-hint">
          高质量模式调用本地 audio-separator（BS-RoFormer 等），需要 Python
          环境。未安装时会明确报错，不静默降级。
        </p>
      )}

      <label className="audio-checkbox-row">
        <input
          type="checkbox"
          checked={config.mode === 'quality' && config.outputAccompaniment}
          disabled={config.mode !== 'quality' || separatorReady === false}
          onChange={(event) => toggleAccompaniment(event.currentTarget.checked)}
        />
        同时输出伴奏音轨
      </label>
    </section>
  )
}
