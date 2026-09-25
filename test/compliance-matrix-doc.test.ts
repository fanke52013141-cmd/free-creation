// NODE_COMPLIANCE_MATRIX.md 是发布前的协议索引；AGENTS.md 要求改节点必须同步它。
// 这条测试把「表里写出的端口 ID、类型、基数和 Schema」变成可执行检查，防止文档单方面漂移。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getNodeType, allNodeTypes } from '@renderer/nodes/registry'
import { registerAllNodeTypes } from './helpers/registerNodes'

// 表格要在 describe 阶段就能解析，所以节点类型在模块加载时注册，而不是 beforeAll。
registerAllNodeTypes()

const DOC = readFileSync(path.resolve(process.cwd(), 'docs/NODE_COMPLIANCE_MATRIX.md'), 'utf8')

/** 从一行 Markdown 表格里取出 [类型, 契约版本, 输入单元格, 输出单元格]；不是节点行返回 null。 */
function parseRow(
  line: string
): { type: string; version: string; inCell: string; outCell: string } | null {
  if (!line.startsWith('|')) return null
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
  if (cells.length < 5) return null
  const type = /`([a-z][a-z-]*)`/.exec(cells[0])?.[1]
  if (!type || !getNodeType(type as never)) return null
  return { type, version: cells[1], inCell: cells[2], outCell: cells[3] }
}

const portIds = (cell: string): string[] =>
  Array.from(new Set(Array.from(cell.matchAll(/\b(?:in|out)-[a-z-]+\b/g), (m) => m[0])))

function explicitPortContracts(
  cell: string,
  dir: 'in' | 'out'
): Array<{
  id: string
  type: string
  schema?: string
  cardinality?: 'one' | 'many'
}> {
  const result: Array<{
    id: string
    type: string
    schema?: string
    cardinality?: 'one' | 'many'
  }> = []
  const pattern =
    /`(in|out)-([a-z0-9-]+)`\s+(text|markdown|json|iteration|camera|image|video|audio|file|any)(?:\s+`([^`]+)`)?(?:\s*\/\s*(one|many))?/g
  for (const match of cell.matchAll(pattern)) {
    if (match[1] !== dir) continue
    result.push({
      id: `${match[1]}-${match[2]}`,
      type: match[3],
      ...(match[4] ? { schema: match[4] } : {}),
      ...(match[5] === 'one' || match[5] === 'many' ? { cardinality: match[5] } : {})
    })
  }
  return result
}

const rows = DOC.split('\n')
  .map(parseRow)
  .filter((r): r is NonNullable<typeof r> => Boolean(r))

describe('NODE_COMPLIANCE_MATRIX · 文档端口与注册契约一致', () => {
  it('至少解析出 15 个节点行（解析本身失效也要被发现）', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15)
  })

  for (const row of rows) {
    it(`${row.type}：文档写出的端口 id 与注册契约对得上`, () => {
      const spec = getNodeType(row.type as never)!
      expect(Number(row.version), `文档「版本」列写着 ${row.version}`).toBe(spec.contractVersion)
      const declared = { in: portIds(row.inCell), out: portIds(row.outCell) }
      const actual = {
        in: spec.ports.in.map((p) => p.id),
        out: spec.ports.out.map((p) => p.id)
      }
      // 文档允许用散文描述（例如「动态输出端口」）：没写出 id 的那一侧不比对。
      expect(
        declared.in.length ? declared.in.slice().sort() : actual.in.slice().sort(),
        `文档输入列：${row.inCell}`
      ).toEqual(actual.in.slice().sort())
      expect(
        declared.out.length ? declared.out.slice().sort() : actual.out.slice().sort(),
        `文档输出列：${row.outCell}`
      ).toEqual(actual.out.slice().sort())

      for (const dir of ['in', 'out'] as const) {
        const actualPorts = dir === 'in' ? spec.ports.in : spec.ports.out
        for (const documented of explicitPortContracts(
          dir === 'in' ? row.inCell : row.outCell,
          dir
        )) {
          const port = actualPorts.find((item) => item.id === documented.id)
          expect(port?.type, `${documented.id} 的类型`).toBe(documented.type)
          if (documented.cardinality) {
            expect(port?.cardinality, `${documented.id} 的基数`).toBe(documented.cardinality)
          }
          if (documented.schema) {
            expect(
              port?.schema && `${port.schema.id}@${port.schema.version}`,
              `${documented.id} 的 Schema`
            ).toBe(documented.schema)
          }
        }
      }
    })
  }

  it('每个可创建节点在表里都有一行', () => {
    const documented = new Set(rows.map((r) => r.type))
    const creatable = allNodeTypes()
      .filter((spec) => spec.creatable !== false)
      .map((spec) => spec.type)
    expect(creatable.filter((t) => !documented.has(t))).toEqual([])
  })
})
