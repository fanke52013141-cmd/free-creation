import { inputMedia } from '../inputs'
import type { NodeExecutionContext, NodeExecutionResult } from '../executor-types'
import { readNodeConfig } from '../node-config'
import { parseVocalSeparationConfig } from '@shared/video-transform'
import type { VocalMode } from '@shared/video-transform'

export interface VocalSeparationNodeResult {
  kind: 'vocal-separation'
  version: 2
  vocals: { mediaId: string; mediaPath: string; mime: string }
  /** 仅当 config.outputAccompaniment=true 时存在。 */
  accompaniment?: { mediaId: string; mediaPath: string; mime: string }
  mode: VocalMode
  sourceMediaId: string
  /** 手动局部执行可能没有工作流 runId；不能伪造一个来源 ID。 */
  runId?: string
  at: number
}

export function parseVocalSeparationResult(text: string): VocalSeparationNodeResult | null {
  try {
    const raw = JSON.parse(text) as Partial<VocalSeparationNodeResult>
    if (
      raw.kind !== 'vocal-separation' ||
      raw.version !== 2 ||
      !raw.vocals?.mediaId ||
      !raw.vocals.mediaPath ||
      !raw.vocals.mime ||
      !raw.mode
    ) {
      return null
    }
    // 校验可选伴奏字段
    if (raw.accompaniment) {
      if (!raw.accompaniment.mediaId || !raw.accompaniment.mediaPath || !raw.accompaniment.mime) {
        return null
      }
    }
    return raw as VocalSeparationNodeResult
  } catch {
    return null
  }
}

export async function vocalSeparateExecutor(
  ctx: NodeExecutionContext
): Promise<NodeExecutionResult> {
  const source = inputMedia(ctx.inputs, 'in-audio', 'audio')[0]
  if (!source) return { status: 'skipped', reason: '请连接一段音频到"源音频"输入' }
  if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
  const config = parseVocalSeparationConfig(readNodeConfig(ctx.shape))
  try {
    const result = await ctx.gateway.separateVocals({
      projectId: ctx.projectId,
      sourceMediaId: source.mediaId,
      config
    })
    if (ctx.signal.cancelled) return { status: 'skipped', reason: '已取消' }
    if (!result.ok) return { status: 'failed', reason: result.error.message }

    const value: VocalSeparationNodeResult = {
      kind: 'vocal-separation',
      version: 2,
      vocals: {
        mediaId: result.data.vocals.id,
        mediaPath: result.data.vocals.path,
        mime: result.data.vocals.mime
      },
      mode: config.mode,
      sourceMediaId: source.mediaId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      at: Date.now()
    }

    // 伴奏仅在 config.outputAccompaniment=true 时由主进程产出
    if (result.data.accompaniment) {
      value.accompaniment = {
        mediaId: result.data.accompaniment.id,
        mediaPath: result.data.accompaniment.path,
        mime: result.data.accompaniment.mime
      }
    }

    // 卡片默认展示人声；正式的两条端口只从 nodeResult 精确投影。
    ctx.updateProps({
      mediaId: value.vocals.mediaId,
      mediaPath: value.vocals.mediaPath,
      mediaMime: value.vocals.mime,
      title: config.mode === 'quality' ? '分离人声（高质量）' : '增强人声（快速）'
    })
    ctx.updateResult(JSON.stringify(value))
    return { status: 'done' }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
