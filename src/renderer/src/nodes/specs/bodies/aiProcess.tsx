// AI 处理节点 Body（路线图 R6：bodies.tsx 拆分）
//
// 执行器只在 in-text / in-json 都为空时跳过，所以连线状态必须印在卡片上：
// 只看模型和温度，用户无法判断运行会发生什么。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor, useValue } from 'tldraw'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { parseAiProcess, type AiProcessConfig } from '../../../engine/executors/aiProcess'
import { ModelSelect, NoModelHint, useWheelScroll } from './shared'
import type { NodeBodyProps } from '../../registry'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { countIncomingConnections } from '../../../canvas/graph'
import { AppSelect } from '../../../components/AppSelect'

/** 从 meta.nodeResult 解析 AI 处理节点的上次运行结果。 */
function parseStoredAiResult(stored: string): AiProcessConfig['result'] | undefined {
  if (!stored) return undefined
  try {
    const value = JSON.parse(stored) as Record<string, unknown>
    if (value.kind === 'text' || value.kind === 'markdown' || value.kind === 'json') {
      return {
        kind: value.kind,
        ...(typeof value.text === 'string' ? { text: value.text } : {}),
        ...('data' in value ? { data: value.data } : {})
      } as AiProcessConfig['result']
    }
  } catch {
    // 未产生过有效运行结果。
  }
  return undefined
}

const AI_SCHEMA_OPTIONS = [
  { id: 'json.any', version: 1, label: '通用 JSON（json.any@1）' },
  { id: 'storyboard.shots', version: 1, label: '分镜（storyboard.shots@1）' }
] as const

const AI_MODE_OPTIONS: Array<{
  value: AiProcessConfig['mode']
  label: string
  /** 该模式唯一会写入的输出端口，与 projectAiProcessOutputs 的分支一致。 */
  portId: string
  hint: string
}> = [
  { value: 'text', label: '文本', portId: 'out-text', hint: '结果只写入 out-text。' },
  {
    value: 'markdown',
    label: 'Markdown',
    portId: 'out-markdown',
    hint: '结果只写入 out-markdown，保留 Markdown 标记。'
  },
  {
    value: 'json',
    label: 'JSON',
    portId: 'out-json',
    hint: '按所选 Schema 校验后写入 out-json；模型返回不合法则节点失败。'
  }
]

function modeOption(mode: AiProcessConfig['mode']): (typeof AI_MODE_OPTIONS)[number] {
  return AI_MODE_OPTIONS.find((o) => o.value === mode) ?? AI_MODE_OPTIONS[0]
}

function schemaKey(schema: AiProcessConfig['jsonSchema']): string {
  return schema ? `${schema.id}@${schema.version}` : ''
}

function schemaFromKey(key: string): AiProcessConfig['jsonSchema'] {
  const found = AI_SCHEMA_OPTIONS.find((s) => `${s.id}@${s.version}` === key)
  return found ? { id: found.id, version: found.version } : undefined
}

function resultSummary(result: AiProcessConfig['result']): string {
  if (!result) return ''
  if (result.kind === 'json') return JSON.stringify(result.data)
  if (typeof result.text === 'string') return result.text.trim()
  return ''
}

export function AiProcessBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const data = parseAiProcess(readNodeConfig(shape))
  // 运行结果从 meta.nodeResult 读取（配置/结果分离）；配置写入不再混入 result。
  const storedResult = parseStoredAiResult(
    typeof shape.meta?.nodeResult === 'string' ? shape.meta.nodeResult : ''
  )
  const [editingSystem, setEditingSystem] = useState(false)
  const [systemDraft, setSystemDraft] = useState(data.system)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(scrollRef)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const options = modelsByModality(providers, 'text')
  const selectedModel = options.find((o) => o.key === data.modelKey)
  const modelName = selectedModel?.model.name || selectedModel?.model.id || '未选择模型'
  const textCount = useValue(
    'ai-process text inputs',
    () => countIncomingConnections(editor, shape.id, 'in-text'),
    [editor, shape.id]
  )
  const jsonCount = useValue(
    'ai-process json inputs',
    () => countIncomingConnections(editor, shape.id, 'in-json'),
    [editor, shape.id]
  )
  const updateConfig = (next: AiProcessConfig): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(next) }
    })
  }

  const commitSystem = (): void => {
    setEditingSystem(false)
    if (systemDraft !== data.system) updateConfig({ ...data, system: systemDraft })
  }

  const summary = resultSummary(storedResult)
  const mode = modeOption(data.mode)

  if (options.length === 0) {
    return <NoModelHint onOpen={() => openSettings()} />
  }

  return (
    <div className="ai-process-body" ref={scrollRef}>
      <div className="ai-process-config">
        <label className="ai-row">
          <span className="ai-row-label">模型</span>
          <ModelSelect
            value={data.modelKey}
            options={options}
            onChange={(key) => updateConfig({ ...data, modelKey: key })}
          />
        </label>

        <div className="ai-row">
          <span className="ai-row-label">输出</span>
          <div className="ai-process-mode-col">
            <AppSelect
              className="gen-select"
              value={data.mode}
              title={`本次结果写入 ${mode.portId} 端口`}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => {
                const next = e.target.value as AiProcessConfig['mode']
                updateConfig({
                  ...data,
                  mode: next,
                  // 切出 json 模式时清掉 schema，切回时保持显式选择
                  ...(next === 'json' && !data.jsonSchema
                    ? { jsonSchema: schemaFromKey('json.any@1') }
                    : {})
                })
              }}
            >
              {AI_MODE_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </AppSelect>
            <div className="ai-process-mode-hint">
              <span>{mode.hint}</span>
              <code className="variable-expr">{mode.portId}</code>
            </div>
          </div>
        </div>

        {data.mode === 'json' && (
          <label className="ai-row">
            <span className="ai-row-label">Schema</span>
            <AppSelect
              className="gen-select"
              value={schemaKey(data.jsonSchema)}
              title="决定 out-json 声明的结构，并作为运行时校验标准；不符合则节点失败"
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => updateConfig({ ...data, jsonSchema: schemaFromKey(e.target.value) })}
            >
              {AI_SCHEMA_OPTIONS.map((s) => (
                <option key={`${s.id}@${s.version}`} value={`${s.id}@${s.version}`}>
                  {s.label}
                </option>
              ))}
            </AppSelect>
          </label>
        )}

        <div className="ai-row">
          <span className="ai-row-label">系统提示词</span>
          {editingSystem ? (
            <textarea
              className="node-textarea ai-system-edit"
              autoFocus
              value={systemDraft}
              onChange={(e) => setSystemDraft(e.target.value)}
              onBlur={commitSystem}
              onKeyDown={(e) => {
                if (e.key === 'Escape') commitSystem()
              }}
              onPointerDown={(e) => e.stopPropagation()}
              spellCheck={false}
            />
          ) : (
            <button
              className="ai-system-preview"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                setSystemDraft(data.system)
                setEditingSystem(true)
              }}
            >
              {data.system.trim() ? data.system : '未设置系统提示词'}
            </button>
          )}
        </div>

        <div className="ai-row ai-row-num">
          <label>
            <span className="ai-row-label">温度</span>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              title="0 更稳定重复，2 更发散"
              value={data.temperature}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => updateConfig({ ...data, temperature: Number(e.target.value) || 0 })}
            />
          </label>
          <label>
            <span className="ai-row-label">上限</span>
            <input
              type="number"
              step="256"
              min="256"
              title="本次回复的 token 上限，超出部分模型不会写完"
              value={data.maxTokens}
              onPointerDown={(e) => stopEventPropagation(e)}
              onChange={(e) => updateConfig({ ...data, maxTokens: Number(e.target.value) || 4096 })}
            />
          </label>
        </div>

        <div className={`ai-process-wiring ${textCount + jsonCount > 0 ? 'ok' : 'warn'}`}>
          <span className="ai-process-wiring-ports">
            <code className="variable-expr">in-text</code>
            <span>{textCount} 条</span>
            <code className="variable-expr">in-json</code>
            <span>{jsonCount} 项</span>
          </span>
          <span className="ai-process-wiring-note">
            {textCount + jsonCount > 0
              ? '两类输入合并成一次提问'
              : '两个输入端口都没连线，运行会跳过'}
          </span>
        </div>
      </div>

      <div className="ai-process-result">
        <span className="ai-result-label">上次结果</span>
        <div className="ai-result-preview">
          {summary ? (
            <span>{summary.length > 120 ? `${summary.slice(0, 120)}…` : summary}</span>
          ) : (
            <span className="ai-result-empty">尚未运行</span>
          )}
        </div>
      </div>
      <div className="ai-process-mode">
        {modelName} → {mode.portId}
      </div>
    </div>
  )
}
