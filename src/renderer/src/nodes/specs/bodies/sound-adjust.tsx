import { useEditor } from 'tldraw'
import { NodePrimaryButton } from '../../../canvas/NodePresentation'
import { useState } from 'react'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { Icon } from '../../../components/Icon'
import { markUndoPoint } from '../../../canvas/history'
import { parseSoundAdjustConfig, type SoundAdjustConfig } from '@shared/sound-adjust'

interface Draft {
  mode: SoundAdjustConfig['mode']
  rate: string
  seconds: string
  volume: string
}

function draftOf(config: string): Draft {
  const value = parseSoundAdjustConfig(config)
  return {
    mode: value.mode,
    rate: String(value.rate),
    seconds: String(value.targetDurationMs / 1000),
    volume: String(value.volumePercent)
  }
}

export function SoundAdjustBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  return <SoundAdjustSettings shape={shape} editor={editor} inline />
}
export function SoundAdjustSettings({
  shape,
  editor,
  inline = false
}: Pick<NodeSettingsProps, 'shape' | 'editor'> & { inline?: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftOf(shape.props.config))
  const [savedConfig, setSavedConfig] = useState(shape.props.config)
  const [error, setError] = useState('')
  if (savedConfig !== shape.props.config) {
    setDraft(draftOf(shape.props.config))
    setSavedConfig(shape.props.config)
  }

  const save = (): void => {
    const rate = Number(draft.rate)
    const seconds = Number(draft.seconds)
    const volume = Number(draft.volume)
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4)
      return setError('语速倍率须在 0.25–4 之间')
    if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 36_000)
      return setError('目标时长须在 0.1–36000 秒之间')
    if (!Number.isFinite(volume) || volume < 0 || volume > 300)
      return setError('声量须在 0–300% 之间')
    const config: SoundAdjustConfig = {
      version: 1,
      mode: draft.mode,
      rate,
      targetDurationMs: Math.round(seconds * 1000),
      volumePercent: Math.round(volume)
    }
    const serialized = JSON.stringify(config)
    editor.updateShape({ id: shape.id, type: 'node-card', props: { config: serialized } })
    markUndoPoint(editor, 'sound-adjust-config')
    setSavedConfig(serialized)
    setError('')
  }

  return (
    <section
      className={`node-settings sound-adjust-settings${inline ? ' sound-adjust-inline' : ''}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="sound-adjust-settings-label">调整方式</span>
      <div className="sound-adjust-mode" role="group" aria-label="调整方式">
        <button
          type="button"
          className={draft.mode === 'rate' ? 'active' : ''}
          onClick={() => setDraft({ ...draft, mode: 'rate' })}
        >
          按倍率
        </button>
        <button
          type="button"
          className={draft.mode === 'duration' ? 'active' : ''}
          onClick={() => setDraft({ ...draft, mode: 'duration' })}
        >
          按目标秒数
        </button>
      </div>
      {draft.mode === 'rate' ? (
        <label className="settings-field">
          播放倍率
          <input
            type="number"
            min="0.25"
            max="4"
            step="0.05"
            value={draft.rate}
            onChange={(event) => setDraft({ ...draft, rate: event.currentTarget.value })}
          />
        </label>
      ) : (
        <label className="settings-field">
          目标时长（秒）
          <input
            type="number"
            min="0.1"
            max="36000"
            step="0.1"
            value={draft.seconds}
            onChange={(event) => setDraft({ ...draft, seconds: event.currentTarget.value })}
          />
        </label>
      )}
      <label className="settings-field">
        声量（%）
        <input
          type="number"
          min="0"
          max="300"
          step="5"
          value={draft.volume}
          onChange={(event) => setDraft({ ...draft, volume: event.currentTarget.value })}
        />
      </label>
      {!inline && (
        <p className="contract-settings-hint">
          100% 保持原音量；0% 静音。目标秒数会按源时长换算为 0.25–4 倍播放速度，音高保持不变。
        </p>
      )}
      {error && (
        <p className="sound-adjust-error" role="alert">
          {error}
        </p>
      )}
      {inline ? (
        <NodePrimaryButton onClick={save}>
          <Icon name="check" size={15} />
          保存调整参数
        </NodePrimaryButton>
      ) : (
        <button type="button" className="sound-adjust-save" onClick={save}>
          <Icon name="check" size={15} />
          保存调整参数
        </button>
      )}
    </section>
  )
}
