/* eslint-disable react-refresh/only-export-components -- Node spec registration, like specs/index.tsx. */
import { admitHumanTaskSubmission } from '@shared/agent-flow/human-task-submission'
import { useState } from 'react'
import { useEditor } from 'tldraw'
import { HUMAN_TASK_FLOW_PORTS } from '@shared/agent-flow/video-adapter'
import { useAppStore } from '../../stores/app'
import {
  HumanTaskNodeConfigSchema,
  HumanTaskInstanceSchema,
  type HumanTaskNodeConfig,
  type HumanTaskValue,
  type HumanTaskInstance
} from '@shared/agent-flow/node-contracts'
import { humanTaskExecutor, projectHumanTaskOutputs } from '@shared/engine/executors/humanTask'
import { NODE_ACCENTS, registerNodeType, type NodeBodyProps, type NodeSettingsProps } from '../registry'
import { NODE_UI } from '../../canvas/node-ui-tokens'
import { NodeIdentity, NodePrimaryButton } from '../../canvas/NodePresentation'
import { markUndoPoint } from '../../canvas/history'
import { AppSelect } from '../../components/AppSelect'
import './agentFlow.css'

const DEFAULT_HUMAN_TASK_CONFIG: HumanTaskNodeConfig = {
  schemaVersion: 1,
  outputType: 'text',
  instructions: ''
}

function configOf(shape: NodeBodyProps['shape']): HumanTaskNodeConfig {
  const parsed = HumanTaskNodeConfigSchema.safeParse(
    (() => {
      try {
        return JSON.parse(shape.props.config || '{}')
      } catch {
        return null
      }
    })()
  )
  return parsed.success ? parsed.data : DEFAULT_HUMAN_TASK_CONFIG
}

function instanceOf(shape: NodeBodyProps['shape']): HumanTaskInstance | null {
  const raw = (shape.meta as Record<string, unknown> | undefined)?.humanTask
  if (typeof raw !== 'string' || !raw.trim()) return null
  const parsed = HumanTaskInstanceSchema.safeParse(
    (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    })()
  )
  return parsed.success ? parsed.data : null
}

/** 人工任务卡片：展示任务说明与状态；人工填写结果并提交（只写 pending meta，执行器权威推进）。 */
function HumanTaskBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const projectId = useAppStore((state) => state.currentProject?.id)
  const [picking, setPicking] = useState(false)
  const config = configOf(shape)
  const instance = instanceOf(shape)
  const [draft, setDraft] = useState('')
  const [handoffNote, setHandoffNote] = useState('')
  const [error, setError] = useState('')
  const completed = instance?.status === 'completed'
  const revision = instance?.revision ?? 1

  const mediaKind = config.outputType === 'image' || config.outputType === 'video'
    ? config.outputType
    : undefined

  const submit = async (): Promise<void> => {
    setError('')
    let value: HumanTaskValue
    if (mediaKind) {
      if (!projectId) return
      setPicking(true)
      try {
        const imported = await window.api.pickMedia(projectId)
        const media = imported.ok && imported.data.assets.find((asset) => asset.kind === mediaKind)
        if (!media) {
          if (!imported.ok || imported.data.assets.length || imported.data.errors.length)
            setError('请选择与交付类型一致的媒体')
          return
        }
        if (useAppStore.getState().currentProject?.id !== projectId || !editor.getShape(shape.id))
          return
        value = { kind: mediaKind, mediaId: media.id }
      } catch {
        setError('媒体导入失败，请重新选择')
        return
      } finally {
        setPicking(false)
      }
    } else if (config.outputType === 'json') {
      try {
        value = { kind: 'json', data: JSON.parse(draft) }
      } catch {
        setError('JSON 格式无效，请检查后重新提交')
        return
      }
    } else {
      if (!draft.trim()) {
        setError('请填写结果文本后提交')
        return
      }
      value = { kind: 'text', text: draft }
    }
    const current = editor.getShape<typeof shape>(shape.id)
    if (!current || current.type !== 'node-card') return
    const submitted = admitHumanTaskSubmission(current, {
      submissionId: crypto.randomUUID(),
      expectedRevision: revision,
      ...(handoffNote.trim() ? { handoffNote: handoffNote.trim() } : {}),
      value
    })
    if (!submitted.ok) {
      setError(submitted.code === 'HUMAN_TASK_SUBMISSION_CONFLICT'
        ? '本轮已有待应用的提交，请继续流程处理该提交'
        : '任务或交付类型已变化，请核对后重新提交')
      return
    }
    if (!submitted.replay) {
      markUndoPoint(editor, shape.id)
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        meta: { humanTaskPending: JSON.stringify(submitted.pending) }
      })
    }
    setDraft('')
    setHandoffNote('')
  }

  return (
    <div className="agent-flow-body">
      <NodeIdentity>
        {config.instructions ? (
          <p className="agent-flow-pending">{config.instructions}</p>
        ) : (
          <p className="agent-flow-pending">填写结果并提交，运行后交付。</p>
        )}
        {completed ? (
          <p className="agent-flow-pending" role="status">
            已完成，可重新提交覆盖。
          </p>
        ) : (
          <p className="agent-flow-pending" role="status">
            等待人工提交。
          </p>
        )}
      </NodeIdentity>
      {!mediaKind && <textarea
        className="agent-flow-textarea"
        aria-label="人工任务结果"
        rows={4}
        value={draft}
        placeholder={config.outputType === 'json' ? '输入 JSON 结果' : '输入结果文本'}
        onChange={(event) => setDraft(event.target.value)}
      />}
      {instance?.handoffNote && <p className="agent-flow-pending">交接说明 · {instance.handoffNote}</p>}
      <textarea
        className="agent-flow-textarea"
        aria-label="交接说明"
        placeholder="交接说明（可选）"
        value={handoffNote}
        maxLength={4096}
        onChange={(event) => setHandoffNote(event.target.value)}
      />
      {error ? (
        <p className="agent-flow-pending" role="alert">
          {error}
        </p>
      ) : null}
      <NodePrimaryButton disabled={picking || new TextEncoder().encode(handoffNote.trim()).length > 4096} onClick={() => void submit()}>
        {picking ? '正在选择素材' : mediaKind ? '选择媒体并提交' : '提交结果'}
      </NodePrimaryButton>
    </div>
  )
}

function HumanTaskSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const config = configOf(shape)
  const update = (patch: Partial<HumanTaskNodeConfig>): void => {
    markUndoPoint(editor, shape.id)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify({ ...config, ...patch }) }
    })
  }
  return (
    <div className="agent-flow-settings">
      <label className="settings-field">
        结果类型
        <AppSelect
          aria-label="结果类型"
          value={config.outputType}
          onChange={(event) => update({ outputType: event.target.value as HumanTaskNodeConfig['outputType'] })}
        >
          <option value="text">文本（out-text）</option>
          <option value="json">结构数据（out-json）</option>
          <option value="image">图片（out-image）</option>
          <option value="video">视频（out-video）</option>
        </AppSelect>
      </label>
      <label className="settings-field">
        任务说明
        <textarea
          className="agent-flow-textarea"
          aria-label="任务说明"
          rows={3}
          value={config.instructions ?? ''}
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </label>
    </div>
  )
}

export function registerHumanTaskNodeType(): void {
  registerNodeType({
    type: 'human-task',
    contractVersion: 1,
    label: '人工任务',
    icon: 'edit',
    color: NODE_ACCENTS['human-task'],
    defaultSize: { w: NODE_UI.width, h: NODE_UI.height.default },
    category: 'ai',
    initialConfig: JSON.stringify(DEFAULT_HUMAN_TASK_CONFIG),
    description: '纯人工任务：人工填写并提交结果，运行后正式交付；未提交时停等，不伪造成功。',
    ports: {
      in: HUMAN_TASK_FLOW_PORTS.filter((port) => port.dir === 'in'),
      out: HUMAN_TASK_FLOW_PORTS.filter((port) => port.dir === 'out')
    },
    executor: humanTaskExecutor,
    projectOutputs: projectHumanTaskOutputs,
    Body: HumanTaskBody,
    SettingsPanel: HumanTaskSettings
  })
}