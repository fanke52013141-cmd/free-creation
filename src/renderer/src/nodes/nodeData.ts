/**
 * 节点数据字段访问器（R8 / WP1 字段三分）。
 *
 * NodeCardProps 三字段的唯一读写入口：
 * - text：用户可见内容（文本正文、对话 messages、分镜 shots、JSON 数据）
 * - config：节点固定配置（模型 key、系统提示词、参数、seed 等）
 * - result：上次运行的登记结果（NodeValue JSON）
 *
 * 兼容规则（双读）：旧数据全部混存在 text；config 为空即按旧格式解析。
 * 所有读取入口先看新字段、空则回退 text，保证迁移前后行为等价。
 * 写入入口只写新字段，禁止再把配置 JSON 写回 text。
 */

import type { NodeCardProps } from '../canvas/NodeCardShape'

export type { NodeCardProps }

/**
 * 各节点类型的配置键清单：拆分与合并的单一事实源。
 * 表中列出的键存 config；其余键（messages/shots/source 等）属于内容，存 text。
 * 未登记的节点类型视为"全部内容"（如 text/json：整段 text 即数据）。
 */
export const CONFIG_KEYS: Record<string, readonly string[]> = {
  'image-gen': ['prompt', 'modelKey', 'size', 'seed'],
  video: ['prompt', 'modelKey', 'params'],
  audio: ['mode', 'modelKey', 'text', 'voice', 'format'],
  chat: ['system', 'modelKey', 'temperature', 'maxTokens', 'autoCompress'],
  'ai-process': ['modelKey', 'system', 'mode', 'jsonSchema', 'temperature', 'maxTokens'],
  processor: ['inputName', 'outputName', 'valueType', 'fallback'],
  code: ['source', 'inputName', 'inputType', 'outputName', 'outputType', 'params'],
  storyboard: ['imageModelKey'],
  script: ['modelKey', 'outputFields'],
  iterate: ['itemVar', 'onFailure', 'maxRetries', 'concurrency', 'limit']
}

/** 运行期状态键：随执行产生、随执行覆盖，拆分到 result 字段（不进 config/text）。 */
export const RESULT_KEYS: Record<string, readonly string[]> = {
  'ai-process': ['result'],
  iterate: ['items', '_progress'],
  video: ['taskId']
}

function parseObj(text: string): Record<string, unknown> | null {
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function pickKeys(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/**
 * 节点数据合并视图（读取入口）。
 * 新格式：config 键 ⊕ text 键；旧格式（config 为空）：text 即完整数据。
 * 内容型节点（text/json）的 text 是纯文本或 JSON 数据本身，调用方自行判断。
 */
export function nodeData(props: NodeCardProps): Record<string, unknown> {
  const config = parseObj(props.config)
  const doc = parseObj(props.text)
  if (config === null) return doc ?? {}
  return { ...config, ...(doc ?? {}) }
}

/**
 * 全量合并视图（含运行期状态键）：config ⊕ text ⊕ result。
 * result 侧最后展开（同键时登记结果优先），供投影与需要读写完整数据的 Body 使用。
 */
export function nodeAll(props: NodeCardProps): Record<string, unknown> {
  return { ...nodeData(props), ...nodeState(props) }
}

/**
 * 全量合并视图的字符串形式：供 parseXxx(text) 这类按字符串解析的既有调用方
 * 平滑切换（Body / 执行器解析函数签名不变）。合并为空时回退原始 text，
 * 兼容纯文本内容与旧版纯提示词。
 */
export function nodeAllText(props: NodeCardProps): string {
  const merged = nodeAll(props)
  return Object.keys(merged).length > 0 ? JSON.stringify(merged) : props.text
}

/** 上次运行登记结果（读取入口）：result 字段优先，空则回退 meta.nodeResult（旧数据）。 */
export function resultTextOf(shape: {
  props: NodeCardProps
  meta?: Record<string, unknown>
}): string {
  if (shape.props.result) return shape.props.result
  const legacy = shape.meta?.nodeResult
  return typeof legacy === 'string' ? legacy : ''
}

/** 运行期状态合并视图：result 键 ⊕ 数据键（旧格式的状态键混在 text 中，双读兼容）。 */
export function nodeState(props: NodeCardProps): Record<string, unknown> {
  const state = parseObj(props.result)
  if (state !== null) return state
  const keys = RESULT_KEYS[props.nodeType]
  if (!keys) return {}
  const data = parseObj(props.text)
  return data ? pickKeys(data, keys) : {}
}

export interface NodeDataPatchOptions {
  /**
   * true 时返回的 patch 不含 result 键：tldraw updateShape 不触碰登记结果。
   * Body 只改配置/内容时用（改提示词不应清掉"AI 生成"来源标注等登记信息）；
   * 执行器写全量状态（含 taskId 等运行期键）时不用。
   */
  keepResult?: boolean
}

/**
 * 节点数据拆分写回（写入入口）。
 * 按节点的 CONFIG_KEYS / RESULT_KEYS 把合并数据拆成 { config, text, result } patch。
 * 空侧写空串，保持字段干净；调用方通过 editor.updateShape / ctx.updateProps 落盘。
 */
export function nodeDataPatch(
  nodeType: string,
  data: Record<string, unknown>,
  options: NodeDataPatchOptions = {}
): Partial<Pick<NodeCardProps, 'config' | 'text' | 'result'>> {
  const configKeys = CONFIG_KEYS[nodeType] ?? []
  const resultKeys = RESULT_KEYS[nodeType] ?? []
  const config: Record<string, unknown> = {}
  const doc: Record<string, unknown> = {}
  const state: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    if (configKeys.includes(key)) config[key] = value
    else if (resultKeys.includes(key)) state[key] = value
    else doc[key] = value
  }
  const patch: Partial<Pick<NodeCardProps, 'config' | 'text' | 'result'>> = {
    config: Object.keys(config).length > 0 ? JSON.stringify(config) : '',
    text: Object.keys(doc).length > 0 ? JSON.stringify(doc) : ''
  }
  if (!options.keepResult) {
    patch.result = Object.keys(state).length > 0 ? JSON.stringify(state) : ''
  }
  return patch
}

/**
 * 旧 text 混存数据的拆分纯函数（迁移入口，planLegacyMigrations 调用）。
 * 按节点类型把旧 text JSON 拆到 config / text / result 三字段；
 * 非对象（纯文本提示词、纯文本正文）原样保留在 text。幂等：对新格式数据再跑一遍结果不变。
 */
export function splitLegacyTextField(
  nodeType: string,
  text: string
): Pick<NodeCardProps, 'config' | 'text' | 'result'> {
  const value = parseObj(text)
  if (value === null || CONFIG_KEYS[nodeType] === undefined) {
    // 纯文本内容（text/json 节点、旧版纯提示词）或未登记类型：原样留在 text
    return { config: '', text, result: '' }
  }
  const patch = nodeDataPatch(nodeType, value)
  return { config: patch.config ?? '', text: patch.text ?? '', result: patch.result ?? '' }
}
