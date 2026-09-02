// P3 Renderer Adapter：shared.ts 兼容 shim → 共享层 helpers
//
// 纯函数与类型直接 re-export。waitForChat / waitForVideo 的签名在共享层变为
// (gateway, input, signal)；此 shim 保持 renderer 旧签名 (input, signal)，
// 内部注入 rendererGateway，供测试和向后兼容使用。
export {
  parseJsonObj,
  normalizeShot,
  extractShots,
  mergedPrompt,
  promptBundleText,
  parseVideoGen,
  findTextModelShared as findTextModel
} from '@shared/engine/helpers'

export type {
  ShotShape,
  ChatInput,
  VideoMedia,
  VideoGenData,
  VariableValueType
} from '@shared/engine/helpers'

import {
  waitForChat as _waitForChat,
  waitForVideo as _waitForVideo
} from '@shared/engine/helpers'
import type { ChatInput, VideoMedia } from '@shared/engine/helpers'
import type { CancelSignal } from '../executor-types'
import { rendererGateway } from '../rendererGateway'

/** 旧签名兼容：waitForChat(input, signal) → 内部注入 rendererGateway。 */
export function waitForChat(input: ChatInput, signal: CancelSignal): Promise<string> {
  return _waitForChat(rendererGateway, input, signal)
}

/** 旧签名兼容：waitForVideo(taskId, signal) → 内部注入 rendererGateway。 */
export function waitForVideo(taskId: string, signal: CancelSignal): Promise<VideoMedia> {
  return _waitForVideo(rendererGateway, taskId, signal)
}
