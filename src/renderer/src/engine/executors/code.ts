// 代码节点执行器：把命名输入交给受限 Worker 执行，按返回值类型投影到命名输出。
// 支持 Coze 风格 async function main(args) 写法和旧版纯代码片段（向后兼容）。
// 支持自定义参数端口：用户可在 UI 表格中声明额外输入参数，每个参数生成一个独立输入端口。
import type { PortType } from '@shared/types'
import { inputJson, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { runCodeTransform } from '../codeRuntime'
import { parseJsonObj, type VariableValueType } from './shared'

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

export function parseCodeConfigs(text: string): CodeConfig {
  const value = parseJsonObj(text)
  if (value && typeof value.source === 'string') {
    const rawParams = Array.isArray(value.params) ? value.params : []
    const params: CodeParam[] = rawParams
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => ({
        name: typeof p.name === 'string' ? p.name : '',
        type: ALLOWED_VAR_TYPES.includes(p.type as VariableValueType)
          ? (p.type as VariableValueType)
          : 'any'
      }))
      .filter((p) => p.name.trim())
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

export const codeExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const data = parseCodeConfigs(ctx.shape.props.text)
  const textInputs = inputText(ctx.inputs, 'in-text')
  const jsonInputs = inputJson(ctx.inputs, 'in-json')

  // 收集自定义参数端口的输入值，映射到 args[param.name]
  const customArgs: Record<string, unknown> = {}
  for (const param of data.params) {
    const portId = paramPortId(param.name)
    if (param.type === 'string') {
      customArgs[param.name] = inputText(ctx.inputs, portId)
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

  try {
    const output = await runCodeTransform(data.source, {
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
