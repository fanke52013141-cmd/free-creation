/** Stable, versioned configuration shared by the video conversion nodes and the main process. */
export type VideoDepthConfig = {
  version: 1
  maxResolution: 512 | 768 | 1024
  nearColor: 'white' | 'black'
  preserveAudio: boolean
}

export type VideoClayConfig = {
  version: 1
  maxResolution: 512 | 768 | 1024
  reliefStrength: number
  lightAzimuth: number
  lightElevation: number
  ambientLight: number
  preserveAudio: boolean
}

export const DEFAULT_VIDEO_DEPTH_CONFIG: VideoDepthConfig = {
  version: 1,
  maxResolution: 512,
  nearColor: 'white',
  preserveAudio: true
}

export const DEFAULT_VIDEO_CLAY_CONFIG: VideoClayConfig = {
  version: 1,
  maxResolution: 512,
  reliefStrength: 1.5,
  lightAzimuth: 315,
  lightElevation: 35,
  ambientLight: 0.42,
  preserveAudio: true
}

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
  const finite = (key: string, fallback: number, min: number, max: number): number => {
    const number = Number(source[key])
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
  }
  return {
    version: 1,
    maxResolution: resolution(source.maxResolution, DEFAULT_VIDEO_CLAY_CONFIG.maxResolution),
    reliefStrength: finite('reliefStrength', DEFAULT_VIDEO_CLAY_CONFIG.reliefStrength, 0.25, 5),
    lightAzimuth: finite('lightAzimuth', DEFAULT_VIDEO_CLAY_CONFIG.lightAzimuth, 0, 359),
    lightElevation: finite('lightElevation', DEFAULT_VIDEO_CLAY_CONFIG.lightElevation, 5, 85),
    ambientLight: finite('ambientLight', DEFAULT_VIDEO_CLAY_CONFIG.ambientLight, 0, 0.9),
    preserveAudio: source.preserveAudio !== false
  }
}

export function serializeVideoDepthConfig(config: VideoDepthConfig): string {
  return JSON.stringify(parseVideoDepthConfig(config))
}

export function serializeVideoClayConfig(config: VideoClayConfig): string {
  return JSON.stringify(parseVideoClayConfig(config))
}
