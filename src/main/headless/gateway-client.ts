import type { GatewayClient } from '@shared/engine/gateway-client'
import type { GatewayEvent, IpcEnvelope } from '@shared/contracts'
import { listProviders } from '../gateway/providers.repo'
import { startChat, cancelChat } from '../gateway/chat'
import { generateImageToAsset } from '../gateway/image'
import { transformImageEdit } from '../media/image-edit'
import { submitVideoTask, cancelVideoTask, getVideoTask } from '../gateway/video'
import { generateAudioToAsset } from '../gateway/audio'
import { transformImageCrop, transformImageSplit } from '../media/image-transform'
import {
  transformVideoFrame,
  transformVideoClip,
  transformVideoAudio,
  separateVocals
} from '../media/video-transform'
import { transformTts } from '../media/tts-transform'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcEnvelope<never> {
  return {
    ok: false,
    error: {
      code: 'HEADLESS_GATEWAY_ERROR',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

async function wrap<T>(work: () => Promise<T>): Promise<IpcEnvelope<T>> {
  try {
    return ok(await work())
  } catch (error) {
    return fail(error)
  }
}

function wrapSync<T>(work: () => T): IpcEnvelope<T> {
  try {
    return ok(work())
  } catch (error) {
    return fail(error)
  }
}

/** 主进程/CLI/MCP 共用的 GatewayClient；没有 BrowserWindow 也能运行。 */
export function createHeadlessGateway(): GatewayClient {
  const listeners = new Set<(event: GatewayEvent) => void>()
  const emit = (event: GatewayEvent): void => listeners.forEach((listener) => listener(event))
  return {
    listProviders: async () => ok(listProviders()),
    chatStart: async (input) => wrapSync(() => ({ taskId: startChat(emit, input) })),
    chatCancel: async (taskId) => wrapSync(() => cancelChat(taskId)),
    imageGenerate: async (input) => wrap(() => generateImageToAsset(input)),
    imageEdit: async (input) => wrap(() => transformImageEdit(input)),
    videoSubmit: async (input) => wrapSync(() => submitVideoTask(emit, input)),
    videoCancel: async (taskId) => wrapSync(() => cancelVideoTask(taskId)),
    videoTask: async (taskId) => wrapSync(() => getVideoTask(taskId)),
    audioGenerate: async (input) => wrap(() => generateAudioToAsset(input)),
    onEvent: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    cropImage: async (input) => wrap(() => transformImageCrop(input)),
    splitImageGrid: async (input) => wrap(() => transformImageSplit(input)),
    extractVideoFrame: async (input) => wrap(() => transformVideoFrame(input)),
    clipVideo: async (input) => wrap(() => transformVideoClip(input)),
    extractVideoAudio: async (input) => wrap(() => transformVideoAudio(input)),
    separateVocals: async (input) => wrap(() => separateVocals(input)),
    ttsGenerate: async (input) => wrap(() => transformTts(input))
  }
}
