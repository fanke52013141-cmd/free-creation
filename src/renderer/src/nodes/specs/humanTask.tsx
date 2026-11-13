/* eslint-disable react-refresh/only-export-components -- Node spec registration, like specs/index.tsx. */
import { useState } from 'react'
import { useEditor } from 'tldraw'
import type { PortDecl } from '@shared/types'
import {
  HumanTaskNodeConfigSchema,
  HumanTaskInstanceSchema,
  type HumanTaskNodeConfig,
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

function port(id: string, type: 'text' | 'json', dir: 'in' | 'out'): PortDecl {
  return {
    id,
    name: type === 'text' ? '文本' : '结构数据',
    dir,
    description:
      dir === 'in'
        ? '可选上下文：供人工参考的已提交资产，不自动决定结果。'
        : '人工正式提交并运行后才输出的结果；未提交不产生输出。',
    type,
    required: false,
    cardinality: dir === 'in' ? 'many' : 'one',
    ...(type === 'json' ? { schema: { id: 'json.any', version: 1 } } : {})
  }
}

/** 人工任务卡片：展示任务说明与状态；人工填写结果并提交（只写 pending meta，执行器权威推进）。 */
function HumanTaskBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const config = configOf(shape)
  const instance = instanceOf(shape)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const completed = instance?.status === 'completed'
  const revision = instance?.revision ?? 1

  const submit = (): void => {
    setError('')
    let value: { kind: 'text'; text: string } | { kind: 'json'; data: unknown }
    if (config.outputType === 'json') {
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
    markUndoPoint(editor, shape.id)
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      meta: {
        humanTaskPending: JSON.stringify({
          submissionId: crypto.randomUUID(),
          expectedRevision: revision,
          value
        })
      }
    })
    setDraft('')
  }

  return (
    <div className="agent-flow-body">
      <NodeIdentity>
        {config.instructions ? (
          <p className="agent-flow-pending">{config.instructions}</p>
        ) : (
          <p className="agent-flow-pending">人工任务：填写结果并提交，运行后正式交付。</p>
        )}
        {completed ? (
          <p className="agent-flow-pending" role="status">
            已完成（修订 {revision}）：结果已交付，可重新提交覆盖。
          </p>
        ) : (
          <p className="agent-flow-pending" role="status">
            等待人工提交（修订 {revision}）。
          </p>
        )}
      </NodeIdentity>
      <textarea
        className="agent-flow-textarea"
        aria-label="人工任务结果"
        rows={4}
        value={draft}
        placeholder={config.outputType === 'json' ? '输入 JSON 结果' : '输入结果文本'}
        onChange={(event) => setDraft(event.target.value)}
      />
      {error ? (
        <p className="agent-flow-pending" role="alert">
          {error}
        </p>
      ) : null}
      <NodePrimaryButton onClick={submit}>提交结果</NodePrimaryButton>
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
          onChange={(event) => update({ outputType: event.target.value as 'text' | 'json' })}
        >
          <option value="text">文本（out-text）</option>
          <option value="json">结构数据（out-json）</option>
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
      in: [port('in-text', 'text', 'in'), port('in-json', 'json', 'in')],
      out: [port('out-text', 'text', 'out'), port('out-json', 'json', 'out')]
    },
    executor: humanTaskExecutor,
    projectOutputs: projectHumanTaskOutputs,
    Body: HumanTaskBody,
    SettingsPanel: HumanTaskSettings
  })
}