import { describe, expect, it } from 'vitest'
import {
  legacyCategory,
  parseCategory,
  planResourceNodes,
  validateCategoryContent,
  type LibraryCategory
} from '../src/shared/library/blueprint'
import type { LibraryResourceComponent } from '../src/shared/library/types'

const category: LibraryCategory = {
  id: 'brand',
  version: 1,
  name: '品牌角色卡',
  description: '',
  presentation: 'profile',
  blueprint: {
    protocolVersion: 1,
    layout: 'grid',
    slots: [
      {
        id: 'portrait',
        label: '形象',
        nodeType: 'image',
        contractVersion: 3,
        required: true,
        multiple: true,
        titleTemplate: '{resource} · {slot} {index}'
      },
      {
        id: 'bio',
        label: '描述',
        nodeType: 'text',
        contractVersion: 3,
        required: false,
        multiple: false,
        titleTemplate: '{resource} · {slot}'
      },
      {
        id: 'voice',
        label: '声音',
        nodeType: 'audio',
        contractVersion: 3,
        required: false,
        multiple: false,
        titleTemplate: '{resource} · {slot}'
      }
    ]
  }
}
const components: LibraryResourceComponent[] = [
  {
    id: 'front',
    role: '正面',
    valueType: 'image',
    metadata: { librarySlotId: 'portrait' },
    order: 0
  },
  {
    id: 'side',
    role: '侧面',
    valueType: 'image',
    metadata: { librarySlotId: 'portrait' },
    order: 1
  },
  {
    id: 'description',
    role: '简介',
    valueType: 'text',
    text: '修长的红眼树蛙',
    metadata: { librarySlotId: 'bio' },
    order: 2
  },
  {
    id: 'sound',
    role: '声音样本',
    valueType: 'audio',
    metadata: { librarySlotId: 'voice' },
    order: 3
  }
]

describe('resource node blueprints', () => {
  it('expands a custom category to ordered real nodes, preserving content and source slots', () => {
    expect(parseCategory(category).name).toBe('品牌角色卡')
    const plan = planResourceNodes(
      category,
      components,
      '林青',
      components.map((item) => item.id)
    )
    expect(plan.map((node) => node.nodeType)).toEqual(['image', 'image', 'text', 'audio'])
    expect(plan.map((node) => node.title)).toEqual([
      '林青 · 形象 1',
      '林青 · 形象 2',
      '林青 · 描述',
      '林青 · 声音'
    ])
    expect(plan[2]).toMatchObject({
      text: '修长的红眼树蛙',
      componentId: 'description',
      slotId: 'bio'
    })
    expect(planResourceNodes(category, components, '林青', ['side'])[0].title).toBe('林青 · 形象 2')
    expect(planResourceNodes(category, components, '林青', ['sound'])).toHaveLength(1)
  })
  it('rejects duplicate slots, unsupported contracts, invalid cover and unknown properties', () => {
    expect(() =>
      parseCategory({
        ...category,
        blueprint: {
          ...category.blueprint,
          slots: [category.blueprint.slots[0], category.blueprint.slots[0]]
        }
      })
    ).toThrow('重复')
    expect(() => parseCategory({ ...category, coverSlotId: 'voice' })).toThrow('封面')
    expect(() => parseCategory({ ...category, script: 'execute' })).toThrow()
    expect(() =>
      parseCategory({
        ...category,
        blueprint: {
          ...category.blueprint,
          slots: [{ ...category.blueprint.slots[0], contractVersion: 99 }]
        }
      })
    ).toThrow('不兼容')
  })
  it('rejects missing required content, incompatible mapping and single-slot overflow', () => {
    expect(() => validateCategoryContent(category, components.slice(2))).toThrow('形象')
    expect(() => validateCategoryContent(category, [{ ...components[0], metadata: {} }])).toThrow(
      '未映射'
    )
    expect(() =>
      validateCategoryContent(category, [{ ...components[0], valueType: 'audio' }])
    ).toThrow('不兼容')
    expect(() => validateCategoryContent(category, [...components, components[2]])).toThrow(
      '只允许一个'
    )
    expect(() => planResourceNodes(category, components, '林青', ['missing'])).toThrow('已变化')
  })
  it('fills recipe variables without changing saved content and validates JSON', () => {
    const items = components.map((item) =>
      item.id === 'description'
        ? { ...item, valueType: 'recipe' as const, text: '{{subject}}，胶片质感' }
        : item
    )
    expect(() => planResourceNodes(category, items, '胶片', ['description'])).toThrow('subject')
    expect(
      planResourceNodes(category, items, '胶片', ['description'], {
        description: { subject: '青蛙' }
      })[0].text
    ).toBe('青蛙，胶片质感')
    expect(items[2].text).toBe('{{subject}}，胶片质感')
    const json = { ...components[2], valueType: 'json' as const, text: '{bad}' }
    expect(() =>
      planResourceNodes(legacyCategory('custom', [json]), [json], '数据', [json.id])
    ).toThrow('JSON')
  })
  it('maps old mixed resources without dropping components or assigning a new business category', () => {
    const old = components.map((item) => ({ ...item, metadata: {} }))
    const plan = planResourceNodes(
      legacyCategory('character', old),
      old,
      '旧人物',
      old.map((item) => item.id)
    )
    expect(plan.map((node) => node.componentId)).toEqual(old.map((item) => item.id))
    expect(plan.map((node) => node.nodeType)).toEqual(['image', 'image', 'text', 'audio'])
  })
})
