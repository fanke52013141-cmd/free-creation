import { z } from 'zod'
import { skillAgentConfig, skillAgentInstructions } from '../skill-agent'
import { waitForChat } from './helpers'
import { gatewayDiagnostics } from './executor-diagnostics'
import type { NodeExecutionContext } from './executor-types'
import type { ChatStartInput } from '../contracts'

const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read_resource'), skillId: z.string(), name: z.string() }).strict(),
  z.object({ action: z.literal('complete'), output: z.string().min(1) }).strict()
])

/** A bounded, content-only Agent loop shared by chat and processing nodes. */
export async function runSkillAgent(
  ctx: NodeExecutionContext,
  raw: unknown,
  input: ChatStartInput,
  validate?: (output: string) => void
): Promise<string> {
  const config = skillAgentConfig(raw)
  const messages = [...input.messages]
  const system = [
    input.system,
    '自主完成输入任务，不请求人工确认。你只能读取已绑定技能的参考资源并提交输出。',
    '每一步只返回一个 JSON 对象：{"action":"read_resource","skillId":"技能ID","name":"资源名"}，或 {"action":"complete","output":"最终正文字符串"}。最终正文必须满足用户指定的格式；JSON 正文也编码为 output 字符串。',
    skillAgentInstructions(config)
  ]
    .filter(Boolean)
    .join('\n\n')
  ctx.trace?.(
    'execution',
    'info',
    `Agent 已绑定 ${config.skills.length} 个固定版本技能，最多执行 ${config.maxSteps} 步`
  )
  for (let step = 1; step <= config.maxSteps; step++) {
    if (ctx.signal.cancelled) throw new Error('已取消')
    ctx.trace?.('request', 'info', `Agent 执行第 ${step} 步`)
    const reply = await waitForChat(
      ctx.gateway,
      {
        ...input,
        system,
        messages,
        diagnostics: gatewayDiagnostics(ctx)
      },
      ctx.signal
    )
    if (ctx.signal.cancelled) throw new Error('已取消')
    let feedback = '动作格式无效，请按规定返回 JSON 对象。'
    try {
      const decision = decisionSchema.parse(
        JSON.parse(reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'))
      )
      if (decision.action === 'complete') {
        if (!decision.output.trim()) throw new Error('模型返回为空')
        validate?.(decision.output)
        ctx.trace?.('result', 'info', 'Agent 输出已通过校验')
        return decision.output
      }
      const resources = config.skills.find((skill) => skill.id === decision.skillId)?.resources
      const resource =
        resources && Object.hasOwn(resources, decision.name) ? resources[decision.name] : undefined
      feedback =
        resource === undefined
          ? '指定资源不存在，请从已绑定技能的资源列表选择。'
          : `参考资源：\n${resource}`
    } catch (error) {
      // Provider content and validator messages are never included in diagnostics.
      feedback = `动作或最终输出未通过校验，请修正后重新提交。${error instanceof Error && !('issues' in error) && !(error instanceof SyntaxError) ? error.message.slice(0, 1000) : ''}`
    }
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: feedback })
  }
  throw new Error(`Agent 已达到 ${config.maxSteps} 步执行上限，未获得有效输出`)
}
