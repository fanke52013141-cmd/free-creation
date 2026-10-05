import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIDEO_CLAY_CONFIG,
  parseVideoClayConfig,
  serializeVideoClayConfig,
  VIDEO_CLAY_PRESETS
} from '@shared/video-conversion'

describe('白模渲染配置与历史复跑', () => {
  it('显式新配置使用标准 v2，空/损坏旧配置不静默升级', () => {
    expect(parseVideoClayConfig({ version: 2 })).toEqual(DEFAULT_VIDEO_CLAY_CONFIG)
    expect(parseVideoClayConfig('')).toMatchObject({ version: 1, maxResolution: 512 })
    expect(parseVideoClayConfig('{bad')).toMatchObject({ version: 1, maxResolution: 512 })
  })
  it('旧版本及无版本存量参数继续走原渲染，不修改输出尺寸与光源', () => {
    for (const value of [{ version: 1 }, { reliefStrength: 3 }]) {
      expect(parseVideoClayConfig(value)).toMatchObject({
        version: 1,
        maxResolution: 512,
        lightElevation: 35
      })
    }
    expect(
      parseVideoClayConfig({ version: 1, maxResolution: 1024, reliefStrength: 5 })
    ).toMatchObject({ version: 1, maxResolution: 1024, reliefStrength: 5 })
    expect(parseVideoClayConfig({ version: 1, reliefStrength: '3' })).toMatchObject({
      version: 1,
      reliefStrength: 3
    })
  })
  it('拒绝空值与错误类型，限制参数范围', () => {
    expect(
      parseVideoClayConfig({
        version: 2,
        shadowStrength: 3,
        temporalStability: -2,
        fieldOfView: 100
      })
    ).toMatchObject({ shadowStrength: 1, temporalStability: 0, fieldOfView: 90 })
    expect(
      parseVideoClayConfig({
        version: 2,
        reliefStrength: null,
        ambientLight: '',
        shadowStrength: '0.5'
      })
    ).toMatchObject({ reliefStrength: 1.5, ambientLight: 0.42, shadowStrength: 0.35 })
  })
  it.each(['soft', 'studio', 'structure'] as const)('%s 预设修改后稳定序列化与恢复', (preset) => {
    const config = {
      ...DEFAULT_VIDEO_CLAY_CONFIG,
      ...VIDEO_CLAY_PRESETS[preset],
      preset,
      temporalStability: 0.8
    }
    expect(parseVideoClayConfig(serializeVideoClayConfig(config))).toEqual(config)
  })
})
