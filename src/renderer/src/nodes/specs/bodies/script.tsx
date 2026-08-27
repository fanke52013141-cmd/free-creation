// 脚本节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import type { NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { markUndoPoint } from '../../../canvas/history'
import { gatherUpstreamText } from '../../../canvas/graph'
import { useGatewayStore, modelsByModality } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import { useWheelScroll, VARIABLE_TYPES } from './shared'

interface ScriptShot {
  id: string
  scene: string
  dialogue: string
  duration: string
  [key: string]: unknown
}

interface ScriptOutputField {
  id: string
  path: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
}

interface ScriptData {
  source: string
  shots: ScriptShot[]
  /** AI 拆解用的对话模型 key（`${providerId}::${modelId}`），空串表示未选 */
  modelKey?: string
  outputFields: ScriptOutputField[]
}

const DEFAULT_SCRIPT_FIELDS: ScriptOutputField[] = [
  { id: 'scene', path: 'scene', label: '画面描述', type: 'string', description: '镜头画面与构图' },
  {
    id: 'dialogue',
    path: 'dialogue',
    label: '台词',
    type: 'string',
    description: '角色台词或旁白'
  },
  {
    id: 'sound',
    path: 'sound',
    label: '音效',
    type: 'string',
    description: '环境声、动作声或音乐'
  },
  { id: 'duration', path: 'duration', label: '时长', type: 'string', description: '例如 3s' }
]

const emptyShot = (): ScriptShot => ({
  id: Math.random().toString(36).slice(2, 9),
  scene: '',
  dialogue: '',
  sound: '',
  duration: ''
})

function normalizeShot(v: unknown): ScriptShot {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    ...o,
    id: typeof o.id === 'string' ? o.id : Math.random().toString(36).slice(2, 9),
    scene: typeof o.scene === 'string' ? o.scene : '',
    dialogue: typeof o.dialogue === 'string' ? o.dialogue : '',
    duration: typeof o.duration === 'string' ? o.duration : ''
  }
}

function parseScript(text: string): ScriptData {
  if (!text) return { source: '', shots: [], outputFields: DEFAULT_SCRIPT_FIELDS }
  try {
    const v = JSON.parse(text) as {
      source?: unknown
      shots?: unknown
      modelKey?: unknown
      outputFields?: unknown
    }
    if (v && typeof v === 'object' && Array.isArray(v.shots)) {
      const outputFields = Array.isArray(v.outputFields)
        ? v.outputFields
            .map((field) => field as Partial<ScriptOutputField>)
            .filter(
              (field): field is ScriptOutputField =>
                typeof field.id === 'string' &&
                typeof field.path === 'string' &&
                typeof field.label === 'string' &&
                ['string', 'number', 'boolean', 'object', 'array'].includes(field.type ?? '')
            )
            .map((field) => ({ ...field, description: field.description ?? '' }))
        : DEFAULT_SCRIPT_FIELDS
      return {
        source: typeof v.source === 'string' ? v.source : '',
        shots: v.shots.map(normalizeShot),
        modelKey: typeof v.modelKey === 'string' ? v.modelKey : undefined,
        outputFields: outputFields.length > 0 ? outputFields : DEFAULT_SCRIPT_FIELDS
      }
    }
  } catch {
    // 非结构化内容视为剧本文本
  }
  return { source: text, shots: [], outputFields: DEFAULT_SCRIPT_FIELDS }
}

const SCRIPT_MAX_H = 640

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return
  let current = target
  for (const part of parts.slice(0, -1)) {
    const existing = current[part]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function getNestedValue(target: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined
      return (current as Record<string, unknown>)[part]
    }, target)
}

function buildStoryboardSystemPrompt(fields: ScriptOutputField[]): string {
  const example: Record<string, unknown> = {}
  for (const field of fields) {
    const sample =
      field.type === 'number'
        ? 0
        : field.type === 'boolean'
          ? false
          : field.type === 'array'
            ? []
            : field.type === 'object'
              ? {}
              : field.description || field.label
    setNestedValue(example, field.path, sample)
  }
  const definitions = fields
    .map((field) => `- ${field.path} (${field.type})：${field.description || field.label}`)
    .join('\n')
  return `你是一位专业的影视分镜导演。请将用户提供的剧本文本拆解为分镜列表。
输出要求：
1. 只输出一个 JSON 数组，不要添加其他文字或 Markdown 标记
2. 每个数组元素必须严格遵守以下字段定义，不能改名：
${definitions}
3. 字段路径中的点表示 JSON 层级，例如 camera.angle 表示 {"camera":{"angle":"..."}}
4. 根据剧情节奏合理划分镜头，画面描述应具体、可视化
单个元素结构示例：${JSON.stringify(example)}`
}

// 从 AI 响应中提取 JSON 数组
function extractShotsJson(raw: string): ScriptShot[] | null {
  const text = raw.trim()
  // 尝试直接解析
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v.map(normalizeShot)
  } catch {
    // 继续
  }
  // 尝试提取 ```json ... ``` 或 [ ... ] 块
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      const v = JSON.parse(jsonMatch[1].trim())
      if (Array.isArray(v)) return v.map(normalizeShot)
    } catch {
      // 继续
    }
  }
  const bracketStart = text.indexOf('[')
  const bracketEnd = text.lastIndexOf(']')
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    try {
      const v = JSON.parse(text.slice(bracketStart, bracketEnd + 1))
      if (Array.isArray(v)) return v.map(normalizeShot)
    } catch {
      // 继续
    }
  }
  return null
}

export function ScriptBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const data = parseScript(shape.props.text)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 离散操作（加/删/移镜头）的分段点名：不在 handler 里立即打点，
  // 等下方布局副作用把自动撑高的 h 变更并入同一步后再打，避免污染撤销粒度
  const pendingMarkRef = useRef<string | null>(null)
  useWheelScroll(scrollRef)

  // AI 拆解状态
  const [breaking, setBreaking] = useState(false)
  const [showOutputSettings, setShowOutputSettings] = useState(false)
  const breakTaskRef = useRef<string | null>(null)
  const breakBufRef = useRef<string>('')
  // 最新 data 的稳定引用，供注册一次的事件回调读取，避免闭包过期（A10）
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])
  const providers = useGatewayStore((s) => s.providers)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const chatModels = modelsByModality(providers, 'text')

  const update = (next: ScriptData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { text: JSON.stringify(next) }
    })
  }

  // 离开输入框时打撤销分段点：连续敲键在 pendingDiff 里自然合并为一步，
  // 分段点保证「本次编辑会话」与后续操作（加镜头等）不粘连
  const markSession = (): void => markUndoPoint(editor, 'script-edit')

  const patchShot = (id: string, patch: Partial<ScriptShot>): void => {
    update({ ...data, shots: data.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }

  const patchShotPath = (id: string, path: string, value: unknown): void => {
    update({
      ...data,
      shots: data.shots.map((shot) => {
        if (shot.id !== id) return shot
        const next = structuredClone(shot) as ScriptShot
        setNestedValue(next, path, value)
        return next
      })
    })
  }

  const moveShot = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= data.shots.length) return
    const shots = [...data.shots]
    ;[shots[index], shots[target]] = [shots[target], shots[index]]
    update({ ...data, shots })
    pendingMarkRef.current = 'shot-move'
  }

  // ── AI 拆解剧本：调用对话模型将剧本文本转为结构化分镜 ──
  useEffect(() => {
    const off = window.api.gateway.onEvent((e) => {
      if (!breakTaskRef.current || e.taskId !== breakTaskRef.current) return
      if (e.kind === 'chat-delta') {
        breakBufRef.current += e.text
      } else if (e.kind === 'chat-done') {
        const shots = extractShotsJson(breakBufRef.current)
        breakTaskRef.current = null
        breakBufRef.current = ''
        setBreaking(false)
        if (shots && shots.length > 0) {
          update({ ...dataRef.current, shots })
          pendingMarkRef.current = 'shot-breakdown'
          toast(`AI 拆解完成，生成 ${shots.length} 个镜头`)
        } else {
          toast('AI 拆解结果解析失败，请检查模型输出或换一个模型重试')
        }
      } else if (e.kind === 'chat-error') {
        breakTaskRef.current = null
        breakBufRef.current = ''
        setBreaking(false)
        toast(`AI 拆解失败：${e.error}`)
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const breakdown = async (): Promise<void> => {
    if (breaking) {
      // 正在拆解中 → 取消
      if (breakTaskRef.current) {
        await window.api.gateway.chatCancel(breakTaskRef.current)
      }
      breakTaskRef.current = null
      breakBufRef.current = ''
      setBreaking(false)
      return
    }
    const upstream = gatherUpstreamText(editor, shape.id)
    const source = upstream ? `${upstream}\n\n---\n\n${data.source.trim()}` : data.source.trim()
    if (!source) {
      toast('请先输入剧本文本或连接上游文本')
      return
    }
    const modelKey = data.modelKey ?? ''
    const opt = chatModels.find((m) => m.key === modelKey) ?? chatModels[0]
    if (!opt) {
      toast('请先在设置中配置对话模型')
      return
    }
    // 持久化选中的 modelKey
    if (data.modelKey !== opt.key) {
      update({ ...data, modelKey: opt.key })
    }
    breakBufRef.current = ''
    setBreaking(true)
    const res = await window.api.gateway.chatStart({
      providerId: opt.provider.id,
      modelId: opt.model.id,
      system: buildStoryboardSystemPrompt(data.outputFields),
      messages: [{ role: 'user', content: source }]
    })
    if (!res.ok) {
      setBreaking(false)
      toast(`发送失败：${res.error.message}`)
      return
    }
    breakTaskRef.current = res.data.taskId
  }

  // 内容增高时自动撑高卡片（只增不减，上限后内部滚动），手动缩放不被覆盖
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const need = el.scrollHeight + 2
    if (need > shape.props.h && shape.props.h < SCRIPT_MAX_H) {
      editor.updateShape({
        id: shape.id,
        type: 'node-card',
        props: { h: Math.min(SCRIPT_MAX_H, need) }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.shots.length, data.source.length, data.outputFields.length, showOutputSettings])

  // 在高度副作用之后执行：此刻文本+高度变更都已落入同一段 pendingDiff，再打分段点
  useLayoutEffect(() => {
    const name = pendingMarkRef.current
    if (!name) return
    pendingMarkRef.current = null
    markUndoPoint(editor, name)
  })

  return (
    <div className="script-body" ref={scrollRef}>
      <textarea
        className="script-source"
        value={data.source}
        rows={3}
        spellCheck={false}
        placeholder="输入或粘贴剧本文本…（点击「AI 拆解」可一键生成分镜）"
        onChange={(e) => update({ ...data, source: e.target.value })}
        onBlur={markSession}
        onPointerDown={(e) => stopEventPropagation(e)}
      />
      {showOutputSettings && (
        <div className="script-output-settings">
          <div className="script-output-head">
            <div>
              <strong>输出结构</strong>
              <span>支持用点号定义层级，如 camera.angle</span>
            </div>
            <button
              className="btn-ghost small"
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                setShowOutputSettings(false)
              }}
            >
              完成
            </button>
          </div>
          <div className="script-field-list">
            {data.outputFields.map((field, index) => (
              <div className="script-field-row" key={field.id}>
                <input
                  value={field.label}
                  aria-label={`字段 ${index + 1} 名称`}
                  placeholder="名称"
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    update({
                      ...data,
                      outputFields: data.outputFields.map((item) =>
                        item.id === field.id ? { ...item, label: e.target.value } : item
                      )
                    })
                  }
                />
                <input
                  value={field.path}
                  aria-label={`字段 ${index + 1} 路径`}
                  placeholder="字段路径"
                  spellCheck={false}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    update({
                      ...data,
                      outputFields: data.outputFields.map((item) =>
                        item.id === field.id ? { ...item, path: e.target.value } : item
                      )
                    })
                  }
                />
                <select
                  value={field.type}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onChange={(e) =>
                    update({
                      ...data,
                      outputFields: data.outputFields.map((item) =>
                        item.id === field.id
                          ? { ...item, type: e.target.value as ScriptOutputField['type'] }
                          : item
                      )
                    })
                  }
                >
                  {VARIABLE_TYPES.filter((item) => item.value !== 'any').map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  className="shot-op danger"
                  title="删除字段"
                  disabled={data.outputFields.length <= 1}
                  onPointerDown={(e) => stopEventPropagation(e)}
                  onClick={() =>
                    update({
                      ...data,
                      outputFields: data.outputFields.filter((item) => item.id !== field.id)
                    })
                  }
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn-ghost small"
            onPointerDown={(e) => stopEventPropagation(e)}
            onClick={() =>
              update({
                ...data,
                outputFields: [
                  ...data.outputFields,
                  {
                    id: Math.random().toString(36).slice(2, 9),
                    path: `field_${data.outputFields.length + 1}`,
                    label: `字段${data.outputFields.length + 1}`,
                    type: 'string',
                    description: ''
                  }
                ]
              })
            }
          >
            <Icon name="add" size={13} /> 添加字段
          </button>
        </div>
      )}
      {data.shots.length > 0 && (
        <div className="script-shots">
          {data.shots.map((shot, i) => (
            <div className="shot-row" key={shot.id}>
              <span className="shot-no">{i + 1}</span>
              <div className="shot-fields">
                <textarea
                  className="shot-scene"
                  value={shot.scene}
                  rows={2}
                  spellCheck={false}
                  placeholder="画面描述…"
                  onChange={(e) => patchShot(shot.id, { scene: e.target.value })}
                  onBlur={markSession}
                  onPointerDown={(e) => stopEventPropagation(e)}
                />
                <div className="shot-meta">
                  <input
                    className="shot-dialogue"
                    value={shot.dialogue}
                    spellCheck={false}
                    placeholder="台词 / 音效"
                    onChange={(e) => patchShot(shot.id, { dialogue: e.target.value })}
                    onBlur={markSession}
                    onPointerDown={(e) => stopEventPropagation(e)}
                  />
                  <input
                    className="shot-duration"
                    value={shot.duration}
                    spellCheck={false}
                    placeholder="时长"
                    onChange={(e) => patchShot(shot.id, { duration: e.target.value })}
                    onBlur={markSession}
                    onPointerDown={(e) => stopEventPropagation(e)}
                  />
                </div>
                {data.outputFields
                  .filter((field) => !['scene', 'dialogue', 'duration'].includes(field.path))
                  .map((field) => {
                    const raw = getNestedValue(shot, field.path)
                    const value =
                      typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
                    return (
                      <label className="shot-custom-field" key={field.id}>
                        <span>{field.label || field.path}</span>
                        <input
                          value={value}
                          spellCheck={false}
                          placeholder={field.path}
                          onPointerDown={(e) => stopEventPropagation(e)}
                          onChange={(e) => patchShotPath(shot.id, field.path, e.target.value)}
                          onBlur={markSession}
                        />
                      </label>
                    )
                  })}
              </div>
              <div className="shot-ops">
                <button
                  className="shot-op"
                  title="上移"
                  disabled={i === 0}
                  onClick={() => moveShot(i, -1)}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  ↑
                </button>
                <button
                  className="shot-op"
                  title="下移"
                  disabled={i === data.shots.length - 1}
                  onClick={() => moveShot(i, 1)}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  ↓
                </button>
                <button
                  className="shot-op danger"
                  title="删除镜头"
                  onClick={() => {
                    update({ ...data, shots: data.shots.filter((s) => s.id !== shot.id) })
                    pendingMarkRef.current = 'shot-delete'
                  }}
                  onPointerDown={(e) => stopEventPropagation(e)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="script-foot">
        <button
          className={`btn-ghost small ${showOutputSettings ? 'active' : ''}`}
          onClick={() => setShowOutputSettings((value) => !value)}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <Icon name="settings" size={14} /> 输出结构
        </button>
        <button
          className="btn-ghost small"
          onClick={() => {
            update({ ...data, shots: [...data.shots, emptyShot()] })
            pendingMarkRef.current = 'shot-add'
          }}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <>
            <Icon name="add" size={14} />
            添加镜头
          </>
        </button>
        {chatModels.length > 0 ? (
          <>
            <button
              className={`btn-breakdown ${breaking ? 'running' : ''}`}
              onClick={() => void breakdown()}
              disabled={!data.source.trim() && !breaking}
              onPointerDown={(e) => stopEventPropagation(e)}
            >
              {breaking ? (
                '取消拆解…'
              ) : (
                <>
                  <Icon name="spark" size={14} />
                  AI 拆解
                </>
              )}
            </button>
            <select
              className="script-model-select"
              value={data.modelKey ?? chatModels[0]?.key ?? ''}
              title="选择拆解用的对话模型"
              onChange={(e) => update({ ...data, modelKey: e.target.value })}
              onPointerDown={(e) => stopEventPropagation(e)}
            >
              {chatModels.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <button
            className="btn-ghost small"
            title="点击配置对话模型"
            onClick={(e) => {
              e.stopPropagation()
              openSettings()
            }}
            onPointerDown={(e) => stopEventPropagation(e)}
          >
            <>
              <Icon name="spark" size={14} />
              AI 拆解（需配置模型）
            </>
          </button>
        )}
      </div>
    </div>
  )
}
