// T7 · 项目仓储文件层测试（R0 基线保护，补 ROADMAP R2 遗留项）
//
// projects.repo 的 SQLite 索引由 mock 的 ./db 替换（原生模块按 Electron ABI 编译，
// 无法在 Node 测试进程加载），聚焦文件层不变量：
// - create → open → save → open roundtrip
// - save 原子写：.tmp 不残留、旧版轮转到 .bak
// - graphVersion 每次保存 +1 且 meta 与列表一致
// - 主文件损坏时回退 .bak，不返回 null 也不抛错
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

interface FakeRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  cover_media_id: string | null
  graph_version: number
  deleted: number
}

const h = vi.hoisted(() => ({
  rows: new Map<string, FakeRow>(),
  projectsDir: ''
}))

vi.mock('../src/main/store/db', () => {
  const stmt = (
    sql: string
  ): {
    run: (...args: unknown[]) => { changes: number }
    all: () => FakeRow[]
    get: (id: string) => FakeRow | undefined
  } => ({
    run: (...args: unknown[]) => {
      if (sql.startsWith('INSERT INTO projects')) {
        const [id, name, created, updated] = args as [string, string, number, number]
        h.rows.set(id, {
          id,
          name,
          created_at: created,
          updated_at: updated,
          cover_media_id: null,
          graph_version: 0,
          deleted: 0
        })
        return { changes: 1 }
      }
      if (sql.includes('SET deleted = 1')) {
        const row = h.rows.get(args[0] as string)
        if (!row || row.deleted) return { changes: 0 }
        row.deleted = 1
        return { changes: 1 }
      }
      if (sql.includes('SET updated_at = ?, graph_version = ?')) {
        const [now, version, id] = args as [number, number, string]
        const row = h.rows.get(id)
        if (!row) return { changes: 0 }
        row.updated_at = now
        row.graph_version = version
        return { changes: 1 }
      }
      if (sql.includes('SET name = ?')) {
        const [name, now, id] = args as [string, number, string]
        const row = h.rows.get(id)
        if (!row || row.deleted) return { changes: 0 }
        row.name = name
        row.updated_at = now
        return { changes: 1 }
      }
      return { changes: 0 }
    },
    all: () =>
      [...h.rows.values()].filter((r) => !r.deleted).sort((a, b) => b.updated_at - a.updated_at),
    get: (id: string) => {
      const row = h.rows.get(id)
      return row && !row.deleted ? row : undefined
    }
  })
  return {
    getProjectsDir: () => h.projectsDir,
    getDb: () => ({ prepare: stmt, exec: () => {}, pragma: () => {}, close: () => {} })
  }
})

import {
  createProject,
  openProject,
  saveProject,
  listProjects
} from '../src/main/store/projects.repo'

beforeEach(() => {
  h.rows.clear()
  h.projectsDir = mkdtempSync(join(tmpdir(), 'cs-projects-t7-'))
})

afterEach(() => {
  rmSync(h.projectsDir, { recursive: true, force: true })
})

describe('projects.repo · roundtrip', () => {
  it('create → open：空图、graphVersion 0、media 目录就位', () => {
    const meta = createProject('演示项目')
    expect(meta.graphVersion).toBe(0)
    const file = openProject(meta.id)!
    expect(file).not.toBeNull()
    expect(file.version).toBe(1)
    expect(file.nodes).toEqual([])
    expect(file.meta.id).toBe(meta.id)
    expect(file.meta.name).toBe('演示项目')
    expect(existsSync(join(h.projectsDir, meta.id, 'media'))).toBe(true)
  })

  it('open→save→open：图与快照持久化，graphVersion 递增', () => {
    const meta = createProject('p')
    const r1 = saveProject({
      id: meta.id,
      tldrawSnapshot: { schema: 3 },
      graph: { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ id: 'e1' }], groups: [] }
    })
    expect(r1?.graphVersion).toBe(1)
    const r2 = saveProject({ id: meta.id, graph: { nodes: [], edges: [], groups: [] } })
    expect(r2?.graphVersion).toBe(2)

    const file = openProject(meta.id)!
    expect(file.meta.graphVersion).toBe(2)
    expect(file.nodes).toEqual([])
    expect((file.tldrawSnapshot as { schema: number }).schema).toBe(3)
    // 未随本次 save 提交的字段保留旧值（快照独立于图数据）
    expect(listProjects()[0].graphVersion).toBe(2)
  })

  it('save 不存在的项目返回 null', () => {
    expect(saveProject({ id: 'ghost' })).toBeNull()
  })
})

describe('projects.repo · 原子写与损坏回退', () => {
  it('保存后 .tmp 不残留，旧版轮转到 .bak', () => {
    const meta = createProject('p')
    saveProject({ id: meta.id, graph: { nodes: [{ id: 'v1' }], edges: [], groups: [] } })
    saveProject({ id: meta.id, graph: { nodes: [{ id: 'v2' }], edges: [], groups: [] } })

    const dir = join(h.projectsDir, meta.id)
    const files = readdirSync(dir)
    expect(files).toContain('project.json')
    expect(files).toContain('project.json.bak')
    expect(files).not.toContain('project.json.tmp')

    const bak = JSON.parse(readFileSync(join(dir, 'project.json.bak'), 'utf-8'))
    expect(bak.meta.graphVersion).toBe(1)
    expect(bak.nodes).toEqual([{ id: 'v1' }])
    const cur = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'))
    expect(cur.meta.graphVersion).toBe(2)
  })

  it('主文件损坏时回退 .bak 读取最近有效版本', () => {
    const meta = createProject('p')
    // 两次保存：第一次的 good 版本轮转进 .bak，主文件是第二次的 newer 版本
    saveProject({ id: meta.id, graph: { nodes: [{ id: 'good' }], edges: [], groups: [] } })
    saveProject({ id: meta.id, graph: { nodes: [{ id: 'newer' }], edges: [], groups: [] } })
    writeFileSync(join(h.projectsDir, meta.id, 'project.json'), '###corrupted###', 'utf-8')

    const file = openProject(meta.id)
    expect(file).not.toBeNull()
    expect(file!.nodes).toEqual([{ id: 'good' }])
    // 回退读取不覆盖损坏文件，损坏现场保留供诊断
    expect(readFileSync(join(h.projectsDir, meta.id, 'project.json'), 'utf-8')).toBe(
      '###corrupted###'
    )
  })

  it('主文件与 .bak 双双损坏返回 null（由上层提示重建）', () => {
    const meta = createProject('p')
    saveProject({ id: meta.id, graph: { nodes: [], edges: [], groups: [] } })
    writeFileSync(join(h.projectsDir, meta.id, 'project.json'), '{bad', 'utf-8')
    writeFileSync(join(h.projectsDir, meta.id, 'project.json.bak'), '{bad', 'utf-8')
    expect(openProject(meta.id)).toBeNull()
  })
})
