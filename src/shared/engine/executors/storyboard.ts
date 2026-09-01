// 分镜板节点执行器：从上游 JSON/文本或节点存量解析分镜，标准化后写回 props.text。
import { inputJson, inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { normalizeShot, parseJsonObj } from '../helpers'

interface StoryboardData {
  shots: ReturnType<typeof normalizeShot>[]
  imageModelKey?: string
}

function parseStoryboard(value: unknown): StoryboardData | null {
  const raw = Array.isArray(value)
    ? { shots: value }
    : typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null
  if (!raw || !Array.isArray(raw.shots)) return null
  return {
    shots: raw.shots.map(normalizeShot),
    imageModelKey: typeof raw.imageModelKey === 'string' ? raw.imageModelKey : undefined
  }
}

export const storyboardExecutor = (ctx: NodeExecutionContext): NodeExecutionResult => {
  const fromJson = inputJson(ctx.inputs, 'in-json')[0]
  const fromText = inputText(ctx.inputs, 'in-text').trim()
  let data = parseStoryboard(fromJson)
  if (!data && fromText) {
    try {
      data = parseStoryboard(JSON.parse(fromText))
    } catch {
      return { status: 'failed', reason: '分镜板需要分镜 JSON 输入' }
    }
  }
  if (!data) data = parseStoryboard(parseJsonObj(ctx.shape.props.text))
  if (!data) return { status: 'skipped', reason: '无分镜数据' }
  ctx.updateProps({ text: JSON.stringify(data) })
  return { status: 'done' }
}
