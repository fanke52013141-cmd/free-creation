/** Stable, versioned configuration shared by the video conversion nodes and the main process. */
export type VideoDepthConfig = {
  version: 1
  maxResolution: 512 | 768 | 1024
  nearColor: 'white' | 'black'
  preserveAudio: boolean
}

export type VideoClayConfig = {
  version: 1 | 2
  maxResolution: 512 | 768 | 1024
  reliefStrength: number
  lightAzimuth: number
  lightElevation: number
  ambientLight: number
  preserveAudio: boolean
  preset: 'soft' | 'studio' | 'structure'
  quality: 'fast' | 'standard' | 'fine'
  shadowStrength: number
  temporalStability: number
  fieldOfView: number
}

export const DEFAULT_VIDEO_DEPTH_CONFIG: VideoDepthConfig = {
  version: 1,
  maxResolution: 512,
  nearColor: 'white',
  preserveAudio: true
}

export const DEFAULT_VIDEO_CLAY_CONFIG: VideoClayConfig = {
  version: 2,
  maxResolution: 768,
  reliefStrength: 1.5,
  lightAzimuth: 315,
  lightElevation: 45,
  ambientLight: 0.42,
  preserveAudio: true,
  preset: 'soft',
  quality: 'standard',
  shadowStrength: 0.35,
  temporalStability: 0.6,
  fieldOfView: 50
}

export const VIDEO_CLAY_PRESETS = {
  soft: {
    reliefStrength: 1.5,
    lightAzimuth: 315,
    lightElevation: 45,
    ambientLight: 0.42,
    shadowStrength: 0.35
  },
  studio: {
    reliefStrength: 2,
    lightAzimuth: 315,
    lightElevation: 35,
    ambientLight: 0.3,
    shadowStrength: 0.5
  },
  structure: {
    reliefStrength: 2.4,
    lightAzimuth: 300,
    lightElevation: 40,
    ambientLight: 0.32,
    shadowStrength: 0.4
  }
} satisfies Record<VideoClayConfig['preset'], Partial<VideoClayConfig>>

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function resolution(value: unknown, fallback: 512 | 768 | 1024): 512 | 768 | 1024 {
  return value === 768 || value === 1024 || value === 512 ? value : fallback
}

export function parseVideoDepthConfig(value: unknown): VideoDepthConfig {
  const source = parseObject(value)
  return {
    version: 1,
    maxResolution: resolution(source.maxResolution, DEFAULT_VIDEO_DEPTH_CONFIG.maxResolution),
    nearColor: source.nearColor === 'black' ? 'black' : 'white',
    preserveAudio: source.preserveAudio !== false
  }
}

export function parseVideoClayConfig(value: unknown): VideoClayConfig {
  const source = parseObject(value)
  const legacy = source.version !== 2
  const finite = (key: string, fallback: number, min: number, max: number): number => {
    const candidate = legacy ? Number(source[key]) : source[key]
    const number = typeof candidate === 'number' ? candidate : Number.NaN
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
  }
  return {
    // Existing stored v1/unversioned configurations retain the original renderer.
    version: legacy ? 1 : 2,
    maxResolution: resolution(
      source.maxResolution,
      legacy ? 512 : DEFAULT_VIDEO_CLAY_CONFIG.maxResolution
    ),
    reliefStrength: finite('reliefStrength', DEFAULT_VIDEO_CLAY_CONFIG.reliefStrength, 0.25, 5),
    lightAzimuth: finite('lightAzimuth', DEFAULT_VIDEO_CLAY_CONFIG.lightAzimuth, 0, 359),
    lightElevation: finite(
      'lightElevation',
      legacy ? 35 : DEFAULT_VIDEO_CLAY_CONFIG.lightElevation,
      5,
      85
    ),
    ambientLight: finite('ambientLight', DEFAULT_VIDEO_CLAY_CONFIG.ambientLight, 0, 0.9),
    preserveAudio: source.preserveAudio !== false,
    preset: source.preset === 'studio' || source.preset === 'structure' ? source.preset : 'soft',
    quality: source.quality === 'fast' || source.quality === 'fine' ? source.quality : 'standard',
    shadowStrength: finite('shadowStrength', DEFAULT_VIDEO_CLAY_CONFIG.shadowStrength, 0, 1),
    temporalStability: finite(
      'temporalStability',
      DEFAULT_VIDEO_CLAY_CONFIG.temporalStability,
      0,
      1
    ),
    fieldOfView: finite('fieldOfView', DEFAULT_VIDEO_CLAY_CONFIG.fieldOfView, 25, 90)
  }
}

export function serializeVideoDepthConfig(config: VideoDepthConfig): string {
  return JSON.stringify(parseVideoDepthConfig(config))
}

export function serializeVideoClayConfig(config: VideoClayConfig): string {
  return JSON.stringify(parseVideoClayConfig(config))
}
