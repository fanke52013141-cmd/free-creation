import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIVE_NODE_TYPE_IDS, LEGACY_NODE_TYPE_IDS } from '../src/shared/types'

const DOC = readFileSync(resolve(__dirname, '../docs/NODE_UI_STANDARD.md'), 'utf8')

function parseSection9NodeIds(markdown: string): string[] {
  const start = markdown.indexOf('## 9. 逐节点呈现表')
  expect(start).toBeGreaterThan(0)
  const rest = markdown.slice(start)
  const nextHeading = rest.indexOf('\n## ', 6)
  const section = nextHeading > 0 ? rest.slice(0, nextHeading) : rest
  const ids: string[] = []
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const firstCell = line.split('|')[1]?.trim() ?? ''
    const match = /`([a-z][a-z0-9-]*)`/.exec(firstCell)
    if (match) ids.push(match[1])
  }
  return ids
}

describe('NODE_UI_STANDARD §9 逐节点呈现表完整性门禁', () => {
  it('§9 主表精确覆盖全部 ACTIVE_NODE_TYPE_IDS，无遗漏、无重复、不混入退役节点', () => {
    const documented = parseSection9NodeIds(DOC)
    expect(documented).toHaveLength(ACTIVE_NODE_TYPE_IDS.length)
    expect(new Set(documented).size).toBe(documented.length)
    expect([...documented].sort()).toEqual([...ACTIVE_NODE_TYPE_IDS].sort())
    for (const legacy of LEGACY_NODE_TYPE_IDS) {
      expect(documented, `退役节点 ${legacy} 不得混入 §9 活跃节点主表`).not.toContain(legacy)
    }
    // 内部节点 composite 在 §9 说明段单独登记
    expect(DOC).toContain('内部组合节点 `composite`')
  })
})
