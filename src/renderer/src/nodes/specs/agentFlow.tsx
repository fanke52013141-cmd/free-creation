/* eslint-disable react-refresh/only-export-components -- Node spec registration, like specs/index.tsx. */
import { useState } from 'react'
import { useEditor } from 'tldraw'
import type { PortDecl, PortType } from '@shared/types'
import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema,
  StateMachineNodeConfigSchema,
  DEFAULT_AGENT_NODE_CONFIG,
  DEFAULT_REVIEW_NODE_CONFIG,
  DEFAULT_STATE_NODE_CONFIG
} from '@shared/agent-flow/node-contracts'
import {
  agentFlowPendingExecutor,
  AGENT_FLOW_EXECUTION_PENDING
} from '@shared/engine/executors/agentFlow'
import {
  NODE_ACCENTS,
  registerNodeType,
  type NodeBodyProps,
  type NodeSettingsProps
} from '../registry'
import { NodeIdentity, NodePrimaryButton } from '../../canvas/NodePresentation'
import { useNodePanelStore } from '../../stores/nodePanel'
import { markUndoPoint } from '../../canvas/history'
import { AppSelect } from '../../components/AppSelect'
import './agentFlow.css'

const schemas = {
  agent: AgentNodeConfigSchema,
  'ai-review': ReviewNodeConfigSchema,
  'state-machine': StateMachineNodeConfigSchema
}
const defaults = {
  agent: DEFAULT_AGENT_NODE_CONFIG,
  'ai-review': DEFAULT_REVIEW_NODE_CONFIG,
  'state-machine': DEFAULT_STATE_NODE_CONFIG
}
type FlowType = keyof typeof schemas
function configOf(shape: NodeBodyProps['shape']): Record<string, unknown> {
  try {
    return schemas[shape.props.nodeType as FlowType].parse(JSON.parse(shape.props.config))
  } catch {
    return {}
  }
}
function AgentFlowBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const config = configOf(shape)
  const agent = shape.props.nodeType === 'agent'
  const review = shape.props.nodeType === 'ai-review'
  if (!agent && !review)
    return (
      <div className="agent-flow-body">
        <NodeIdentity>
          <small>初始阶段：{String(config.initialState ?? '未配置')}</small>
          <small>{AGENT_FLOW_EXECUTION_PENDING}</small>
        </NodeIdentity>
        <NodePrimaryButton
          onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
        >
          配置节点
        </NodePrimaryButton>
      </div>
    )
  return (
    <div className="agent-flow-body">
      <div className="agent-flow-summary">
        {agent
          ? `${config.role === 'builder' ? '搭建' : config.role === 'coordinator' ? '主控' : '专业'} Agent · ${config.interactionMode === 'autonomous' ? '自主处理' : '人机协作'}`
          : review
            ? `不通过时${config.rejectPolicy === 'stop' ? '停止' : '返工'} · 最多 ${config.maxReworks ?? 3} 次返工`
            : `初始阶段：${String(config.initialState ?? '未配置')}`}
      </div>
      {shape.props.nodeType !== 'state-machine' && (
        <label className="agent-flow-text">
          <span>{review ? '审核标准' : '任务目标'}</span>
          <textarea
            className="node-textarea"
            aria-label={review ? '审核标准' : '任务目标'}
            value={shape.props.text}
            maxLength={16384}
            placeholder={review ? '写明通过条件和需要检查的内容' : '描述任务目标与交付资产'}
            onChange={(event) =>
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                props: { text: event.target.value }
              })
            }
          />
        </label>
      )}
      <p className="agent-flow-pending">{AGENT_FLOW_EXECUTION_PENDING}</p>
      <NodePrimaryButton
        onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
      >
        配置节点
      </NodePrimaryButton>
    </div>
  )
}

function AgentFlowSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const type = shape.props.nodeType as FlowType
  const [saved, setSaved] = useState(shape.props.config)
  const [draft, setDraft] = useState<Record<string, unknown>>(() => configOf(shape))
  const [error, setError] = useState('')
  if (saved !== shape.props.config) {
    setSaved(shape.props.config)
    setDraft(configOf(shape))
  }
  const update = (key: string, value: unknown): void => {
    setDraft({ ...draft, [key]: value })
    setError('')
  }
  const textField = (label: string, key: string): React.JSX.Element => (
    <label className="settings-field">
      {label}
      <input
        aria-label={label}
        value={String(draft[key] ?? '')}
        onChange={(event) => update(key, event.target.value || undefined)}
      />
    </label>
  )
  const numberField = (label: string, key: string, min: number, max: number): React.JSX.Element => (
    <label className="settings-field">
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        value={Number(draft[key] ?? min)}
        onChange={(event) => update(key, Number(event.target.value))}
      />
    </label>
  )
  const listField = (label: string, key: string): React.JSX.Element => (
    <label className="settings-field">
      {label}
      <textarea
        aria-label={label}
        value={Array.isArray(draft[key]) ? (draft[key] as string[]).join('\n') : ''}
        placeholder="每行一个节点 ID"
        onChange={(event) =>
          update(
            key,
            event.target.value
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean)
          )
        }
      />
    </label>
  )
  const bindingField = (label: string, key: string): React.JSX.Element => (
    <label className="settings-field">
      {label}
      <textarea
        aria-label={label}
        value={
          Array.isArray(draft[key])
            ? (draft[key] as { id: string; version: string }[])
                .map((item) => `${item.id}@${item.version}`)
                .join('\n')
            : ''
        }
        placeholder="每行一个标识@版本"
        onChange={(event) =>
          update(
            key,
            event.target.value
              .split('\n')
              .filter(Boolean)
              .map((line) => {
                const index = line.lastIndexOf('@')
                return {
                  id: index < 0 ? line : line.slice(0, index),
                  version: index < 0 ? '' : line.slice(index + 1)
                }
              })
          )
        }
      />
    </label>
  )
  const save = (): void => {
    const result = schemas[type].safeParse(draft)
    if (!result.success) {
      setError('配置格式无效，请检查节点 ID、版本、预算和状态转换。')
      return
    }
    markUndoPoint(editor, 'agent-flow-config')
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(result.data) }
    })
    setError('')
  }
  return (
    <section className="node-settings agent-flow-settings">
      {type === 'agent' && (
        <>
          <label className="settings-field">
            职责
            <AppSelect
              value={String(draft.role)}
              onChange={(event) => update('role', event.target.value)}
            >
              <option value="builder">搭建 Agent</option>
              <option value="coordinator">主控 Agent</option>
              <option value="specialist">专业 Agent</option>
            </AppSelect>
          </label>
          <label className="settings-field">
            参与方式
            <AppSelect
              value={String(draft.interactionMode)}
              onChange={(event) => update('interactionMode', event.target.value)}
            >
              <option value="collaborative">人机协作</option>
              <option value="autonomous">自主处理</option>
            </AppSelect>
          </label>
          {numberField('最多处理步数', 'maxSteps', 1, 64)}
          {bindingField('Skills 及版本', 'skills')}
          {bindingField('工具及版本', 'tools')}
          {listField('允许处理的节点', 'allowedNodeIds')}
        </>
      )}
      {type === 'ai-review' && (
        <>
          {textField('标准版本', 'rulesVersion')}
          <label className="settings-field">
            不通过时
            <AppSelect
              value={String(draft.rejectPolicy)}
              onChange={(event) => update('rejectPolicy', event.target.value)}
            >
              <option value="rework">按反馈返工</option>
              <option value="stop">停止分支</option>
            </AppSelect>
          </label>
          {numberField('最多返工次数', 'maxReworks', 0, 10)}
          {textField('负责修订的节点', 'responsibleNodeId')}
          {listField('等待审核通过的节点', 'gatedNodeIds')}
        </>
      )}
      {type === 'state-machine' && (
        <>
          {textField('初始阶段', 'initialState')}
          {listField('阶段列表', 'states')}
          <p className="contract-settings-hint">阶段转换与控制关系暂不执行，后续接入统一调度。</p>
        </>
      )}
      {type !== 'state-machine' && textField('模型定义 ID', 'modelDefinitionId')}
      <p className="contract-settings-hint">当前仅保存配置；配置工具不会授予额外执行能力。</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" className="website-settings-save" onClick={save}>
        保存配置
      </button>
    </section>
  )
}

function port(id: string, type: PortType, direction: 'in' | 'out', schema?: string): PortDecl {
  return {
    id,
    name:
      (
        {
          text: '文本',
          json: '结构数据',
          image: '图片',
          video: '视频',
          audio: '音频',
          file: '文件'
        } as Partial<Record<PortType, string>>
      )[type] ?? '结果',
    dir: direction,
    description:
      direction === 'in'
        ? '按明确来源接收已提交的资产；未适配的类型禁止自动执行。'
        : '仅在正式执行成功后输出；当前配置阶段不产生结果。',
    type,
    required: direction === 'out',
    cardinality: direction === 'in' ? 'many' : 'one',
    ...(schema ? { schema: { id: schema, version: 1 } } : {})
  }
}
export function registerAgentFlowNodeTypes(): void {
  for (const type of ['agent', 'state-machine', 'ai-review'] as const) {
    const review = type === 'ai-review'
    const state = type === 'state-machine'
    registerNodeType({
      type,
      contractVersion: 1,
      label: review ? 'AI 审核' : state ? '状态机' : 'Agent',
      icon: review ? 'check' : state ? 'workflow' : 'spark',
      color: NODE_ACCENTS[type],
      defaultSize: { w: 340, h: 260 },
      category: 'logic',
      initialConfig: JSON.stringify(defaults[type]),
      description: review
        ? '审核固定版本的资产，给出是/否和反馈。返工通过显式控制关系调度。'
        : state
          ? '声明任务阶段和合法转换，展示任务状态。'
          : '按职责和协作方式处理任务，可绑定版本化 Skills 与工具。',
      executionDisabledReason: AGENT_FLOW_EXECUTION_PENDING,
      ports: {
        in: state
          ? [port('in-json', 'json', 'in', 'json.any')]
          : ['text', 'json', 'image', 'video', 'audio', 'file'].map((kind) =>
              port(`in-${kind}`, kind as PortType, 'in', kind === 'json' ? 'json.any' : undefined)
            ),
        out: state
          ? [port('out-state', 'json', 'out', 'flow.state')]
          : review
            ? [
                port('out-review', 'json', 'out', 'review.decision'),
                port('out-feedback', 'text', 'out')
              ]
            : [port('out-text', 'text', 'out'), port('out-json', 'json', 'out', 'json.any')].map(
                (item) => ({ ...item, required: false })
              )
      },
      executor: agentFlowPendingExecutor,
      projectOutputs: () => ({}),
      Body: AgentFlowBody,
      SettingsPanel: AgentFlowSettings
    })
  }
}
