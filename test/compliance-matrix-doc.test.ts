// NODE_COMPLIANCE_MATRIX.md 是发布前的协议索引；AGENTS.md 要求改节点必须同步它。
// 这条测试把「表里写出的端口 ID、类型、基数和 Schema」变成可执行检查，防止文档单方面漂移。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getNodeType, allNodeTypes } from '@renderer/nodes/registry'
import {
  ACTIVE_NODE_TYPE_IDS,
  INTERNAL_NODE_TYPE_IDS,
  LEGACY_NODE_TYPE_IDS
} from '@shared/types'
import { registerAllNodeTypes } from './helpers/registerNodes'

// 表格要在 describe 阶段就能解析，所以节点类型在模块加载时注册，而不是 beforeAll。
registerAllNodeTypes()

const DOC = readFileSync(path.resolve(process.cwd(), 'docs/NODE_COMPLIANCE_MATRIX.md'), 'utf8')

/** 从一行 Markdown 表格里取出 [类型, 契约版本, 输入单元格, 输出单元格, 结论]；不是节点行返回 null。 */
function parseRow(
  line: string
): { type: string; version: string; inCell: string; outCell: string; verdict: string } | null {
  if (!line.startsWith('|')) return null
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
  if (cells.length < 5) return null
  const type = /`([a-z][a-z-]*)`/.exec(cells[0])?.[1]
  if (!type || !getNodeType(type as never)) return null
  return {
    type,
    version: cells[1],
    inCell: cells[2],
    outCell: cells[3],
    // 主表 6 列，最后一列是结论；不足 6 列的结构按无结论处理，由断言报错暴露。
    verdict: cells.length >= 6 ? cells[cells.length - 1] : ''
  }
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

// 注册表全集 = Active + Internal + Legacy 三份共享清单里实际注册的子集。
// registry 没有导出「含 creatable=false」的全量遍历，派生时以共享清单为唯一事实源。
const allRegisteredSpecs = [
  ...ACTIVE_NODE_TYPE_IDS,
  ...INTERNAL_NODE_TYPE_IDS,
  ...LEGACY_NODE_TYPE_IDS
]
  .map((type) => getNodeType(type as never))
  .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))

/** 「## 历史节点」小节表格第一列里的类型 id（`group`、`compose` 同处一格也能全部取出）。 */
function historyTableTypes(doc: string): string[] {
  const start = doc.indexOf('## 历史节点')
  if (start < 0) return []
  const types = new Set<string>()
  for (const line of doc.slice(start).split('\n')) {
    if (!line.startsWith('|')) continue
    const firstCell = line.split('|')[1] ?? ''
    for (const match of firstCell.matchAll(/`([a-z][a-z-]+)`/g)) types.add(match[1])
  }
  return Array.from(types)
}

const historyTypes = historyTableTypes(DOC)

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

  it('文档声明的「N 个可创建节点」计数与注册表实际数量一致', () => {
    const creatableCount = allNodeTypes().length
    const declared = /(\d+)\s*个可创建节点/.exec(DOC)
    expect(declared, '文档必须以「N 个可创建节点」的形式声明当前计数').not.toBeNull()
    expect(
      Number(declared![1]),
      `文档声明 ${declared![1]} 个可创建节点，注册表实际 ${creatableCount} 个`
    ).toBe(creatableCount)
  })

  it('每个 creatable=false 的注册节点都列入历史节点表，主表结论为退役', () => {
    const retired = allRegisteredSpecs.filter((spec) => spec.creatable === false)
    expect(retired.length, '退役节点派生结果为空：注册表或共享清单结构已变，断言在空转').toBeGreaterThan(0)
    for (const spec of retired) {
      expect(
        historyTypes,
        `${spec.type} creatable=false 却没有列入「历史节点」表`
      ).toContain(spec.type)
      const row = rows.find((item) => item.type === spec.type)
      if (row) {
        expect(row.verdict, `${spec.type} 在主表的结论必须是「退役」`).toBe('退役')
      }
    }
  })

  it('历史节点表列出的类型确实全部不可创建（或已不再注册）', () => {
    expect(historyTypes.length, '「历史节点」表解析为空：文档结构可能被改坏').toBeGreaterThan(0)
    for (const type of historyTypes) {
      const spec = getNodeType(type as never)
      if (!spec) continue // `group`/`compose` 等已不注册的 Retired 类型
      expect(spec.creatable, `历史节点表中的 ${type} 实际仍可创建`).toBe(false)
    }
  })
})
