// Renderer GatewayClient：把 preload 暴露的 window.api 包装为 GatewayClient 接口。
//
// 共享层执行器通过 ctx.gateway 调用此对象，等价于原来执行器中对
// window.api.gateway.*（模型网关）和 window.api.*（本地媒体处理）的直接调用。
// 方法签名与 preload 完全一致，不添加额外逻辑。
import type { GatewayClient } from '@shared/engine/gateway-client'

/**
 * 渲染进程全局唯一的 GatewayClient 实例。
 *
 * 共享执行器调用 ctx.gateway.chatStart(...) 时，等价于之前的
 * window.api.gateway.chatStart(...)；调用 ctx.gateway.cropImage(...) 时，
 * 等价于之前的 window.api.cropImage(...)。
 */
export const rendererGateway: GatewayClient = {
  // ── 模型网关 ──
  listProviders: () => window.api.gateway.listProviders(),
  chatStart: (input) => window.api.gateway.chatStart(input),
  chatCancel: (taskId) => window.api.gateway.chatCancel(taskId),
  imageGenerate: (input) => window.api.gateway.imageGenerate(input),
  imageEdit: (input) => window.api.gateway.imageEdit(input),
  videoSubmit: (input) => window.api.gateway.videoSubmit(input),
  videoCancel: (taskId) => window.api.gateway.videoCancel(taskId),
  videoTask: (taskId) => window.api.gateway.videoTask(taskId),
  audioGenerate: (input) => window.api.gateway.audioGenerate(input),
  onEvent: (cb) => window.api.gateway.onEvent(cb),

  // ── 本地媒体处理 ──
  cropImage: (input) => window.api.cropImage(input),
  splitImageGrid: (input) => window.api.splitImageGrid(input),
  extractVideoFrame: (input) => window.api.extractVideoFrame(input),
  clipVideo: (input) => window.api.clipVideo(input),
  extractVideoAudio: (input) => window.api.extractVideoAudio(input),
  separateVocals: (input) => window.api.separateVocals(input),
  ttsGenerate: (input) => window.api.ttsGenerate(input)
}
