// 共享层执行器注册表（P3）
//
// 将全部 24 种节点类型的执行器集中注册，供 renderer 运行器和 headless 运行器共用。
// 契约规范 §6 P3 禁止新增按 nodeType 分发的第二套执行器 switch；运行器只通过此注册表取执行器。
//
// 导出策略：
//   1. EXECUTOR_REGISTRY / getExecutor — 运行器接口
//   2. 逐文件 re-export — renderer adapter 从此处 re-export 到旧路径，保持向后兼容
import type { NodeExecutor } from '../executor-types'

import { textExecutor } from './text'
import { jsonExecutor } from './json'
import { imageExecutor } from './image'
import { storyboardExecutor } from './storyboard'
import { processorExecutor } from './processor'
import { chatExecutor } from './chat'
import { aiProcessExecutor } from './aiProcess'
import { imageGenExecutor } from './imageGen'
import { imageEditExecutor } from './imageEdit'
import { audioExecutor } from './audio'
import { ttsExecutor } from './tts'
import { videoExecutor } from './video'
import { scriptExecutor } from './script'
import { imageCropExecutor } from './imageCrop'
import { imageSplitExecutor } from './imageSplit'
import { vocalSeparateExecutor } from './vocalSeparate'
import { videoFrameExecutor, videoClipExecutor, videoAudioExecutor } from './videoTransforms'
import { codeExecutor } from './code'
import { structuredExecutor } from './structured'
import { directorExecutor } from './director'
import { iterateExecutor } from './iterate'

/**
 * 全局执行器注册表。key = ActiveNodeTypeId，value = 该节点的执行函数。
 * 运行器通过 getExecutor(nodeType) 获取执行器，找不到时返回 undefined。
 */
export const EXECUTOR_REGISTRY: Record<string, NodeExecutor> = {
  // ── 素材输入 ──
  text: textExecutor,
  image: imageExecutor,
  'image-gen': imageGenExecutor,
  audio: audioExecutor,
  video: videoExecutor,
  // ── 图像处理 ──
  'image-crop': imageCropExecutor,
  'image-split': imageSplitExecutor,
  'image-edit': imageEditExecutor,
  // ── 视频处理 ──
  'video-frame': videoFrameExecutor,
  'video-clip': videoClipExecutor,
  'video-audio': videoAudioExecutor,
  // ── 音频语音 ──
  'vocal-separate': vocalSeparateExecutor,
  tts: ttsExecutor,
  speech: audioExecutor,
  chat: chatExecutor,
  // ── 逻辑流程 ──
  processor: processorExecutor,
  json: jsonExecutor,
  structured: structuredExecutor,
  code: codeExecutor,
  storyboard: storyboardExecutor,
  'ai-process': aiProcessExecutor,
  iterate: iterateExecutor,
  director: directorExecutor,
  // ── 退役节点（保留执行兼容，不再可创建）──
  script: scriptExecutor
}

/**
 * 按节点类型取出执行器。未注册的类型返回 undefined；运行器据此标记为「未实现」并跳过。
 */
export function getExecutor(nodeType: string): NodeExecutor | undefined {
  return EXECUTOR_REGISTRY[nodeType]
}

// ── 逐文件 re-export（供 renderer adapter 向后兼容）──

export { textExecutor } from './text'
export { jsonExecutor } from './json'
export { imageExecutor } from './image'
export { storyboardExecutor } from './storyboard'
export { processorExecutor, parseProcessor } from './processor'
export { chatExecutor } from './chat'
export { aiProcessExecutor, parseAiProcess } from './aiProcess'
export { imageGenExecutor, parseImageGen } from './imageGen'
export { imageEditExecutor } from './imageEdit'
export { audioExecutor, parseAudio } from './audio'
export { ttsExecutor } from './tts'
export { videoExecutor } from './video'
export { scriptExecutor, parseScript } from './script'
export { imageCropExecutor } from './imageCrop'
export { imageSplitExecutor } from './imageSplit'
export { vocalSeparateExecutor, parseVocalSeparationResult } from './vocalSeparate'
export { videoFrameExecutor, videoClipExecutor, videoAudioExecutor } from './videoTransforms'
export {
  codeExecutor,
  parseCodeConfigs,
  codePortConfigErrors,
  mapVarTypeToPortType,
  paramPortId,
  outputPortId,
  sanitizePortId
} from './code'
export { structuredExecutor } from './structured'
export { directorExecutor } from './director'
export { iterateExecutor, parseIterate, parseIterateResult } from './iterate'
