// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_ACCENTS, allNodeTypes, getNodeType } from '../src/renderer/src/nodes/registry'
import type { NodeTypeId } from '../src/shared/types'
import {
  PALETTE_CATEGORY_META,
  PALETTE_NODE_GROUPS
} from '../src/renderer/src/canvas/palette-categories'
import {
  registerBaseNodeTypes,
  registerExtendedNodeTypes,
  registerScriptNodeType
} from '../src/renderer/src/nodes/specs'

const standard = readFileSync(resolve(__dirname, '../docs/NODE_COLOR_SPEC.md'), 'utf8')

describe('节点颜色规范', () => {
  it('所有节点身份色均与规范文件中登记的颜色一致，包括历史 ID', () => {
    for (const [id, color] of Object.entries(NODE_ACCENTS)) {
      const row = standard
        .split('\n')
        .find((line) => line.startsWith(`| ${id} |`) && line.split('|').length === 6)
      expect(row, id).toContain(`\`${color}\``)
    }
    registerBaseNodeTypes()
    registerExtendedNodeTypes()
    registerScriptNodeType()
    for (const id of Object.keys(NODE_ACCENTS) as NodeTypeId[]) {
      const spec = getNodeType(id)
      if (spec) expect(spec.color, spec.type).toBe(NODE_ACCENTS[spec.type])
    }
  })

  it('五大分类使用规范主色，每个可创建节点都有唯一展示分类', () => {
    for (const [category, meta] of Object.entries(PALETTE_CATEGORY_META)) {
      const row = standard.split('\n').find((line) => line.startsWith(`| ${category} |`))
      expect(row, category).toContain(`\`${meta.color}\``)
    }
    registerBaseNodeTypes()
    registerExtendedNodeTypes()
    const groups = Object.values(PALETTE_NODE_GROUPS).flat()
    for (const spec of allNodeTypes()) {
      expect(
        groups.filter((id) => id === spec.type),
        spec.type
      ).toHaveLength(1)
    }
  })
})
