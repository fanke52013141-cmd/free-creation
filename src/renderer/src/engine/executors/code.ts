// 代码节点执行器：把命名输入交给受限 Worker 执行，按返回值类型投影到命名输出。
import { inputJson, inputText } from '../contracts'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { runCodeTransform } from '../codeRuntime'
import { parseJsonObj, type VariableValueType } from './shared'

interface CodeConfig {
  source: string
  inputName: string
  inputType: VariableValueType
  outputName: string
  outputType: VariableValueType
}

export function parseCodeConfigs(text: string): CodeConfig {
  const value = parseJsonObj(text)
  if (value && typeof value.source === 'string') {
    return {
      source: value.source,
      inputName: typeof value.inputName === 'string' ? value.inputName : 'input',
      inputType: (typeof value.inputType === 'string'
        ? value.inputType
        : 'any') as VariableValueType,
      outputName: typeof value.outputName === 'string' ? value.outputName : 'output',
      outputType: (typeof value.outputType === 'string'
        ? value.outputType
        : 'any') as VariableValueType
    }
  }
  return {
    source: text,
    inputName: 'input',
    inputType: 'any',
    outputName: 'output',
    outputType: 'any'
  }
}

export const codeExecutor = async (ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
  const data = parseCodeConfigs(ctx.shape.props.text)
  const textInputs = inputText(ctx.inputs, 'in-text')
  const jsonInputs = inputJson(ctx.inputs, 'in-json')
  const primaryValue =
    data.inputType === 'string'
      ? textInputs
      : data.inputType === 'array'
        ? jsonInputs
        : (jsonInputs[0] ?? textInputs)
  const output = await runCodeTransform(data.source, {
    text: textInputs,
    json: jsonInputs,
    images: [],
    videos: [],
    audios: [],
    [data.inputName]: primaryValue
  })
  ctx.updateResult(
    output.kind === 'text'
      ? JSON.stringify({ kind: 'text', text: output.text, variableName: data.outputName })
      : JSON.stringify({ kind: 'json', data: output.data, variableName: data.outputName })
  )
  return { status: 'done' }
}
