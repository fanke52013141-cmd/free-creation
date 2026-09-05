// 模型网关客户端抽象（契约规范 P3 / 路线图 R1）
//
// 把执行器对 window.api.gateway 的直接依赖抽象为接口，使其可在
// Electron main/headless 和 renderer 两种环境中运行。
//
// renderer 实现：包装 window.api.gateway（IPC 调用）。
// main 实现：直接调用 gateway 模块（chat/image/video/audio）。
import type { IpcEnvelope, GatewayEvent, LocalMediaCapabilities } from '../contracts'
import type {
  ChatStartInput,
  ImageGenerateInput,
  ImageEditInput,
  VideoSubmitInput,
  VideoSubmitResult,
  AudioGenerateInput,
  ImageCropTransformInput,
  ImageSplitTransformInput,
  VideoFrameTransformInput,
  VideoClipTransformInput,
  VideoAudioTransformInput,
  VocalSeparateInput,
  VocalSeparationResult,
  TtsGenerateInput
} from '../contracts'
import type { MediaAsset, ProviderSummary, VideoTaskInfo } from '../types'

/**
 * 执行器调用的宿主 API 表面。
 *
 * 包含两类方法：
 * 1. 模型网关（chat/image/video/audio 生成）—— 对应 preload window.api.gateway
 * 2. 本地媒体处理（裁剪/拆分/取帧/截取/提音/TTS/人声分离）—— 对应 preload window.api 顶层方法
 *
 * 方法签名与 preload 完全一致，确保同一份执行器代码在 renderer（IPC）和
 * main（直调）下行为等价。renderer 注入 IPC 包装；headless 注入直调实现。
 */
export interface GatewayClient {
  // ── 模型网关 ──
  listProviders(): Promise<IpcEnvelope<ProviderSummary[]>>
  chatStart(input: ChatStartInput): Promise<IpcEnvelope<{ taskId: string }>>
  chatCancel(taskId: string): Promise<IpcEnvelope<boolean>>
  imageGenerate(input: ImageGenerateInput): Promise<IpcEnvelope<MediaAsset>>
  imageEdit(input: ImageEditInput): Promise<IpcEnvelope<MediaAsset>>
  videoSubmit(input: VideoSubmitInput): Promise<IpcEnvelope<VideoSubmitResult>>
  videoCancel(taskId: string): Promise<IpcEnvelope<boolean>>
  videoTask(taskId: string): Promise<IpcEnvelope<VideoTaskInfo | null>>
  audioGenerate(input: AudioGenerateInput): Promise<IpcEnvelope<MediaAsset>>
  /** 订阅网关事件（流式分片 / 视频进度），返回取消订阅函数。 */
  onEvent(cb: (event: GatewayEvent) => void): () => void

  /**
   * 本机媒体能力探测。执行器将它作为运行前提示/门禁使用；保留为可选方法，
   * 兼容旧版 headless 调用方与纯执行器单测注入的最小 Gateway mock。
   */
  getLocalMediaCapabilities?: () => Promise<IpcEnvelope<LocalMediaCapabilities>>

  // ── 本地媒体处理 ──
  cropImage(input: ImageCropTransformInput): Promise<IpcEnvelope<MediaAsset>>
  splitImageGrid(input: ImageSplitTransformInput): Promise<IpcEnvelope<MediaAsset[]>>
  extractVideoFrame(input: VideoFrameTransformInput): Promise<IpcEnvelope<MediaAsset>>
  clipVideo(input: VideoClipTransformInput): Promise<IpcEnvelope<MediaAsset>>
  extractVideoAudio(input: VideoAudioTransformInput): Promise<IpcEnvelope<MediaAsset>>
  separateVocals(input: VocalSeparateInput): Promise<IpcEnvelope<VocalSeparationResult>>
  ttsGenerate(input: TtsGenerateInput): Promise<IpcEnvelope<MediaAsset>>
}
