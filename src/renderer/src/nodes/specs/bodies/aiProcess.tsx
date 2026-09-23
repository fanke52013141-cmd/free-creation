// AI 处理是一个纯处理节点：卡片只说明它接收什么、会从哪个正式端口给下游，
// 模型和生成参数统一放在右侧「设置」页，避免把运行结果误看成一个资产节点。
import { useEffect } from 'react'
import { useEditor, useValue } from 'tldraw'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseAiProcess, type AiProcessConfig } from '../../../engine/executors/aiProcess'
import { ModelSelect, NoModelHint } from './shared'
import type { NodeBodyProps, NodeSettingsProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { AppSelect } from '../../../components/AppSelect'
import { countIncomingConnections } from '../../../canvas/graph'

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

/** 卡片只显示已声明的输入和输出状态；配置与历史结果在右侧详情中查看。 */
export function AiProcessBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const textCount = useValue(
    `${shape.id}:in-text-count`,
    () => countIncomingConnections(editor, shape.id, 'in-text'),
    [editor, shape.id]
  )
  const jsonCount = useValue(
    `${shape.id}:in-json-count`,
    () => countIncomingConnections(editor, shape.id, 'in-json'),
    [editor, shape.id]
  )
  const config = parseAiProcess(readNodeConfig(shape))
  const mode = modeOption(config.mode)
  const hasInput = textCount + jsonCount > 0

  return (
    <div className="ai-process-body">
      <div className={`ai-process-wiring ${hasInput ? 'ok' : 'warn'}`}>
        <span className="ai-process-wiring-ports">
          <span>文本输入 {textCount} 条</span>
          <span>JSON 输入 {jsonCount} 条</span>
        </span>
        {!hasInput && <span className="ai-process-wiring-note">等待文本或 JSON 输入</span>}
      </div>
      <div className="ai-process-mode" title={mode.downstream}>
        输出 {mode.label} → <code>{mode.portId}</code>
      </div>
    </div>
  )
}

/** AI 处理的固定配置只在右侧详情「设置」中编辑，卡片不再承担配置表单。 */
export function AiProcessSettings({ shape, editor }: NodeSettingsProps): React.JSX.Element {
  const providers = useGatewayStore((state) => state.providers)
  const loaded = useGatewayStore((state) => state.loaded)
  const loadProviders = useGatewayStore((state) => state.load)
  const openSettings = useGatewayStore((state) => state.openSettings)
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
    return <NoModelHint onOpen={() => openSettings()} presetIds={['relay']} />
  }

  return (
    <section className="node-settings ai-process-settings">
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
        <label className="opt-label" htmlFor={`ai-process-temperature-${shape.id}`}>
          温度
        </label>
        <input
          id={`ai-process-temperature-${shape.id}`}
          type="number"
          min="0"
          max="2"
          step="0.1"
          value={config.temperature}
          onChange={(event) => save({ temperature: Number(event.target.value) || 0 })}
        />
        <label className="opt-label" htmlFor={`ai-process-tokens-${shape.id}`}>
          最大输出
        </label>
        <input
          id={`ai-process-tokens-${shape.id}`}
          type="number"
          min="256"
          step="256"
          value={config.maxTokens}
          onChange={(event) => save({ maxTokens: Number(event.target.value) || 4096 })}
        />
      </div>
    </section>
  )
}
