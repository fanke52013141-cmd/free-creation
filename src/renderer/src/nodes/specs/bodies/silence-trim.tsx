import { useEditor } from 'tldraw'
import { NodePrimaryButton } from '../../../canvas/NodePresentation'
import { useEffect, useRef, useState } from 'react'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { Icon } from '../../../components/Icon'
import { NumberStepper } from '../../../components/NumberStepper'
import { markUndoPoint } from '../../../canvas/history'
import { useAppStore } from '../../../stores/app'
import { useGatewayStore } from '../../../stores/gateway'
import { toast } from '../../../stores/toast'
import { runNodeManually } from '../../../engine/executor'
import { guiWorkflowInputOptions } from '../../../stores/workflowInput'
import { parseSilenceTrimConfig, type SilenceTrimConfig } from '@shared/silence-trim'

interface Draft {
  engine: SilenceTrimConfig['engine']
  thresholdDb: string
  vadThreshold: string
  minGapMs: string
  marginMs: string
  keepGapMs: string
}

function draftOf(config: string): Draft {
  const value = parseSilenceTrimConfig(config)
  return {
    engine: value.engine,
    thresholdDb: String(value.thresholdDb),
    vadThreshold: String(value.vadThreshold),
    minGapMs: String(value.minGapMs),
    marginMs: String(value.marginMs),
    keepGapMs: String(value.keepGapMs)
  }
}

/** 校验草稿并转为配置；非法返回 null，由调用方决定提示文案。 */
function draftToConfig(draft: Draft): SilenceTrimConfig | null {
  const thresholdDb = Number(draft.thresholdDb)
  const vadThreshold = Number(draft.vadThreshold)
  const minGapMs = Number(draft.minGapMs)
  const marginMs = Number(draft.marginMs)
  const keepGapMs = Number(draft.keepGapMs)
  if (!Number.isFinite(thresholdDb) || thresholdDb < -60 || thresholdDb > 0) return null
  if (!Number.isFinite(vadThreshold) || vadThreshold < 0.05 || vadThreshold > 0.95) return null
  if (!Number.isFinite(minGapMs) || minGapMs < 0 || minGapMs > 10000) return null
  if (!Number.isFinite(marginMs) || marginMs < 0 || marginMs > 1000) return null
  if (!Number.isFinite(keepGapMs) || keepGapMs < 0 || keepGapMs > 2000) return null
  return {
    version: 1,
    engine: draft.engine,
    thresholdDb,
    vadThreshold,
    minGapMs: Math.round(minGapMs),
    marginMs: Math.round(marginMs),
    keepGapMs: Math.round(keepGapMs)
  }
}

export function SilenceTrimBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  return <SilenceTrimSettings shape={shape} editor={editor} inline />
}

export function SilenceTrimSettings({
  shape,
  editor,
  inline = false
}: Pick<NodeSettingsProps, 'shape' | 'editor'> & { inline?: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftOf(shape.props.config))
  const [savedConfig, setSavedConfig] = useState(shape.props.config)
  const [error, setError] = useState('')
  const project = useAppStore((state) => state.currentProject)
  const providers = useGatewayStore((state) => state.providers)
  if (savedConfig !== shape.props.config) {
    setDraft(draftOf(shape.props.config))
    setSavedConfig(shape.props.config)
  }

  const errorOf = (draft: Draft): string => {
    const thresholdDb = Number(draft.thresholdDb)
    const vadThreshold = Number(draft.vadThreshold)
    const minGapMs = Number(draft.minGapMs)
    const marginMs = Number(draft.marginMs)
    const keepGapMs = Number(draft.keepGapMs)
    if (!Number.isFinite(thresholdDb) || thresholdDb < -60 || thresholdDb > 0)
      return '静音阈值须在 -60–0 dB 之间'
    if (!Number.isFinite(vadThreshold) || vadThreshold < 0.05 || vadThreshold > 0.95)
      return '语音阈值须在 0.05–0.95 之间'
    if (!Number.isFinite(minGapMs) || minGapMs < 0 || minGapMs > 10000)
      return '最短气口须在 0–10000 毫秒之间'
    if (!Number.isFinite(marginMs) || marginMs < 0 || marginMs > 1000)
      return '保留边距须在 0–1000 毫秒之间'
    if (!Number.isFinite(keepGapMs) || keepGapMs < 0 || keepGapMs > 2000)
      return '中心保留须在 0–2000 毫秒之间'
    return ''
  }

  /** 校验并落盘草稿；成功返回 true。配置无变化时跳过写回但仍视为成功。 */
  const commitConfig = (): boolean => {
    const message = errorOf(draft)
    const config = message ? null : draftToConfig(draft)
    if (!config) {
      setError(message || '去气口参数无效')
      return false
    }
    const serialized = JSON.stringify(config)
    if (serialized !== shape.props.config) {
      editor.updateShape({ id: shape.id, type: 'node-card', props: { config: serialized } })
      markUndoPoint(editor, 'silence-trim-config')
      setSavedConfig(serialized)
    }
    setError('')
    return true
  }
  const save = (): void => {
    commitConfig()
  }

  /** 卡片主按钮：配置先落盘，再交给统一节点运行器直接执行（不直接触发媒体转换）。 */
  const startTrim = (): void => {
    if (!commitConfig()) return
    if (!project) {
      toast('项目未就绪')
      return
    }
    // 让关闭状态先完成一次 React 提交，下一事件周期再启动节点运行。
    window.setTimeout(() => {
      void runNodeManually(
        editor,
        project.id,
        providers,
        shape.id,
        undefined,
        undefined,
        undefined,
        guiWorkflowInputOptions
      )
    }, 0)
  }

  // 实时保存：合法草稿防抖写入节点；校验错误只在草稿稳定后提示，不打断输入。
  // 保存按钮保留为显式提交（立即校验并提示错误）；卡片 inline 与设置面板共用此行为。
  const draftRef = useRef(draft)
  const timerRef = useRef<number | null>(null)
  const applySave = (): boolean => {
    const config = draftToConfig(draftRef.current)
    if (!config) return false
    const serialized = JSON.stringify(config)
    if (serialized === shape.props.config) return true
    editor.updateShape({ id: shape.id, type: 'node-card', props: { config: serialized } })
    markUndoPoint(editor, 'silence-trim-config')
    setSavedConfig(serialized)
    return true
  }
  const applySaveRef = useRef(applySave)
  const flushSave = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const message = errorOf(draftRef.current)
    if (applySaveRef.current()) setError('')
    else if (message) setError(message)
  }
  const flushRef = useRef(flushSave)
  // ref 同步在渲染后的 effect 里完成（react-hooks/refs）；事件与定时器读到的是最新值。
  useEffect(() => {
    draftRef.current = draft
    applySaveRef.current = applySave
    flushRef.current = flushSave
  })
  useEffect(() => () => flushRef.current(), [])
  const scheduleSave = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    const attempted = draftRef.current
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (applySaveRef.current()) setError('')
      else if (attempted === draftRef.current) setError(errorOf(draftRef.current) || '去气口参数无效')
    }, 600)
  }

  const setDraftField = (field: keyof Draft, value: string): void => {
    setDraft({ ...draft, [field]: value })
    scheduleSave()
  }

  return (
    <section
      className={`node-settings silence-trim-settings${inline ? ' silence-trim-inline' : ''}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="silence-trim-settings-label">检测引擎</span>
      <div className="silence-trim-mode" role="group" aria-label="检测引擎">
        <button
          type="button"
          className={draft.engine === 'silence' ? 'active' : ''}
          onClick={() => setDraftField('engine', 'silence')}
        >
          静音阈值
        </button>
        <button
          type="button"
          className={draft.engine === 'vad' ? 'active' : ''}
          onClick={() => setDraftField('engine', 'vad')}
        >
          语音检测（含呼吸）
        </button>
      </div>
      {draft.engine === 'silence' ? (
        !inline && (
          <label className="settings-field">
            静音阈值（dB）
            <NumberStepper
              ariaLabel="静音阈值"
              min={-60}
              max={0}
              step={1}
              value={draft.thresholdDb}
              onChange={(next) => setDraftField('thresholdDb', next)}
            />
          </label>
        )
      ) : (
        !inline && (
          <label className="settings-field">
            语音判定阈值
            <NumberStepper
              ariaLabel="语音判定阈值"
              min={0.05}
              max={0.95}
              step={0.05}
              value={draft.vadThreshold}
              onChange={(next) => setDraftField('vadThreshold', next)}
            />
          </label>
        )
      )}
      {!inline && (
        <label className="settings-field">
          最短气口（毫秒）
          <NumberStepper
            ariaLabel="最短气口"
            min={0}
            max={10000}
            step={50}
            value={draft.minGapMs}
            onChange={(next) => setDraftField('minGapMs', next)}
          />
        </label>
      )}
      <label className="settings-field">
        保留边距（毫秒）
        <NumberStepper
          ariaLabel="保留边距"
          min={0}
          max={1000}
          step={10}
          value={draft.marginMs}
          onChange={(next) => setDraftField('marginMs', next)}
        />
      </label>
      <label className="settings-field">
        中心保留（毫秒）
        <NumberStepper
          ariaLabel="中心保留"
          min={0}
          max={2000}
          step={10}
          value={draft.keepGapMs}
          onChange={(next) => setDraftField('keepGapMs', next)}
        />
      </label>
      {!inline && (
        <p className="contract-settings-hint">
          静音阈值模式剪掉低于阈值的静音段；语音检测模式可识别呼吸声等有声气口。边距防止剪掉字头字尾，
          0 毫秒中心保留会剪掉边距之间的全部气口。修改会自动保存。
        </p>
      )}
      {error && (
        <p className="silence-trim-error" role="alert">
          {error}
        </p>
      )}
      {inline ? (
        <NodePrimaryButton onClick={startTrim}>
          <Icon name="silence-trim" size={15} />
          开始去气口
        </NodePrimaryButton>
      ) : (
        <button type="button" className="silence-trim-save" onClick={save}>
          <Icon name="check" size={15} />
          保存去气口参数
        </button>
      )}
    </section>
  )
}
