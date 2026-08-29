// 旧快照迁移与默认值测试（路线图 R2 / 契约规范 §9 P6）
//
// 覆盖两类回归保护：
// 1. needsNodeSizeMigration 历史尺寸识别——旧项目打开时节点尺寸自动规范化的依据；
// 2. 各节点 defaultSize 不被悄悄改动（统一 340×260 规范的稳定性）。
// 这些是「旧项目可以打开、保存并再次打开」这条完成标准的纯函数保障。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { needsNodeSizeMigration, getNodeType, allNodeTypes } from '@renderer/nodes/registry'
import type { NodeTypeId } from '@shared/types'

beforeAll(() => {
  registerAllNodeTypes()
})

describe('needsNodeSizeMigration · 历史尺寸真值表', () => {
  // 历史上发布过的默认尺寸（误把画布坐标当缩略图、规范化前、统一前）
  const legacyCases: Array<[string, number, number]> = [
    // 误把画布坐标当缩略图（超大）
    ['text', 520, 300],
    ['image', 2880, 480],
    ['image-gen', 340, 240],
    ['video', 2880, 480],
    ['audio', 2520, 240],
    ['chat', 2520, 340],
    ['script', 3240, 640],
    ['processor', 2520, 260],
    ['json', 2520, 400],
    ['code', 2880, 440],
    ['storyboard', 3420, 640],
    // 规范化前宽度不一致
    ['text', 320, 190],
    ['image', 320, 240],
    ['video', 320, 240],
    ['audio', 320, 180],
    ['chat', 320, 210],
    ['script', 400, 320],
    ['processor', 360, 210],
    ['code', 360, 260],
    ['storyboard', 420, 320],
    // 统一 340×260 规范之前
    ['text', 340, 200],
    ['image', 340, 240],
    ['video', 340, 240],
    ['audio', 340, 190],
    ['chat', 340, 220],
    ['script', 340, 300],
    ['processor', 340, 210],
    ['json', 340, 230],
    ['code', 340, 260],
    ['storyboard', 340, 300]
  ]

  it.each(legacyCases)('历史默认尺寸 %s %dx%d 应触发迁移', (type, w, h) => {
    expect(needsNodeSizeMigration(type, w, h)).toBe(true)
  })

  it('用户手动调整的尺寸不触发迁移', () => {
    expect(needsNodeSizeMigration('text', 500, 400)).toBe(false)
    expect(needsNodeSizeMigration('image', 250, 200)).toBe(false)
    expect(needsNodeSizeMigration('json', 400, 300)).toBe(false)
  })

  it('明显异常的尺寸兜底迁移（宽>900 或 高>700）', () => {
    expect(needsNodeSizeMigration('text', 1200, 260)).toBe(true)
    expect(needsNodeSizeMigration('text', 340, 800)).toBe(true)
  })
})

describe('节点默认尺寸稳定性（统一 340×260 规范）', () => {
  it('所有可创建节点的 defaultSize 保持 340×260', () => {
    for (const spec of allNodeTypes()) {
      expect(spec.defaultSize, `${spec.type} 默认尺寸异常`).toEqual({ w: 340, h: 260 })
    }
  })

  it('script（兼容节点）也保持统一默认尺寸', () => {
    const spec = getNodeType('script')
    expect(spec?.defaultSize).toEqual({ w: 340, h: 260 })
  })
})

describe('契约版本稳定性（防破坏性变化漏升版本）', () => {
  const types: NodeTypeId[] = [
    'text',
    'image',
    'image-crop',
    'image-gen',
    'video',
    'video-frame',
    'video-clip',
    'video-audio',
    'audio',
    'chat',
    'processor',
    'json',
    'structured',
    'code',
    'storyboard',
    'script',
    'ai-process',
    'iterate'
  ]

  it.each(types)('节点 %s 的契约版本与已发布契约一致', (type) => {
    const spec = getNodeType(type)
    expect(spec?.contractVersion).toBe(type === 'code' ? 2 : 1)
  })
})
