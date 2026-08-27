// @vitest-environment jsdom
// T3 · 旧项目四段迁移真值表（R0/WP2）
//
// planLegacyMigrations 是纯函数：输入画布 shapes，输出迁移计划（更新/删除/分组指令/警告）。
// 覆盖 image→image-gen 两分支、compose 删除、group→原生分组指令、尺寸规范化，以及迁移幂等。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { planLegacyMigrations } from '@renderer/nodes/migrations/legacy'

beforeAll(() => {
  registerAllNodeTypes()
})

function nodeShape(
  id: string,
  props: Record<string, unknown>
): { id: string; type: 'node-card'; props: Record<string, unknown> } {
  return { id, type: 'node-card', props }
}

describe('迁移 1 · image → image-gen', () => {
  it('有生成配置（text 含 prompt JSON）的旧图片节点迁移为生图', () => {
    const shape = nodeShape('shape:a', {
      nodeType: 'image',
      title: '图片',
      text: JSON.stringify({ prompt: '一只猫', modelKey: 'm1' }),
      mediaPath: '',
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([shape])
    expect(plan.shapeUpdates).toHaveLength(1)
    expect(plan.shapeUpdates[0].props).toEqual({ nodeType: 'image-gen', title: '生图' })
    expect(plan.warnings.join()).toContain('生图')
  })

  it('无媒体且无生成配置的旧图片节点也迁移为生图（避免双重含义）', () => {
    const shape = nodeShape('shape:b', {
      nodeType: 'image',
      title: '图片',
      text: '',
      mediaPath: '',
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([shape])
    expect(plan.shapeUpdates.some((u) => u.id === 'shape:b')).toBe(true)
  })

  it('已导入媒体的纯资产图片节点保持不变', () => {
    const shape = nodeShape('shape:c', {
      nodeType: 'image',
      title: '图片',
      text: '',
      mediaPath: 'media/xxx.png',
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([shape])
    expect(plan.shapeUpdates.some((u) => u.id === 'shape:c')).toBe(false)
  })
})

describe('迁移 2 · compose 退役', () => {
  it('旧合成节点直接进入删除列表', () => {
    const shape = nodeShape('shape:d', {
      nodeType: 'compose',
      title: '合成',
      text: '',
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([shape])
    expect(plan.deletions).toContain('shape:d')
  })
})

describe('迁移 3 · group 退役 → 原生分组指令', () => {
  it('成员 ≥2 的旧分组输出分组指令并删除卡片', () => {
    const members = [
      nodeShape('shape:m1', { nodeType: 'text', title: 't1', text: '', w: 340, h: 260 }),
      nodeShape('shape:m2', { nodeType: 'text', title: 't2', text: '', w: 340, h: 260 })
    ]
    const group = nodeShape('shape:g', {
      nodeType: 'group',
      title: '分组',
      text: JSON.stringify({ memberIds: ['shape:m1', 'shape:m2'] }),
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([...members, group])
    expect(plan.groupOps).toEqual([{ memberIds: ['shape:m1', 'shape:m2'] }])
    expect(plan.deletions).toContain('shape:g')
    expect(plan.warnings.join()).toContain('分组')
  })

  it('成员不足或引用失效的旧分组仍删除卡片但不产出分组指令', () => {
    const group = nodeShape('shape:g2', {
      nodeType: 'group',
      title: '分组',
      text: JSON.stringify({ memberIds: ['shape:gone'] }),
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([group])
    expect(plan.groupOps).toHaveLength(0)
    expect(plan.deletions).toContain('shape:g2')
  })

  it('损坏的分组 JSON 不阻断（仍删除卡片）', () => {
    const group = nodeShape('shape:g3', {
      nodeType: 'group',
      title: '分组',
      text: '{broken json',
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([group])
    expect(plan.deletions).toContain('shape:g3')
    expect(plan.groupOps).toHaveLength(0)
  })
})

describe('迁移 4 · 尺寸规范化', () => {
  it('历史默认尺寸节点更新为 spec.defaultSize', () => {
    const shape = nodeShape('shape:s', {
      nodeType: 'text',
      title: '文本',
      text: '',
      w: 2520,
      h: 340
    })
    const plan = planLegacyMigrations([shape])
    const update = plan.shapeUpdates.find((u) => u.id === 'shape:s')
    expect(update?.props).toEqual({ w: 340, h: 260 })
  })

  it('类型迁移后按新类型（image-gen）的 spec 检查尺寸', () => {
    // 340x240 是 image-gen 的历史尺寸，若按旧 image 类型判断则 340x240 也是历史尺寸；
    // 关键断点：迁移后节点不应再出现在尺寸更新里出现错误目标
    const shape = nodeShape('shape:t', {
      nodeType: 'image',
      title: '图片',
      text: JSON.stringify({ prompt: 'x' }),
      mediaPath: '',
      w: 2880,
      h: 480
    })
    const plan = planLegacyMigrations([shape])
    const typeUpdate = plan.shapeUpdates.find((u) => u.id === 'shape:t')
    expect(typeUpdate?.props).toEqual({ nodeType: 'image-gen', title: '生图' })
    // 同一 shape 的尺寸更新合并存在（独立条目）
    const sizeUpdate = plan.shapeUpdates.filter(
      (u) => u.id === 'shape:t' && u.props.w !== undefined
    )
    expect(sizeUpdate).toHaveLength(1)
    expect(sizeUpdate[0].props).toEqual({ w: 340, h: 260 })
  })

  it('用户手动调整的尺寸不迁移', () => {
    const shape = nodeShape('shape:u', {
      nodeType: 'text',
      title: '文本',
      text: '',
      w: 500,
      h: 400
    })
    const plan = planLegacyMigrations([shape])
    expect(plan.shapeUpdates.some((u) => u.id === 'shape:u')).toBe(false)
  })
})

describe('迁移幂等（二次运行不再变更）', () => {
  it('已迁移状态产出空计划', () => {
    const settled = [
      nodeShape('shape:v1', {
        nodeType: 'image-gen',
        title: '生图',
        text: '',
        mediaPath: 'media/a.png',
        w: 340,
        h: 260
      }),
      nodeShape('shape:v2', { nodeType: 'text', title: '文本', text: 'hello', w: 340, h: 260 })
    ]
    const plan = planLegacyMigrations(settled)
    expect(plan.shapeUpdates).toHaveLength(0)
    expect(plan.deletions).toHaveLength(0)
    expect(plan.groupOps).toHaveLength(0)
    expect(plan.warnings).toHaveLength(0)
  })
})

describe('未知 nodeType · 不在迁移职责内（保留原样）', () => {
  it('未知类型节点不产生更新/删除/警告（由冻结占位与预检负责）', () => {
    const shape = nodeShape('shape:w', {
      nodeType: 'future-node',
      title: '未来',
      text: '',
      w: 340,
      h: 260
    })
    const plan = planLegacyMigrations([shape])
    expect(plan.shapeUpdates.some((u) => u.id === 'shape:w')).toBe(false)
    expect(plan.deletions).toHaveLength(0)
  })
})
