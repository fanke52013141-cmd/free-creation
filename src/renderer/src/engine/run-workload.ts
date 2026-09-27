import type { GenerationTimingFeatures } from '@shared/contracts'
import type { ContractInputMap } from '@shared/engine/inputs'
import { inputJson, inputMedia, inputText } from '@shared/engine/inputs'
import { mergedPrompt, promptBundleText } from '@shared/engine/helpers'
import type { NodeCardShape } from '../canvas/NodeCardShape'

export interface RunWorkload {
  features: GenerationTimingFeatures
  providerKey: string
  modelKey: string
}

function configObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function safeKey(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/[^A-Za-z0-9._:@/-]/g, '-').slice(0, 96)
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : fallback
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function textUnits(value: string): number {
  return Math.min(1_000_000, Array.from(value.replace(/\s+/g, '')).length)
}

/** Capture only numeric work characteristics from the same port values the executor consumes. */
export async function captureRunWorkload(
  shape: NodeCardShape,
  inputs: ContractInputMap,
  projectId: string
): Promise<RunWorkload> {
  const config = configObject(shape.props.config)
  const params = config.params && typeof config.params === 'object' && !Array.isArray(config.params)
    ? config.params as Record<string, unknown>
    : {}
  const operation = shape.props.nodeType
  const rawModelKey = config.modelKey ?? config.modelId
  const modelKey = safeKey(rawModelKey, operation)
  const providerKey = safeKey(
    config.providerKey ?? config.providerId ?? (modelKey.includes('::') ? modelKey.split('::')[0] : undefined),
    operation.startsWith('video-') || operation === 'vocal-separate' ? 'local' : 'default'
  )
  const features: GenerationTimingFeatures = {}

  if (operation === 'image-gen') {
    features.imageCount = Math.max(1, Math.min(9, Math.floor(positive(config.count) ?? 1)))
  }
  if (operation === 'video') {
    const bundle = promptBundleText(inputJson(inputs, 'in-prompt')[0])
    const prompt = mergedPrompt(
      shape.props.text,
      [bundle, inputText(inputs, 'in-text')].filter(Boolean).join('\n')
    )
    features.textUnits = textUnits(prompt)
    features.targetDurationSec = positive(params.duration) ?? 5
    if (typeof params.resolution === 'string') features.resolution = safeKey(params.resolution, 'default')
    if (typeof config.mode === 'string') features.mode = safeKey(config.mode, 'default')
  } else if (['speech', 'tts', 'voice-design'].includes(operation)) {
    features.textUnits = textUnits(mergedPrompt(shape.props.text, inputText(inputs, 'in-text')))
    if (operation === 'voice-design' && typeof config.previewText === 'string') {
      features.textUnits += textUnits(config.previewText)
    }
    if (typeof config.backend === 'string') features.mode = safeKey(config.backend, 'default')
  } else if (['ai-process', 'script', 'storyboard', 'structured', 'text'].includes(operation)) {
    features.textUnits = textUnits(shape.props.text + inputText(inputs, 'in-text'))
  }
  if (operation === 'video-depth' || operation === 'video-clay') {
    const maxResolution = positive(config.maxResolution)
    if (maxResolution) features.resolution = String(maxResolution)
  }

  const sourceVideo = inputMedia(inputs, 'in-video', 'video')[0] ??
    inputMedia(inputs, 'in-reference-video', 'video')[0]
  if (sourceVideo) {
    try {
      const response = await window.api.probeVideo({ projectId, sourceMediaId: sourceVideo.mediaId })
      if (response.ok) {
        features.sourceDurationSec = positive(response.data.durationMs / 1000)
        features.sourceFps = positive(response.data.fps)
      }
    } catch {
      // Metadata improves ETA but must never block execution.
    }
  }
  if (operation === 'video-clip' || operation === 'video-audio') {
    const start = typeof config.startMs === 'number' ? config.startMs : 0
    const end = positive(config.endMs)
    if (end && end > start) features.sourceDurationSec = (end - start) / 1000
  }

  if (operation === 'tts' || operation === 'vocal-separate') {
    const sourceAudio = inputMedia(inputs, 'in-audio', 'audio')[0]
    const mediaId = sourceAudio?.mediaId ?? (typeof config.refMediaId === 'string' ? config.refMediaId : '')
    if (mediaId) {
      try {
        const response = await window.api.listMedia(projectId)
        if (response.ok) {
          features.sourceDurationSec = positive(response.data.find((asset) => asset.id === mediaId)?.durationSec)
        }
      } catch {
        // Missing audio duration falls back to text or operation history.
      }
    }
  }

  return { features, providerKey, modelKey }
}
