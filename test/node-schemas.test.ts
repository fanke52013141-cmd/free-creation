// Schema 仓库测试（路线图 R2 / 契约规范 P1）
//
// 覆盖 node-schemas.ts 的三个纯函数：注册判断、结构校验、连线兼容。
// 这是契约规范的基石——错误结构必须在这里被拦下，不能悄悄进入下游。
import { describe, it, expect } from 'vitest'
import {
  nodeSchemaRegistered,
  validateNodeSchema,
  nodeSchemasCompatible
} from '@shared/node-schemas'

describe('nodeSchemaRegistered', () => {
  it('识别已注册的基础与导演台 Schema', () => {
    expect(nodeSchemaRegistered({ id: 'json.any', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'storyboard.shots', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'list.items', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'character.profile', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'scene.definition', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'shot.definition', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'prompt.bundle', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'previs.camera', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'previs.project', version: 1 })).toBe(true)
    expect(nodeSchemaRegistered({ id: 'previs.project', version: 2 })).toBe(true)
  })

  it('拒绝未注册的 Schema ID 或错误版本', () => {
    expect(nodeSchemaRegistered({ id: 'json.any', version: 2 })).toBe(false)
    expect(nodeSchemaRegistered({ id: 'storyboard.shots', version: 2 })).toBe(false)
    expect(nodeSchemaRegistered({ id: 'list.items', version: 2 })).toBe(false)
    expect(nodeSchemaRegistered({ id: 'unknown.schema', version: 1 })).toBe(false)
    expect(nodeSchemaRegistered({ id: 'character.profile', version: 2 })).toBe(false)
  })
})

describe('validateNodeSchema · P2 创作结构', () => {
  it('接受角色、场景、镜头与提示词包的最小合法结构', () => {
    expect(
      validateNodeSchema(
        { id: 'character.profile', version: 1 },
        { id: 'c1', name: '主角', description: '寻找真相的人' }
      ).ok
    ).toBe(true)
    expect(
      validateNodeSchema(
        { id: 'scene.definition', version: 1 },
        { id: 's1', name: '雨巷', description: '雨夜的霓虹街道' }
      ).ok
    ).toBe(true)
    expect(
      validateNodeSchema({ id: 'shot.definition', version: 1 }, { id: 'shot-1', scene: '人物回头' })
        .ok
    ).toBe(true)
    expect(
      validateNodeSchema({ id: 'prompt.bundle', version: 1 }, { prompt: '电影感雨夜' }).ok
    ).toBe(true)
  })

  it('给出字段级错误，不让不完整的结构流入下游', () => {
    const character = validateNodeSchema(
      { id: 'character.profile', version: 1 },
      { id: 'c1', name: '', tags: ['合法', 2] }
    )
    expect(character.ok).toBe(false)
    expect(character.errors).toContain('name 必须是非空字符串')
    expect(character.errors).toContain('description 必须是非空字符串')
    expect(character.errors).toContain('tags 必须是字符串数组')

    const prompt = validateNodeSchema(
      { id: 'prompt.bundle', version: 1 },
      { prompt: 'x', seed: '42' }
    )
    expect(prompt.ok).toBe(false)
    expect(prompt.errors).toContain('seed 必须是有限数字')
  })
})

describe('validateNodeSchema · 导演台 Schema', () => {
  const camera = {
    x: 0,
    y: 1.6,
    z: 5,
    heading: 0,
    pitch: 0,
    focalLengthMm: 35,
    aspectRatio: '16:9',
    durationSec: 5,
    fps: 25
  }

  it('接受完整的预演摄像机参数', () => {
    expect(validateNodeSchema({ id: 'previs.camera', version: 1 }, camera).ok).toBe(true)
  })

  it('拒绝缺少焦距或非法画幅的摄像机参数', () => {
    expect(
      validateNodeSchema({ id: 'previs.camera', version: 1 }, { ...camera, focalLengthMm: '35' }).ok
    ).toBe(false)
    expect(
      validateNodeSchema({ id: 'previs.camera', version: 1 }, { ...camera, aspectRatio: '1:1' }).ok
    ).toBe(false)
  })

  it('接受带镜头和摄像机的轻量导演工程摘要', () => {
    expect(
      validateNodeSchema(
        { id: 'previs.project', version: 1 },
        { version: 1, shots: [{ id: 'shot-1', name: '镜头 01', camera }] }
      ).ok
    ).toBe(true)
  })

  it('v2 工程必须携带空间和序列骨架', () => {
    expect(
      validateNodeSchema(
        { id: 'previs.project', version: 2 },
        { version: 2, shots: [{ id: 'shot-1', name: '镜头 01', camera }], space: {}, sequence: {} }
      ).ok
    ).toBe(true)
    expect(
      validateNodeSchema(
        { id: 'previs.project', version: 2 },
        { version: 2, shots: [{ id: 'shot-1', name: '镜头 01', camera }] }
      ).ok
    ).toBe(false)
  })
})

describe('validateNodeSchema · json.any@1', () => {
  it('接受任意可 JSON 序列化的值', () => {
    expect(validateNodeSchema({ id: 'json.any', version: 1 }, {}).ok).toBe(true)
    expect(validateNodeSchema({ id: 'json.any', version: 1 }, [1, 2, 3]).ok).toBe(true)
    expect(validateNodeSchema({ id: 'json.any', version: 1 }, '字符串').ok).toBe(true)
    expect(validateNodeSchema({ id: 'json.any', version: 1 }, 42).ok).toBe(true)
    expect(validateNodeSchema({ id: 'json.any', version: 1 }, null).ok).toBe(true)
  })

  it('拒绝 undefined 和不可序列化的值', () => {
    expect(validateNodeSchema({ id: 'json.any', version: 1 }, undefined).ok).toBe(false)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(validateNodeSchema({ id: 'json.any', version: 1 }, circular).ok).toBe(false)
  })
})

describe('validateNodeSchema · storyboard.shots@1', () => {
  it('接受合法的分镜对象', () => {
    const ok = validateNodeSchema(
      { id: 'storyboard.shots', version: 1 },
      {
        shots: [{ id: 's1', scene: '街道', dialogue: '你好', duration: '3s' }]
      }
    )
    expect(ok.ok).toBe(true)
    expect(ok.errors).toHaveLength(0)
  })

  it('拒绝根值不是对象的结构', () => {
    const r1 = validateNodeSchema({ id: 'storyboard.shots', version: 1 }, null)
    expect(r1.ok).toBe(false)
    expect(r1.errors.some((e) => e.includes('根值'))).toBe(true)

    const r2 = validateNodeSchema({ id: 'storyboard.shots', version: 1 }, [])
    expect(r2.ok).toBe(false)
  })

  it('拒绝 shots 不是数组的结构', () => {
    const r = validateNodeSchema({ id: 'storyboard.shots', version: 1 }, { shots: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('shots 必须是数组'))).toBe(true)
  })

  it('拒绝镜头字段类型错误（错误分镜结构进不了分镜节点）', () => {
    const r = validateNodeSchema(
      { id: 'storyboard.shots', version: 1 },
      { shots: [{ id: 123, scene: '街道' }] }
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('id') && e.includes('字符串'))).toBe(true)
  })

  it('允许镜头缺字段（字段可选，只校验存在的字段类型）', () => {
    const r = validateNodeSchema(
      { id: 'storyboard.shots', version: 1 },
      { shots: [{ scene: '街道' }] }
    )
    expect(r.ok).toBe(true)
  })
})

describe('nodeSchemasCompatible · 连线阶段兼容规则', () => {
  it('任一端为 json.any 即视为兼容（运行时再按目标 Schema 校验）', () => {
    const anySchema = { id: 'json.any', version: 1 }
    const shotSchema = { id: 'storyboard.shots', version: 1 }
    expect(nodeSchemasCompatible(anySchema, shotSchema)).toBe(true)
    expect(nodeSchemasCompatible(shotSchema, anySchema)).toBe(true)
    expect(nodeSchemasCompatible(anySchema, anySchema)).toBe(true)
  })

  it('具体业务 Schema 必须完全相同的 ID 与版本', () => {
    const shotV1 = { id: 'storyboard.shots', version: 1 }
    expect(nodeSchemasCompatible(shotV1, shotV1)).toBe(true)
    expect(nodeSchemasCompatible(shotV1, { id: 'storyboard.shots', version: 2 })).toBe(false)
    expect(nodeSchemasCompatible(shotV1, { id: 'other.schema', version: 1 })).toBe(false)
  })

  it('缺少任一 Schema 返回不兼容', () => {
    expect(nodeSchemasCompatible(undefined, { id: 'json.any', version: 1 })).toBe(false)
    expect(nodeSchemasCompatible({ id: 'json.any', version: 1 }, undefined)).toBe(false)
    expect(nodeSchemasCompatible(undefined, undefined)).toBe(false)
  })
})

describe('validateNodeSchema · list.items@1', () => {
  const listSchema = { id: 'list.items', version: 1 }

  it('接受元素全为对象的数组', () => {
    expect(
      validateNodeSchema(listSchema, [
        { id: 's1', shot: 'a' },
        { id: 's2', shot: 'b' }
      ]).ok
    ).toBe(true)
    expect(validateNodeSchema(listSchema, []).ok).toBe(true)
  })

  it('拒绝根值不是数组', () => {
    expect(validateNodeSchema(listSchema, { shots: [] }).ok).toBe(false)
    expect(validateNodeSchema(listSchema, 'not-array').ok).toBe(false)
  })

  it('拒绝元素不是对象（含 null / 原始值）', () => {
    expect(validateNodeSchema(listSchema, [1, 2]).ok).toBe(false)
    expect(validateNodeSchema(listSchema, [{ a: 1 }, null]).ok).toBe(false)
    expect(validateNodeSchema(listSchema, ['x']).ok).toBe(false)
  })
})
