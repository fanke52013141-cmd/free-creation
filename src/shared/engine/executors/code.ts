// 代码节点执行器：把命名输入交给受限执行环境，按返回值类型投影到命名输出。
// 支持 Coze 风格 async function main(args) 写法和旧版纯代码片段（向后兼容）。
// 支持自定义参数端口：用户可在 UI 表格中声明额外输入参数，每个参数生成一个独立输入端口。
//
// P3 变化：代码执行通过 ctx.runCode 注入，不再直接导入 renderer 的 codeRuntime 模块。
// renderer 运行器注入 Web Worker 实现；headless 运行器可注入 Node.js vm 实现。
import type { PortType } from '@shared/types'
import { inputJson, inputText, inputValue } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseJsonObj, type VariableValueType } from '../helpers'
import type { NodeValue } from '../values'

/** 自定义参数声明：用户在 UI 表格中添加的额外输入端口。 */
export interface CodeParam {
  name: string
  type: VariableValueType
}

export interface CodeConfig {
  source: string
  inputName: string
  inputType: VariableValueType
  outputName: string
  outputType: VariableValueType
  params: CodeParam[]
}

const ALLOWED_VAR_TYPES: VariableValueType[] = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'any'
]

/** 把参数名转换为合法的 kebab-case 端口 ID 后缀。 */
export function sanitizePortId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  )
}

/** 把 UI 变量类型映射到端口类型。 */
export function mapVarTypeToPortType(type: VariableValueType): PortType {
  switch (type) {
    case 'string':
      return 'text'
    case 'number':
    case 'boolean':
    case 'object':
    case 'array':
      return 'json'
    default:
      return 'any'
  }
}

/** 根据参数名生成端口 ID（供 resolvePorts 与执行器共用）。 */
export function paramPortId(name: string): string {
  return `in-param-${sanitizePortId(name)}`
}

/** 根据代码输出变量名生成稳定输出端口 ID。 */
export function outputPortId(name: string): string {
  return `out-${sanitizePortId(name)}`
}

export function parseCodeConfigs(text: string): CodeConfig {
  const value = parseJsonObj(text)
  if (value && typeof value.source === 'string') {
    const rawParams = Array.isArray(value.params) ? value.params : []
    const seenPortIds = new Set<string>()
    const params: CodeParam[] = rawParams
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({
        name: typeof p.name === 'string' ? p.name : '',
        type: ALLOWED_VAR_TYPES.includes(p.type as VariableValueType)
          ? (p.type as VariableValueType)
          : 'any'
      }))
      .filter((p) => {
        if (!p.name.trim()) return false
        const id = paramPortId(p.name)
        if (seenPortIds.has(id)) return false
        seenPortIds.add(id)
        return true
      })
    return {
      source: value.source,
      inputName: typeof value.inputName === 'string' ? value.inputName : 'input',
      inputType: ALLOWED_VAR_TYPES.includes(value.inputType as VariableValueType)
        ? (value.inputType as VariableValueType)
        : 'any',
      outputName: typeof value.outputName === 'string' ? value.outputName : 'output',
      outputType: ALLOWED_VAR_TYPES.includes(value.outputType as VariableValueType)
        ? (value.outputType as VariableValueType)
        : 'any',
      params
    }
  }
  return {
    source: text,
    inputName: 'input',
    inputType: 'any',
    outputName: 'output',
    outputType: 'any',
    params: []
  }
}

/** 动态端口冲突不能被静默去重，否则画布、连线和执行器会看到不同的契约。 */
export function codePortConfigErrors(text: string): string[] {
  const value = parseJsonObj(text)
  if (!value || !Array.isArray(value.params)) return []
  const seen = new Set<string>()
  const errors: string[] = []
  value.params.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      errors.push(`输入参数 ${index + 1} 必须是对象`)
      return
    }
    const source = raw as Record<string, unknown>
    const name = typeof source.name === 'string' ? source.name.trim() : ''
    if (!name) {
      errors.push(`输入参数 ${index + 1} 缺少名称`)
      return
    }
    const portId = paramPortId(name)
    if (seen.has(portId)) errors.push(`输入参数端口重复：${portId}`)
    seen.add(portId)
  })
  return errors
}

/** 把契约层 NodeValue 还原为代码运行时可消费的普通值。 */
function toCodeArgument(value: NodeValue | null): unknown {
  if (!value) return undefined
  if (value.kind === 'text' || value.kind === 'markdown') return value.text
  if (value.kind === 'json') return value.data
  // 媒体在代码中传递的是可序列化引用，不暴露二进制内容。
  return {
    kind: value.kind,
    mediaId: value.mediaId,
    mediaPath: value.mediaPath,
    mime: value.mime
  }
}

export const codeExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const configText = readNodeConfig(ctx.shape)
  const portErrors = codePortConfigErrors(configText)
  if (portErrors.length > 0) {
    const reason = `代码节点端口配置无效：${portErrors.join('；')}`
    ctx.updateResult(JSON.stringify({ kind: 'error', message: reason }))
    return { status: 'failed', reason }
  }
  const data = parseCodeConfigs(configText)
  const textInputs = inputText(ctx.inputs, 'in-text')
  const jsonInputs = inputJson(ctx.inputs, 'in-json')

  // 收集自定义参数端口的输入值，映射到 args[param.name]
  const customArgs: Record<string, unknown> = {}
  for (const param of data.params) {
    const portId = paramPortId(param.name)
    if (param.type === 'string') {
      customArgs[param.name] = inputText(ctx.inputs, portId)
    } else if (param.type === 'any') {
      customArgs[param.name] = toCodeArgument(inputValue(ctx.inputs, portId))
    } else {
      const jsons = inputJson(ctx.inputs, portId)
      customArgs[param.name] =
        jsons.length > 0 ? (param.type === 'array' ? jsons : jsons[0]) : undefined
    }
  }

  const primaryValue =
    data.inputType === 'string'
      ? textInputs
      : data.inputType === 'array'
        ? jsonInputs
        : (jsonInputs[0] ?? textInputs)

  if (!ctx.runCode) {
    return { status: 'failed', reason: '代码执行环境未注入（ctx.runCode 缺失）' }
  }

  try {
    const output = await ctx.runCode(data.source, {
      text: textInputs,
      json: jsonInputs,
      images: [],
      videos: [],
      audios: [],
      params: primaryValue,
      [data.inputName]: primaryValue,
      ...customArgs
    })
    ctx.updateResult(
      output.kind === 'text'
        ? JSON.stringify({ kind: 'text', text: output.text, variableName: data.outputName })
        : JSON.stringify({ kind: 'json', data: output.data, variableName: data.outputName })
    )
    return { status: 'done' }
  } catch (error) {
    // 把错误信息写入 meta，让 Body 可以显示给用户
    const message = error instanceof Error ? error.message : String(error)
    ctx.updateResult(JSON.stringify({ kind: 'error', message }))
    return { status: 'failed', reason: message }
  }
}
