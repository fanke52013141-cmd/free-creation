/* eslint-disable react-refresh/only-export-components -- Node spec registration, like specs/index.tsx. */
import { useState, useEffect } from 'react'
import { useEditor, useValue } from 'tldraw'
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
  agentExecutor,
  parseStateMachineInstance,
  parseStateMachinePending,
  reviewExecutor,
  stateMachineExecutor
} from '@shared/engine/executors/agentFlow'
import { projectReviewOutputs } from '@shared/agent-flow/review'
import { ReviewTaskControls } from './ReviewTaskControls'
import { projectAgentOutputs, projectStateMachineOutputs } from '@shared/agent-flow/agent-outputs'
import { useConfirmStore } from '../../stores/confirm'
import { AgentTaskControls } from './AgentTaskControls'
import { FlowBuilderControls } from './FlowBuilderControls'
import type { FlowAgentCatalog } from '@shared/agent-flow/desktop-tasks'
import {
  NODE_ACCENTS,
  getNodeType,
  getNodePorts,
  registerNodeType,
  type NodeBodyProps,
  type NodeSettingsProps
} from '../registry'
import { NodeIdentity, NodePrimaryButton } from '../../canvas/NodePresentation'
import { useNodePanelStore } from '../../stores/nodePanel'
import { markUndoPoint } from '../../canvas/history'
import { AppSelect } from '../../components/AppSelect'
import { FlowNodeSelect, FlowNodeTargets, FlowTransitions } from './agentFlowEditors'
import { canvasFlowDeclarations } from '../../canvas/agent-flow-declarations'
import { resolveFlowDeclaration } from '@shared/agent-flow/declarations'
import { beginFlowConfigEdit } from './agentFlowDiagnostics'
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
function parsedConfigOf(shape: NodeBodyProps['shape']): Record<string, unknown> | null {
  try {
    const result = schemas[shape.props.nodeType as FlowType].safeParse(
      JSON.parse(shape.props.config)
    )
    return result.success ? (result.data as Record<string, unknown>) : null
  } catch {
    return null
  }
}
function configOf(shape: NodeBodyProps['shape']): Record<string, unknown> {
  return (
    parsedConfigOf(shape) ?? (defaults[shape.props.nodeType as FlowType] as Record<string, unknown>)
  )
}
function AgentFlowBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const config = configOf(shape)
  const agent = shape.props.nodeType === 'agent'
  const review = shape.props.nodeType === 'ai-review'
  const configIsValid = parsedConfigOf(shape) !== null
  const issue = useValue(
    'agent-flow-declaration-issue',
    () => {
      const graph = canvasFlowDeclarations(editor)
      return resolveFlowDeclaration(
        { id: shape.id, type: shape.props.nodeType, config: shape.props.config, outputPortIds: [] },
        graph.nodes,
        graph.edges
      ).issues[0]
    },
    [editor, shape]
  )
  if (!configIsValid) {
    return (
      <div className="agent-flow-body">
        <NodeIdentity>
          <p className="agent-flow-pending" role="alert">
            节点配置无效，执行已阻止。请打开设置修复配置。
          </p>
        </NodeIdentity>
        <NodePrimaryButton
          onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
        >
          修复节点配置
        </NodePrimaryButton>
      </div>
    )
  }
  if (!agent && !review) {
    // 状态机独立执行（P2-A 首版）：卡片展示权威实例的当前阶段；人工提交事件
    // 只写入 meta.stateMachinePending（类比聊天面板写待发送消息），
    // 由 stateMachineExecutor 在下一次运行时校验修订并推进状态。
    const meta = shape.meta as Record<string, unknown> | undefined
    const instance = parseStateMachineInstance(meta?.stateMachine)
    const pendingSubmission = parseStateMachinePending(meta?.stateMachinePending)
    const currentState = instance?.state ?? String(config.initialState ?? '未配置')
    const legalEvents = Array.isArray(config.transitions)
      ? (config.transitions as { from: string; event: string; to: string }[]).filter(
          (item) => item.from === currentState
        )
      : []
    const nextRevision = instance?.revision ?? 1
    return (
      <div className="agent-flow-body">
        <NodeIdentity>
          <div className="agent-flow-summary">
            当前阶段：{currentState}
            {instance ? `（修订 ${instance.revision}）` : '（未启动）'}
          </div>
          {pendingSubmission ? (
            <p className="agent-flow-pending" role="status">
              已提交事件「{pendingSubmission.event}」（基于修订 {pendingSubmission.expectedRevision}
              ），运行节点后生效
            </p>
          ) : (
            <p className="agent-flow-pending">
              {instance
                ? legalEvents.length > 0
                  ? `可提交事件：${legalEvents.map((item) => item.event).join('、')}`
                  : '当前阶段没有声明的出边事件，可在设置中添加转换'
                : '运行节点即按初始阶段启动状态机任务'}
            </p>
          )}
          {issue && (
            <p className="agent-flow-pending" role="status">
              {issue}
            </p>
          )}
        </NodeIdentity>
        {legalEvents.length > 0 && (
          <NodePrimaryButton
            onClick={async () => {
              const event = legalEvents[0]?.event
              if (!event) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: {
                  ...(shape.meta ?? {}),
                  stateMachinePending: JSON.stringify({
                    eventId: crypto.randomUUID(),
                    event,
                    expectedRevision: nextRevision
                  })
                }
              })
              markUndoPoint(editor, 'state-machine-submit-event')
            }}
          >
            提交事件「{legalEvents[0]?.event}」
          </NodePrimaryButton>
        )}
        {instance && (
          <NodePrimaryButton
            onClick={async () => {
              const confirmed = await useConfirmStore.getState().confirm({
                title: '重置状态机任务',
                message: '将清除该节点的状态机实例与待应用事件，回到初始阶段。已产出的下游输出不受影响。',
                confirmText: '重置',
                danger: true
              })
              if (!confirmed) return
              editor.updateShape({
                id: shape.id,
                type: 'node-card',
                meta: {
                  ...(shape.meta ?? {}),
                  stateMachine: null,
                  stateMachinePending: null
                }
              })
              markUndoPoint(editor, 'state-machine-reset')
            }}
          >
            重置任务
          </NodePrimaryButton>
        )}
        <NodePrimaryButton
          onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
        >
          配置节点
        </NodePrimaryButton>
      </div>
    )
  }
  return (
    <div className="agent-flow-body">
      <div className="agent-flow-summary">
        {agent
          ? `${config.role === 'builder' ? '搭建' : config.role === 'coordinator' ? '主控' : '专业'} Agent · ${config.interactionMode === 'autonomous' ? '自主处理' : '人机协作'}`
          : review
            ? config.rejectPolicy === 'stop'
              ? '不通过时停止受控分支'
              : `不通过时返工 · 最多 ${config.maxReworks ?? 3} 次返工`
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
      {agent ? (
        config.role === 'builder' ? (
          <FlowBuilderControls shape={shape} />
        ) : (
          <AgentTaskControls shape={shape} />
        )
      ) : (
        <ReviewTaskControls shape={shape} />
      )}
      {issue && (
        <p className="agent-flow-pending" role="status">
          {issue}
        </p>
      )}
      {!agent && (
        <NodePrimaryButton
          onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
        >
          配置节点
        </NodePrimaryButton>
      )}
    </div>
  )
}

function AgentFlowSettings({ shape, editor, projectId }: NodeSettingsProps): React.JSX.Element {
  const type = shape.props.nodeType as FlowType
  const [saved, setSaved] = useState(shape.props.config)
  const [draft, setDraft] = useState<Record<string, unknown>>(() => configOf(shape))
  const [error, setError] = useState('')
  const [catalog, setCatalog] = useState<FlowAgentCatalog | null>(null)
  const [repairConfirmed, setRepairConfirmed] = useState(false)
  const savedConfigIsValid = parsedConfigOf(shape) !== null
  useEffect(() => {
    if (type === 'state-machine' || !window.api.flowAgentCatalog) return
    let disposed = false
    void window.api
      .flowAgentCatalog({ projectId, nodeId: shape.id })
      .then((reply) => {
        if (!disposed && reply.ok) setCatalog(reply.data)
      })
      .catch(() => {
        /* Saving/running reports unavailable configuration. */
      })
    return () => {
      disposed = true
    }
  }, [projectId, shape.id, type])
  const graph = useValue('agent-flow-targets', () => canvasFlowDeclarations(editor), [editor])
  const options = graph.shapes
    .filter((node) => node.id !== shape.id)
    .map((node) => ({
      id: node.id,
      label: `${node.props.title || '未命名'} · ${getNodeType(node.props.nodeType)?.label ?? '节点'}`
    }))
  const list = (key: string): string[] =>
    Array.isArray(draft[key]) ? (draft[key] as string[]) : []
  const reviewMode = String(draft.reviewMode ?? 'text-json')
  const reviewNeedsImage = ['image', 'sampled-video', 'audio-video'].includes(reviewMode)
  const reviewNeedsAudio = ['audio', 'audio-video'].includes(reviewMode)
  const supportsReviewModel = (model: FlowAgentCatalog['models'][number]): boolean =>
    (!reviewNeedsImage || Boolean(model.imageInput)) &&
    (!reviewNeedsAudio || Boolean(model.audioInput))
  const targetList = (label: string, key: string): React.JSX.Element => (
    <FlowNodeTargets
      label={label}
      values={list(key)}
      options={options}
      onChange={(value) => update(key, value)}
    />
  )
  if (saved !== shape.props.config) {
    setSaved(shape.props.config)
    setDraft(configOf(shape))
    setRepairConfirmed(false)
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
        placeholder="每行一个阶段，例如 draft、working、completed"
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
    const terminal = beginFlowConfigEdit(projectId, shape.id, type)
    if (!savedConfigIsValid && !repairConfirmed) {
      setError('已保存的配置无效。请先恢复默认配置，再保存修复结果。')
      terminal('failed', 'validation')
      return
    }
    const result = schemas[type].safeParse(draft)
    if (!result.success) {
      setError('配置格式无效，请检查节点 ID、版本、预算和状态转换。')
      terminal('failed', 'validation')
      return
    }
    const declaration = resolveFlowDeclaration(
      { id: shape.id, type, config: JSON.stringify(result.data), outputPortIds: [] },
      graph.nodes,
      graph.edges
    )
    if (declaration.issues.length) {
      setError(declaration.issues.join('；'))
      terminal('failed', 'validation')
      return
    }
    try {
      markUndoPoint(editor, 'agent-flow-config')
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { config: JSON.stringify(result.data) }
      })
      setError('')
      terminal('applied', 'apply')
    } catch {
      setError('配置未保存，请重试。')
      terminal('failed', 'apply')
    }
  }
  return (
    <section className="node-settings agent-flow-settings">
      {!savedConfigIsValid && !repairConfirmed && (
        <div className="contract-settings-hint" role="alert">
          <p>已保存的节点配置无效，当前无法运行。恢复默认配置后可检查并保存修复结果。</p>
          <button
            type="button"
            onClick={() => {
              setDraft(defaults[type] as Record<string, unknown>)
              setRepairConfirmed(true)
              setError('')
            }}
          >
            恢复默认配置
          </button>
        </div>
      )}
      {!savedConfigIsValid && repairConfirmed && (
        <p className="contract-settings-hint" role="status">
          默认配置已载入草稿。保存后才会替换无效配置。
        </p>
      )}
      {type === 'agent' && (
        <>
          <label className="settings-field">
            职责
            <AppSelect
              aria-label="职责"
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
              aria-label="参与方式"
              value={String(draft.interactionMode)}
              onChange={(event) => update('interactionMode', event.target.value)}
            >
              <option value="collaborative">人机协作</option>
              <option value="autonomous">自主处理</option>
            </AppSelect>
          </label>
          {numberField('最多处理步数', 'maxSteps', 1, 64)}
          {draft.role === 'coordinator' && (
            <label className="settings-field">
              任务调度
              <AppSelect
                aria-label="任务调度"
                value={String(draft.maxParallelTasks ?? 1)}
                onChange={(event) => update('maxParallelTasks', Number(event.target.value))}
              >
                <option value="1">顺序执行</option>
                <option value="2">独立任务并行（最多两路）</option>
                <option value="3">独立任务并行（最多三路）</option>
                <option value="4">独立任务并行（最多四路）</option>
              </AppSelect>
            </label>
          )}
          {catalog && (
            <>
              <label className="settings-field">
                决策模型
                <AppSelect
                  aria-label="决策模型"
                  value={String(draft.modelDefinitionId ?? '')}
                  onChange={(event) => update('modelDefinitionId', event.target.value)}
                >
                  <option value="">选择文本模型</option>
                  {catalog.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </AppSelect>
              </label>
              <fieldset className="agent-flow-targets">
                <legend>选择 Skills</legend>
                {catalog.skills.map((skill) => (
                  <label className="agent-flow-target-option" key={`${skill.id}@${skill.version}`}>
                    <input
                      type="checkbox"
                      aria-label={`Skill：${skill.name}`}
                      checked={(draft.skills as Array<{ id: string }>).some(
                        (item) =>
                          item.id === skill.id &&
                          (item as { version?: string }).version === skill.version
                      )}
                      onChange={(event) =>
                        update(
                          'skills',
                          event.target.checked
                            ? [
                                ...(draft.skills as Array<{ id: string; version: string }>).filter(
                                  (item) => item.id !== skill.id
                                ),
                                { id: skill.id, version: skill.version }
                              ]
                            : (draft.skills as Array<{ id: string }>).filter(
                                (item) => item.id !== skill.id
                              )
                        )
                      }
                    />
                    <span>
                      {skill.name} · v{skill.version}
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="agent-flow-target-option">
                <input
                  type="checkbox"
                  aria-label={
                    draft.role === 'builder'
                      ? '启用建图预览'
                      : draft.role === 'coordinator'
                        ? '启用专业 Agent 分派'
                        : '启用画布节点工具'
                  }
                  checked={(draft.tools as Array<{ id: string }>).some(
                    (item) =>
                      item.id ===
                      (draft.role === 'builder'
                        ? 'graph.preview'
                        : draft.role === 'coordinator'
                          ? 'agent.dispatch'
                          : 'node.execute')
                  )}
                  onChange={(event) =>
                    update(
                      'tools',
                      event.target.checked
                        ? [
                            {
                              id:
                                draft.role === 'builder'
                                  ? 'graph.preview'
                                  : draft.role === 'coordinator'
                                    ? 'agent.dispatch'
                                    : 'node.execute',
                              version: '1'
                            }
                          ]
                        : []
                    )
                  }
                />
                {draft.role === 'builder'
                  ? '生成文本流程预览'
                  : draft.role === 'coordinator'
                    ? '分派专业 Agent 任务'
                    : '执行画布数据处理或视频节点'}
              </label>
            </>
          )}
          {bindingField('Skills 及版本', 'skills')}
          {bindingField('工具及版本', 'tools')}
          {draft.role === 'coordinator' && (
            <label className="agent-flow-target-option">
              <input
                type="checkbox"
                aria-label="启用自动审核与返工"
                checked={(draft.tools as Array<{ id: string }>).some(
                  (tool) => tool.id === 'review.execute'
                )}
                onChange={(event) =>
                  update(
                    'tools',
                    event.target.checked
                      ? [
                          ...(draft.tools as Array<{ id: string; version: string }>).filter(
                            (tool) => tool.id !== 'review.execute'
                          ),
                          { id: 'review.execute', version: '1' }
                        ]
                      : (draft.tools as Array<{ id: string }>).filter(
                          (tool) => tool.id !== 'review.execute'
                        )
                  )
                }
              />
              执行范围内的审核与有界返工
            </label>
          )}
          {targetList(
            draft.role === 'builder' ? '材料来源（一个文本节点）' : '允许处理的节点',
            'allowedNodeIds'
          )}
        </>
      )}
      {type === 'ai-review' && (
        <>
          <label className="settings-field">
            审核范围
            <AppSelect
              aria-label="审核范围"
              value={reviewMode}
              onChange={(event) => update('reviewMode', event.target.value)}
            >
              <option value="text-json">完整文本 / JSON</option>
              <option value="sampled-video">视频抽帧画面（不含声音与完整时序）</option>
              <option value="image">整张固定图片</option>
              <option value="audio">完整固定音频</option>
              <option value="audio-video">完整音轨与视频时间线（画面抽样）</option>
            </AppSelect>
          </label>
          {draft.reviewMode === 'sampled-video' && (
            <p className="contract-settings-hint">
              只接一路固定 MP4（0.1–60 秒、至少 4 帧、最多 20 MiB），审核 4
              张抽样画面。请选择声明支持图片、文本操作验证通过且支持工具调用的模型。自动返工时，负责人须为控制该视频生成节点的专业
              Agent；主 Agent 须启用审核工具并配置范围和预算。
            </p>
          )}
          {draft.reviewMode === 'image' && (
            <p className="contract-settings-hint">
              只接一路固定 PNG、JPEG 或 WebP（最多 20
              MiB），把完整图像字节提交给审核模型。所选文本模型必须声明图片输入，且图片识别探测与结构化工具验证均通过。
            </p>
          )}
          {draft.reviewMode === 'audio' && (
            <p className="contract-settings-hint">
              只接一路固定音频（最多 20 MiB、60 秒），宿主完整解码为 16 kHz 单声道 WAV
              后发送。所选文本模型必须声明音频输入，并通过测试音调探测和结构化工具验证。
            </p>
          )}
          {draft.reviewMode === 'audio-video' && (
            <p className="contract-settings-hint">
              只接一路含一个视频流和一个音频流的固定 MP4（0.1–60 秒、最多 20
              MiB）。审核完整音轨和全帧时间戳摘要，画面仅提交四张时间锚点，不代表逐帧视觉判断；所选模型须验证图片与音频输入。
            </p>
          )}
          {catalog && (
            <label className="settings-field">
              审核模型
              <AppSelect
                aria-label="审核模型"
                value={String(draft.modelDefinitionId ?? '')}
                onChange={(event) => update('modelDefinitionId', event.target.value)}
              >
                <option value="">选择审核模型</option>
                {catalog.models.map((model) => (
                  <option key={model.id} value={model.id} disabled={!supportsReviewModel(model)}>
                    {model.name}
                    {(draft.reviewMode === 'image' ||
                      draft.reviewMode === 'sampled-video' ||
                      draft.reviewMode === 'audio-video') &&
                    !model.imageInput
                      ? ' · 图片能力未验证'
                      : ''}
                    {(draft.reviewMode === 'audio' || draft.reviewMode === 'audio-video') &&
                    !model.audioInput
                      ? ' · 音频能力未验证'
                      : ''}
                  </option>
                ))}
              </AppSelect>
            </label>
          )}
          {catalog &&
            ['image', 'audio', 'audio-video', 'sampled-video'].includes(reviewMode) &&
            !catalog.models.some(supportsReviewModel) && (
              <p className="contract-settings-hint">当前没有完成相应媒体输入验证的模型。</p>
            )}
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
          <FlowNodeSelect
            label="负责修订的节点"
            value={String(draft.responsibleNodeId ?? '')}
            options={options}
            onChange={(value) => update('responsibleNodeId', value || undefined)}
          />
          {targetList('等待审核通过的节点', 'gatedNodeIds')}
          <FlowNodeTargets
            label="审核对象来源"
            options={graph.edges
              .filter((edge) => edge.to.nodeId === shape.id)
              .map((edge) => ({
                id: JSON.stringify([edge.from.nodeId, edge.from.portId]),
                label: `${options.find((option) => option.id === edge.from.nodeId)?.label ?? '来源节点'} · ${(() => {
                  const source = graph.shapes.find((node) => node.id === edge.from.nodeId)
                  const spec = source && getNodeType(source.props.nodeType)
                  return source && spec
                    ? (getNodePorts(spec, source).out.find((port) => port.id === edge.from.portId)
                        ?.name ?? '失效输出')
                    : '失效输出'
                })()}`
              }))
              .filter(
                (option, index, all) => all.findIndex((item) => item.id === option.id) === index
              )}
            values={
              Array.isArray(draft.subjectSources)
                ? (draft.subjectSources as { nodeId: string; portId: string }[]).map((source) =>
                    JSON.stringify([source.nodeId, source.portId])
                  )
                : []
            }
            onChange={(values) =>
              update(
                'subjectSources',
                values.map((value) => {
                  const [nodeId, portId] = JSON.parse(value) as string[]
                  return { nodeId, portId }
                })
              )
            }
          />
        </>
      )}
      {type === 'state-machine' && (
        <>
          <FlowNodeSelect
            label="初始阶段"
            missingLabel="已移除的阶段"
            value={String(draft.initialState ?? '')}
            options={list('states').map((state) => ({ id: state, label: state }))}
            onChange={(value) => update('initialState', value)}
          />
          {listField('阶段列表', 'states')}
          <FlowTransitions
            states={[...new Set(list('states'))]}
            transitions={
              Array.isArray(draft.transitions)
                ? (draft.transitions as { from: string; event: string; to: string }[])
                : []
            }
            onChange={(value) => update('transitions', value)}
          />
          <p className="contract-settings-hint">
            主 Agent 按声明事件推进阶段，未声明的转换会阻断流程。
          </p>
        </>
      )}
      <FlowNodeTargets
        label="观察的节点"
        options={options}
        values={
          Array.isArray(draft.relations)
            ? (draft.relations as { kind: string; targetNodeId: string }[])
                .filter((item) => item.kind === 'observes')
                .map((item) => item.targetNodeId)
            : []
        }
        onChange={(values) =>
          update('relations', [
            ...(Array.isArray(draft.relations)
              ? (draft.relations as { kind: string }[]).filter((item) => item.kind !== 'observes')
              : []),
            ...values.map((targetNodeId) => ({
              relationId: `observe-${crypto.randomUUID()}`,
              kind: 'observes',
              sourceNodeId: shape.id,
              targetNodeId
            }))
          ])
        }
      />
      {Array.isArray(draft.relations) &&
        (draft.relations as { relationId: string; kind: string; targetNodeId: string }[])
          .filter((relation) => relation.kind !== 'observes')
          .map((relation) => (
            <div key={relation.relationId} className="agent-flow-target-option">
              <span>
                额外关系 ·{' '}
                {options.find((option) => option.id === relation.targetNodeId)?.label ??
                  '已删除的节点'}
              </span>
              <button
                type="button"
                onClick={() =>
                  update(
                    'relations',
                    (draft.relations as { relationId: string }[]).filter(
                      (item) => item.relationId !== relation.relationId
                    )
                  )
                }
              >
                移除关系记录
              </button>
            </div>
          ))}
      {type !== 'state-machine' && textField('模型定义 ID', 'modelDefinitionId')}
      <p className="contract-settings-hint">当前仅保存配置；配置工具不会授予额外执行能力。</p>
      {error && <p role="alert">{error}</p>}
      {(() => {
        const declaration = resolveFlowDeclaration(
          { id: shape.id, type, config: shape.props.config, outputPortIds: [] },
          graph.nodes,
          graph.edges
        )
        return declaration.issues.length ? (
          <p className="contract-settings-hint" role="status">
            已保存的声明需要修正：{declaration.issues.join('；')}
          </p>
        ) : null
      })()}
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
        : '仅在正式执行成功后输出已验证的结果；未启用的节点不产生输出。',
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
          ? '声明任务阶段与合法转换；人工提交事件、运行节点推进状态。'
          : '按职责和协作方式处理任务，可绑定版本化 Skills 与工具。',
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
      executor:
        type === 'agent'
          ? agentExecutor
          : review
            ? reviewExecutor
            : state
              ? stateMachineExecutor
              : agentFlowPendingExecutor,
      projectOutputs:
        type === 'agent'
          ? projectAgentOutputs
          : review
            ? projectReviewOutputs
            : state
              ? projectStateMachineOutputs
              : () => ({}),
      Body: AgentFlowBody,
      SettingsPanel: AgentFlowSettings
    })
  }
}
