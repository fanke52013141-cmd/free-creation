/**
 * F01 回归测试：保存事务分阶段回滚（HANDOFF_2026_09_15_CODE_REVIEW）
 *
 * 缺陷背景：原实现使用与失败阶段无关的固定回滚序列
 *   （path→tmp、bak→path、删除 tmp）。
 * 当失败发生在 tmp 写入或轮转阶段时，主文件上唯一有效的数据会被移入 tmp
 * 再删除 —— project.json 整体丢失，且 graph_version 与文件内容脱钩。
 *
 * 修复语义（分阶段精确回滚）：
 *   - write-tmp 失败：只清 tmp，主文件/.bak 均未触碰
 *   - rotate-bak 失败：主文件仍在且完好，丢弃未提交 tmp
 *   - promote-tmp 失败：从 .bak 恢复主文件，丢弃 tmp
 *   - update-db 失败：用 .bak 把文件回滚到旧版本（既有行为）
 *
 * 故障注入：vi.mock('node:fs') 局部替换（importOriginal 保留真实实现），
 * 由 hoisted 指示器 fsFault 控制（failOp + failCount）。
 * SQLite 侧用 vi.mock 指示器 failOnUpdate，与 graph-write-transaction.test.ts 同源。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface StoredProjectRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  cover_media_id: string | null
  graph_version: number
  deleted: number
}

const repoState = vi.hoisted(() => ({
  projectsDir: '',
  rows: new Map<string, StoredProjectRow>(),
  failOnUpdate: false,
  fsFault: { failOp: '', failCount: 0 }
}))

const fsFault = repoState.fsFault

vi.mock('../../src/main/store/db', (): unknown => {
  const statement = (sql: string) => ({
    all: () => [...repoState.rows.values()].filter((row) => row.deleted === 0),
    get: (id: string) => {
      const row = repoState.rows.get(id)
      return row && row.deleted === 0 ? row : undefined
    },
    run: (...values: unknown[]) => {
      if (sql.startsWith('INSERT INTO projects')) {
        const [id, name, createdAt, updatedAt] = values as [string, string, number, number]
        repoState.rows.set(id, {
          id: id,
          name: name,
          created_at: createdAt,
          updated_at: updatedAt,
          cover_media_id: null,
          graph_version: 0,
          deleted: 0
        })
      }
      if (sql.startsWith('UPDATE projects SET updated_at')) {
        if (repoState.failOnUpdate) throw new Error('SQLite 写入失败（注入）')
        const [updatedAt, graphVersion, id] = values as [number, number, string]
        const row = repoState.rows.get(id)
        if (row) {
          row.updated_at = updatedAt
          row.graph_version = graphVersion
        }
      }
      return { changes: 1 }
    }
  })
  return {
    getProjectsDir: () => repoState.projectsDir,
    getDb: () => ({ prepare: statement })
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const maybeFail = (op: string): void => {
    if (repoState.fsFault.failOp === op && repoState.fsFault.failCount > 0) {
      repoState.fsFault.failCount -= 1
      if (repoState.fsFault.failCount === 0) repoState.fsFault.failOp = ''
      throw new Error('文件故障注入（' + op + '）')
    }
  }
  return {
    ...actual,
    writeFileSync: ((
      target: Parameters<typeof actual.writeFileSync>[0],
      data: string,
      options?: Parameters<typeof actual.writeFileSync>[2]
    ) => {
      if (
        repoState.fsFault.failOp === 'writeTmp' &&
        typeof target === 'string' &&
        target.endsWith('.tmp')
      ) {
        maybeFail('writeTmp')
      }
      return actual.writeFileSync(target, data, options)
    }) as typeof actual.writeFileSync,
    renameSync: ((from: string, to: string) => {
      if (repoState.fsFault.failOp === 'rotateBak' && to.endsWith('.bak')) {
        maybeFail('rotateBak')
      } else if (
        repoState.fsFault.failOp === 'promoteTmp' &&
        from.endsWith('.tmp') &&
        !to.endsWith('.bak')
      ) {
        maybeFail('promoteTmp')
      }
      return actual.renameSync(from, to)
    }) as typeof actual.renameSync
  }
})

describe('projects.repo.saveProject 分阶段回滚（F01）', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canvas-f01-rollback-'))
    repoState.projectsDir = join(root, 'projects')
    repoState.rows.clear()
    repoState.failOnUpdate = false
    fsFault.failOp = ''
    fsFault.failCount = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  async function importRepo() {
    return import('../../src/main/store/projects.repo')
  }

  async function seedProject() {
    const repo = await importRepo()
    const meta = repo.createProject('分阶段回滚')
    const path = join(repoState.projectsDir, meta.id, 'project.json')
    // v0 内容：createProject 直接写入的初始文件
    const v0Content = readFileSync(path, 'utf-8')
    repo.saveProject({
      id: meta.id,
      graph: { nodes: [], edges: [], groups: [] },
      tldrawSnapshot: { store: { 'page:page': { typeName: 'page' } } }
    })
    return {
      repo: repo,
      id: meta.id,
      path: path,
      content: readFileSync(path, 'utf-8'),
      // seed 保存轮转出的 .bak（v0 内容）；断言失败保存不会改动它
      bakContent: readFileSync(path + '.bak', 'utf-8')
    }
  }

  it('tmp 写入失败：主文件完好、.bak/.tmp 均未被触碰', async () => {
    const seeded = await seedProject()
    fsFault.failOp = 'writeTmp'
    fsFault.failCount = 1

    expect(() =>
      seeded.repo.saveProject({
        id: seeded.id,
        graph: { nodes: [], edges: [], groups: [] }
      })
    ).toThrow('文件故障注入（writeTmp）')

    expect(readFileSync(seeded.path, 'utf-8')).toBe(seeded.content)
    expect(readFileSync(seeded.path + '.bak', 'utf-8')).toBe(seeded.bakContent)
    expect(existsSync(seeded.path + '.tmp')).toBe(false)
    expect(seeded.repo.getProject(seeded.id)?.graphVersion).toBe(1)
  })

  it('轮转（main→bak）失败：主文件仍在且内容不变、tmp 被清理', async () => {
    const seeded = await seedProject()
    fsFault.failOp = 'rotateBak'
    fsFault.failCount = 1

    expect(() =>
      seeded.repo.saveProject({
        id: seeded.id,
        graph: { nodes: [], edges: [], groups: [] }
      })
    ).toThrow('文件故障注入（rotateBak）')

    expect(readFileSync(seeded.path, 'utf-8')).toBe(seeded.content)
    expect(readFileSync(seeded.path + '.bak', 'utf-8')).toBe(seeded.bakContent)
    expect(existsSync(seeded.path + '.tmp')).toBe(false)
    expect(seeded.repo.getProject(seeded.id)?.graphVersion).toBe(1)
  })

  it('tmp 转正失败：从 .bak 恢复主文件为旧版内容', async () => {
    const seeded = await seedProject()
    fsFault.failOp = 'promoteTmp'
    fsFault.failCount = 1

    expect(() =>
      seeded.repo.saveProject({
        id: seeded.id,
        graph: { nodes: [], edges: [], groups: [] }
      })
    ).toThrow('文件故障注入（promoteTmp）')

    expect(readFileSync(seeded.path, 'utf-8')).toBe(seeded.content)
    expect(existsSync(seeded.path + '.tmp')).toBe(false)
    expect(seeded.repo.getProject(seeded.id)?.graphVersion).toBe(1)
  })

  it('SQLite 更新失败：文件回滚到旧版（既有行为保持），tmp/.bak 清理干净', async () => {
    const seeded = await seedProject()
    repoState.failOnUpdate = true

    expect(() =>
      seeded.repo.saveProject({
        id: seeded.id,
        graph: { nodes: [], edges: [], groups: [] }
      })
    ).toThrow('SQLite 写入失败（注入）')

    expect(readFileSync(seeded.path, 'utf-8')).toBe(seeded.content)
    expect(existsSync(seeded.path + '.tmp')).toBe(false)
    expect(existsSync(seeded.path + '.bak')).toBe(false)
    repoState.failOnUpdate = false
  })

  it('阶段推进后失败恢复：回滚成功后可正常再次保存且版本单调推进', async () => {
    const seeded = await seedProject()
    fsFault.failOp = 'rotateBak'
    fsFault.failCount = 1
    expect(() =>
      seeded.repo.saveProject({
        id: seeded.id,
        graph: { nodes: [], edges: [], groups: [] }
      })
    ).toThrow('文件故障注入（rotateBak）')

    const again = seeded.repo.saveProject({
      id: seeded.id,
      graph: { nodes: [], edges: [], groups: [] },
      expectedGraphVersion: 1
    })
    expect(again).toEqual({ graphVersion: 2 })
    expect(readFileSync(seeded.path, 'utf-8')).not.toBe(seeded.content)
  })
})
