import { NodeIdentity, NodePrimaryButton } from '../../../canvas/NodePresentation'
// AI 处理是一个纯处理节点：卡片保留清晰的操作入口，模型和生成参数统一放在右侧「设置」页。
import { useEffect } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from '../../../components/Icon'
import { useNodePanelStore } from '../../../stores/nodePanel'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseAiProcess, type AiProcessConfig } from '../../../engine/executors/aiProcess'
import { ModelSelect, NoModelHint } from './shared'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { AppSelect } from '../../../components/AppSelect'
import { NumberStepper } from '../../../components/NumberStepper'
import { projectNodeOutputs } from '../../nodeValues'
import { SkillAgentSettings } from './SkillAgentSettings'

const AI_SCHEMA_OPTIONS = [
  { id: 'json.any', version: 1, label: '通用 JSON（json.any@1）' },
  { id: 'storyboard.shots', version: 1, label: '分镜（storyboard.shots@1）' }
] as const

const AI_MODE_OPTIONS: Array<{
  value: AiProcessConfig['mode']
  label: string
  /** 唯一正式输出端口；由 projectAiProcessOutputs 投影，不能由 UI 另造结果。 */
  portId: string
  downstream: string
}> = [
  {
    value: 'text',
    label: '文本',
    portId: 'out-text',
    downstream: '连接文本节点或声明文本输入的处理节点。'
  },
  {
    value: 'markdown',
    label: 'Markdown',
    portId: 'out-markdown',
    downstream: '连接接受 Markdown 的文本输入；保留标题、列表和代码标记。'
  },
  {
    value: 'json',
    label: 'JSON',
    portId: 'out-json',
    downstream: '只连接声明匹配 Schema 的 JSON / 结构数据节点。'
  }
]

function modeOption(mode: AiProcessConfig['mode']): (typeof AI_MODE_OPTIONS)[number] {
  return AI_MODE_OPTIONS.find((option) => option.value === mode) ?? AI_MODE_OPTIONS[0]
}

function schemaKey(schema: AiProcessConfig['jsonSchema']): string {
  return schema ? `${schema.id}@${schema.version}` : ''
}

function schemaFromKey(key: string): AiProcessConfig['jsonSchema'] {
  const found = AI_SCHEMA_OPTIONS.find((option) => `${option.id}@${option.version}` === key)
  return found ? { id: found.id, version: found.version } : undefined
}

/** 成功结果直接呈现；配置沿用标题/右侧面板入口。 */
export function AiProcessBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const result = Object.values(projectNodeOutputs(shape)).find(
    (value) => value?.kind === 'text' || value?.kind === 'markdown' || value?.kind === 'json'
  )
  if (!result)
    return (
      <NodeIdentity>
        <NodePrimaryButton
          onClick={() => useNodePanelStore.getState().open('contract', shape.id, 'settings')}
        >
          <Icon name="settings" size={16} />
          配置处理设置
        </NodePrimaryButton>
      </NodeIdentity>
    )
  const resultText =
    result.kind === 'json'
      ? JSON.stringify(result.data, null, 2)
      : result.kind === 'text' || result.kind === 'markdown'
        ? result.text
        : ''
  return (
    <div
      className={`ai-process-result-frame${result.kind === 'markdown' ? ' ai-process-markdown' : ''}`}
      role="textbox"
      aria-label="完整处理结果"
      aria-readonly="true"
      aria-multiline="true"
      tabIndex={0}
      onPointerDown={(event) => {
        if (
          event.button === 0 &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !editor.getSelectedShapeIds().includes(shape.id)
        )
          editor.select(shape.id)
        stopEventPropagation(event)
      }}
    >
      {result.kind === 'markdown' ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
          {resultText}
        </ReactMarkdown>
      ) : (
        resultText
      )}
    </div>
  )
}

/** AI 处理的固定配置只在右侧详情「设置」中编辑，卡片不再承担配置表单。 */
export function AiProcessSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const providers = useGatewayStore((state) => state.providers)
  const loaded = useGatewayStore((state) => state.loaded)
  const loadProviders = useGatewayStore((state) => state.load)
  const config = parseAiProcess(readNodeConfig(shape))
  const options = modelsByModality(providers, 'text')
  const mode = modeOption(config.mode)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const save = (patch: Partial<AiProcessConfig>): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify({ ...config, ...patch }) }
    })
  }

  if (options.length === 0) {
    return (
      <section className="node-settings ai-process-settings">
        <SkillAgentSettings value={config.agent} onChange={(agent) => save({ agent })} />
        <NoModelHint />
      </section>
    )
  }

  return (
    <section className="node-settings ai-process-settings">
      <SkillAgentSettings value={config.agent} onChange={(agent) => save({ agent })} />
      <div className="settings-row">
        <span className="opt-label">模型</span>
        <ModelSelect
          value={config.modelKey}
          options={options}
          onChange={(modelKey) => save({ modelKey })}
        />
      </div>
      <div className="settings-row">
        <label className="opt-label" htmlFor={`ai-process-output-${shape.id}`}>
          输出类型
        </label>
        <AppSelect
          id={`ai-process-output-${shape.id}`}
          className="gen-select"
          value={config.mode}
          onChange={(event) => {
            const nextMode = event.target.value as AiProcessConfig['mode']
            save({
              mode: nextMode,
              ...(nextMode === 'json' && !config.jsonSchema
                ? { jsonSchema: schemaFromKey('json.any@1') }
                : {})
            })
          }}
        >
          {AI_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </AppSelect>
      </div>
      <p className="contract-settings-hint">
        本节点只处理数据；成功后由 <code>{mode.portId}</code> 提供给下游。{mode.downstream}
      </p>
      {config.mode === 'json' && (
        <div className="settings-row">
          <label className="opt-label" htmlFor={`ai-process-schema-${shape.id}`}>
            JSON Schema
          </label>
          <AppSelect
            id={`ai-process-schema-${shape.id}`}
            className="gen-select"
            value={schemaKey(config.jsonSchema)}
            onChange={(event) => save({ jsonSchema: schemaFromKey(event.target.value) })}
          >
            {AI_SCHEMA_OPTIONS.map((schema) => (
              <option
                key={`${schema.id}@${schema.version}`}
                value={`${schema.id}@${schema.version}`}
              >
                {schema.label}
              </option>
            ))}
          </AppSelect>
        </div>
      )}
      <label className="settings-field" htmlFor={`ai-process-system-${shape.id}`}>
        系统提示词
        <textarea
          id={`ai-process-system-${shape.id}`}
          className="node-textarea"
          defaultValue={config.system}
          rows={4}
          placeholder="定义处理目标、语气或输出约束…"
          onBlur={(event) => save({ system: event.currentTarget.value })}
        />
      </label>
      <div className="settings-row ai-process-number-settings">
        <span className="opt-label">温度</span>
        <NumberStepper
          ariaLabel="温度"
          min={0}
          max={2}
          step={0.1}
          value={String(config.temperature)}
          onChange={(next) => {
            const value = Number(next)
            if (Number.isFinite(value)) save({ temperature: value })
          }}
        />
        <span className="opt-label">最大输出</span>
        <NumberStepper
          ariaLabel="最大输出"
          min={256}
          max={32768}
          step={256}
          value={String(config.maxTokens)}
          onChange={(next) => {
            const value = Number(next)
            // 清空输入时保留旧值，不把空串折算成 0 个 token。
            if (next.trim() && Number.isFinite(value)) save({ maxTokens: value })
          }}
        />
        <span
          className="opt-label"
          title="失败后自动重试次数（仅限空返回 / 坏 JSON / 网络与 5xx 等瞬时错误）；重试可能产生额外请求费用"
        >
          自动重试
        </span>
        <NumberStepper
          ariaLabel="自动重试"
          min={0}
          max={5}
          step={1}
          value={String(config.retry.maxRetries)}
          onChange={(next) => {
            const value = Number(next)
            if (!Number.isFinite(value)) return
            save({
              retry: {
                maxRetries: Math.min(5, Math.max(0, value)),
                backoffMs: config.retry.backoffMs
              }
            })
          }}
        />
      </div>
    </section>
  )
}
