// 音色设计节点执行器：用一段自然语言描述设计音色。
//
// 一次运行产生两种声明过的输出：
//   out-audio 试听音频（媒体结果集合，与其他音频节点同一种语义）
//   out-json  音色档案 {voice_id, ...}，供下游配音节点 in-voice 直接引用
import { parseVoiceDesignConfig } from '@shared/voice-design'
import { inputText } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { mergedPrompt } from '../helpers'
import { readNodeConfig } from '../node-config'
import { appendMediaResult, serializeMediaResultCollection } from '../values'

export const voiceDesignExecutor = async (
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> => {
  const config = parseVoiceDesignConfig(readNodeConfig(ctx.shape))
  // 音色描述是用户正文（可由上游文本合并）；试听文本属于固定参数，存在 config。
  const prompt = mergedPrompt(ctx.shape.props.text, inputText(ctx.inputs, 'in-text')).trim()
  if (!prompt) return { status: 'skipped', reason: '无音色描述' }
  if (!config.providerId) return { status: 'skipped', reason: '未选择 MiniMax 供应商' }

  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }

  try {
    const result = await ctx.gateway.voiceDesign({
      projectId: ctx.projectId,
      providerId: config.providerId,
      prompt,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }

    const { asset, voiceId } = result.data
    ctx.updateResult(
      serializeMediaResultCollection(
        appendMediaResult(
          typeof ctx.shape.meta?.nodeResult === 'string' ? ctx.shape.meta.nodeResult : '',
          { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime },
          { nodeId: ctx.node.id, prompt: prompt.slice(0, 80), runId: ctx.runId, voiceId }
        )
      )
    )
    ctx.updateMeta?.({
      nodeExtra: JSON.stringify({
        'out-json': {
          voice_id: voiceId,
          provider: 'minimax',
          source: 'voice_design',
          label: prompt.slice(0, 40),
          preview_media_id: asset.id
        }
      })
    })
    ctx.emitArtifact?.({
      kind: 'audio',
      mediaId: asset.id,
      mediaPath: asset.path,
      mime: asset.mime,
      portId: 'out-audio',
      title: asset.name || '音色试听'
    })
    return { status: 'done' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '已取消') return { status: 'skipped', reason: '已取消' }
    return { status: 'failed', reason: `音色设计异常：${message}` }
  }
}
