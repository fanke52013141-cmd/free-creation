// 执行器共享工具测试（路线图 R2 / 契约规范 P3）
//
// 覆盖 executors/shared.ts 的纯解析与归一化函数。这些函数被多个执行器复用，
// 它们的健壮性直接决定分镜、视频、音频等节点的输入解析稳定性。
import { describe, it, expect } from 'vitest'
import {
  parseJsonObj,
  normalizeShot,
  extractShots,
  mergedPrompt,
  promptBundleText,
  parseVideoGen
} from '@renderer/engine/executors/shared'
import { parseImageGen } from '@renderer/engine/executors/imageGen'

describe('parseJsonObj', () => {
  it('解析合法对象', () => {
    expect(parseJsonObj('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObj('{"prompt":"hi"}')).toEqual({ prompt: 'hi' })
  })

  it('数组返回 null（只接受对象）', () => {
    expect(parseJsonObj('[1,2,3]')).toBeNull()
  })

  it('原始值返回 null', () => {
    expect(parseJsonObj('"string"')).toBeNull()
    expect(parseJsonObj('42')).toBeNull()
    expect(parseJsonObj('true')).toBeNull()
  })

  it('解析失败或空串返回 null', () => {
    expect(parseJsonObj('')).toBeNull()
    expect(parseJsonObj('{invalid')).toBeNull()
    expect(parseJsonObj('not json')).toBeNull()
  })
})

describe('normalizeShot · 分镜归一化', () => {
  it('为缺字段的镜头补稳定结构', () => {
    const s = normalizeShot({ scene: '街道' })
    expect(s.scene).toBe('街道')
    expect(s.dialogue).toBe('')
    expect(s.duration).toBe('')
    expect(typeof s.id).toBe('string')
    expect(s.id.length).toBeGreaterThan(0)
  })

  it('保留已有字段（含额外字段）', () => {
    const s = normalizeShot({ id: 'x1', scene: '夜', sound: '雨声', camera: '特写' })
    expect(s.id).toBe('x1')
    expect(s.sound).toBe('雨声')
    expect(s.camera).toBe('特写')
  })

  it('非对象输入也能产出带 id 的空镜头', () => {
    const s = normalizeShot(null)
    expect(s.scene).toBe('')
    expect(typeof s.id).toBe('string')
  })
})

describe('extractShots · 从模型返回文本中提取分镜', () => {
  it('解析纯 JSON 数组', () => {
    const shots = extractShots('[{"scene":"a"},{"scene":"b"}]')
    expect(shots).toHaveLength(2)
    expect(shots?.[0].scene).toBe('a')
  })

  it('从含前后说明文字的片段中提取数组', () => {
    const raw = '好的，分镜如下：\n[{"scene":"夜"},{"scene":"晨"}]\n以上。'
    const shots = extractShots(raw)
    expect(shots).toHaveLength(2)
    expect(shots?.[1].scene).toBe('晨')
  })

  it('无法解析时返回 null（不把普通文本伪装成 JSON）', () => {
    expect(extractShots('这只是一段文字')).toBeNull()
    expect(extractShots('')).toBeNull()
    expect(extractShots('{not array}')).toBeNull()
  })
})

describe('mergedPrompt · 提示词合并（防累积）', () => {
  it('上游为空时保留节点自身文本', () => {
    expect(mergedPrompt('我的提示词', '')).toBe('我的提示词')
    expect(mergedPrompt('我的提示词', '   ')).toBe('我的提示词')
  })

  it('节点文本为空时使用上游', () => {
    expect(mergedPrompt('', '上游')).toBe('上游')
  })

  it('上游与节点文本用分隔符合并', () => {
    expect(mergedPrompt('节点', '上游')).toBe('上游\n\n---\n\n节点')
  })

  it('重复运行不重复累积（幂等）', () => {
    const once = mergedPrompt('节点', '上游')
    const twice = mergedPrompt(once, '上游')
    expect(twice).toBe(once)
  })
})

describe('promptBundleText · 结构化提示词包', () => {
  it('只提取可被当前图片/视频驱动使用的正向提示词与风格', () => {
    expect(
      promptBundleText({ prompt: '雨夜街头', style: '35mm 胶片', negativePrompt: '模糊' })
    ).toBe('雨夜街头\n35mm 胶片')
  })

  it('非对象或无有效字符串时安全返回空', () => {
    expect(promptBundleText(null)).toBe('')
    expect(promptBundleText(['提示词'])).toBe('')
    expect(promptBundleText({ prompt: 1, style: '' })).toBe('')
  })
})

describe('parseVideoGen · 视频生成配置解析', () => {
  it('解析合法 JSON 配置', () => {
    const d = parseVideoGen(
      JSON.stringify({
        prompt: '奔跑的猫',
        modelKey: 'p1::m1',
        params: {
          ratio: '16:9',
          duration: 5,
          resolution: '1080p',
          generateAudio: true,
          seed: 42,
          watermark: false
        },
        taskId: 't1'
      })
    )
    expect(d.prompt).toBe('奔跑的猫')
    expect(d.modelKey).toBe('p1::m1')
    expect(d.params.ratio).toBe('16:9')
    expect(d.params.duration).toBe(5)
    expect(d.params.resolution).toBe('1080p')
    expect(d.params.generateAudio).toBe(true)
    expect(d.params.seed).toBe(42)
    expect(d.params.watermark).toBe(false)
    expect(d.taskId).toBe('t1')
  })

  it('非 JSON 文本回退为纯 prompt，其余字段为默认', () => {
    const d = parseVideoGen('只是提示词')
    expect(d.prompt).toBe('只是提示词')
    expect(d.modelKey).toBe('')
    expect(d.taskId).toBe('')
    expect(d.params).toEqual({})
  })

  it('params 字段类型不匹配时安全降级为 undefined', () => {
    const d = parseVideoGen(
      JSON.stringify({ prompt: 'x', params: { ratio: 123, duration: 'bad' } })
    )
    expect(d.params.ratio).toBeUndefined()
    expect(d.params.duration).toBeUndefined()
  })
})

describe('parseImageGen · 生图配置解析（R5 种子）', () => {
  it('解析带 seed 的配置', () => {
    const d = parseImageGen(
      JSON.stringify({ prompt: '猫', modelKey: 'p1::m1', size: '1024x1024', seed: 42 })
    )
    expect(d.prompt).toBe('猫')
    expect(d.modelKey).toBe('p1::m1')
    expect(d.size).toBe('1024x1024')
    expect(d.aspectRatio).toBe('1:1')
    expect(d.seed).toBe(42)
  })

  it('无 seed 时安全降级为 undefined', () => {
    const d = parseImageGen(JSON.stringify({ prompt: 'x', modelKey: '', size: 'auto' }))
    expect(d.seed).toBeUndefined()
  })

  it('非 JSON 文本回退为纯 prompt', () => {
    const d = parseImageGen('只是提示词')
    expect(d.prompt).toBe('只是提示词')
    expect(d.seed).toBeUndefined()
  })
})
