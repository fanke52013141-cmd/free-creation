import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { ModelDefinition, ModelOperation } from '@free-creation/model-contracts'
import type { ProviderAdapter, ProviderValidationFinding, ProviderValidationRequest } from '@free-creation/model-runtime'
import { VIDU_MODELS, VIDU_Q3_MODEL } from '../../shared/vidu-cli'
import { pollVidu, submitViduWithPaths } from '../gateway/vidu-cli'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { newSpanId, newTraceId } from '../../shared/observability'

/** Only an actual reference-video result verifies Q4; balance/cost queries cannot. */
export class ViduValidationAdapter implements ProviderAdapter {
  readonly id = 'vidu-cli'

  supports(operation: ModelOperation, model: ModelDefinition): boolean {
    return operation === 'video.generate' && VIDU_MODELS.includes(model.modelId) && model.capabilities.some((item) => item.operation === operation)
  }

  async validate(request: ProviderValidationRequest): Promise<ProviderValidationFinding> {
    if (!this.supports(request.operation, request.model)) return { status: 'unsupported', message: '当前 Vidu 仅支持 Q4（3.4）图片参考生视频与 Q3（3.2）首尾帧' }
    const diag = { traceId: newTraceId(), spanId: newSpanId(), requestId: `vidu-${newSpanId()}` }
    const attributes = { providerId: request.connection.id, modelId: request.model.modelId, operation: 'video.generate' }
    const credentials = { baseURL: request.connection.baseUrl, apiKey: request.secret }
    let directory: string | undefined
    let taskId: string | undefined
    let phase = 'validation-fixture'
    emitGatewayEvent('model.request.started', 'Vidu 参考生视频验证开始', diag, { attributes })
    try {
      directory = await mkdtemp(join(tmpdir(), 'canvas-vidu-validation-'))
      const image = join(directory, 'reference.png')
      const canvas = createCanvas(512, 512)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#eee7da'; ctx.fillRect(0, 0, 512, 512)
      ctx.fillStyle = '#2467b2'; ctx.beginPath(); ctx.arc(256, 256, 100, 0, Math.PI * 2); ctx.fill()
      await writeFile(image, canvas.toBuffer('image/png'))
      const frames = request.model.modelId === VIDU_Q3_MODEL
      const imagePaths = [image]
      if (frames) {
        const tail = join(directory, 'tail.png')
        ctx.fillStyle = '#eee7da'; ctx.fillRect(0, 0, 512, 512)
        ctx.fillStyle = '#2467b2'; ctx.beginPath(); ctx.arc(330, 256, 100, 0, Math.PI * 2); ctx.fill()
        await writeFile(tail, canvas.toBuffer('image/png'))
        imagePaths.push(tail)
      }
      const resolution = frames ? '1080p' : '540p'
      phase = 'upload-submit'
      taskId = await submitViduWithPaths(credentials, { modelId: request.model.modelId, mode: frames ? 'first-last-frame' : 'reference', prompt: 'A blue ball gently moves to the right on a plain beige background. Static camera.', duration: 1, resolution, ratio: '1:1', imagePaths }, request.signal)
      emitGatewayEvent('model.request.accepted', 'Vidu 已受理参考生视频验证', diag, { upstreamTaskId: taskId, attributes })
      phase = 'poll'
      const deadline = Date.now() + 15 * 60_000
      while (Date.now() < deadline) {
        const state = await pollVidu(credentials, taskId, request.signal)
        if (state.status === 'succeeded') {
          emitGatewayEvent('model.request.completed', 'Vidu 参考生视频验证成功', diag, { upstreamTaskId: taskId, status: 'success', attributes })
          return { status: 'verified', message: `${frames ? 'Q3 首尾帧' : 'Q4 图片参考'}生视频已真实生成成功（1 秒 / ${resolution}，任务 ${taskId}）` }
        }
        if (state.status === 'failed' || state.status === 'cancelled') throw new Error('Vidu 验证任务未成功')
        if (request.signal?.aborted) throw new Error('Vidu 验证已停止')
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      }
      throw new Error('Vidu 验证等待超时')
    } catch {
      emitGatewayEvent('model.request.failed', 'Vidu 参考生视频验证失败', diag, { phase, upstreamTaskId: taskId, status: 'failed', attributes })
      return { status: 'failed', message: taskId ? `Vidu 验证未完成，原任务 ${taskId}；请先核对任务，避免重复计费` : 'Vidu 验证未完成，请检查 CLI 版本、Token、网络和额度', action: '检查 Vidu 连接；已受理的任务不要重复提交' }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }
}
