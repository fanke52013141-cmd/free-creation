// 运行记录仓库测试（R8 WP2：runs.json FIFO / 损坏重建 / 原子写 / runMeta 计时）
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// 必须在导入 run.ipc.ts 之前 mock db.ts，避免拉入 electron / better-sqlite3
let tempDir: string

vi.mock('../src/main/store/db', () => ({
  getProjectsDir: () => join(tempDir, 'projects')
}))

// 动态导入：确保 vi.mock 先注册
const { appendRunRecord, readRunRecords } = await import('../src/main/ipc/run.ipc')
import type { RunRecordEntry } from '../src/shared/contracts'

function makeRecord(
  runId: string,
  durationMs = 1000,
  overrides?: Partial<RunRecordEntry>
): RunRecordEntry {
  return {
    runId,
    startedAt: Date.now(),
    durationMs,
    total: 3,
    ok: 3,
    failed: 0,
    nodes: [
      { id: 'shape:A', label: '节点A', type: 'text', status: 'done', durationMs: 300 },
      { id: 'shape:B', label: '节点B', type: 'chat', status: 'done', durationMs: 500 },
      { id: 'shape:C', label: '节点C', type: 'image', status: 'done', durationMs: 200 }
    ],
    ...overrides
  }
}

describe('runs.json 仓库', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runs-test-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('文件不存在时创建新记录', () => {
    appendRunRecord('proj1', makeRecord('run-1'))
    const records = readRunRecords('proj1')
    expect(records).toHaveLength(1)
    expect(records[0].runId).toBe('run-1')
  })

  it('追加写入后最新在前（unshift）', () => {
    appendRunRecord('proj1', makeRecord('run-1'))
    appendRunRecord('proj1', makeRecord('run-2'))
    appendRunRecord('proj1', makeRecord('run-3'))
    const records = readRunRecords('proj1')
    expect(records).toHaveLength(3)
    expect(records[0].runId).toBe('run-3')
    expect(records[1].runId).toBe('run-2')
    expect(records[2].runId).toBe('run-1')
  })

  it('超过 50 条时 FIFO 淘汰最旧记录', () => {
    for (let i = 1; i <= 55; i++) {
      appendRunRecord('proj1', makeRecord(`run-${i.toString().padStart(3, '0')}`))
    }
    const records = readRunRecords('proj1')
    expect(records).toHaveLength(50)
    // 最新 50 条：run-055 ~ run-006
    expect(records[0].runId).toBe('run-055')
    expect(records[49].runId).toBe('run-006')
  })

  it('runs.json 损坏（非法 JSON）时降级重建为仅含当前记录', () => {
    const dir = join(tempDir, 'projects', 'proj1')
    const runsPath = join(dir, 'runs.json')
    // 手动写入损坏的 JSON
    appendRunRecord('proj1', makeRecord('run-old')) // 先创建目录
    writeFileSync(runsPath, '{ this is not valid JSON', 'utf-8')

    // 追加新记录应该不崩溃，且降级为仅含新记录
    appendRunRecord('proj1', makeRecord('run-new'))
    const records = readRunRecords('proj1')
    expect(records).toHaveLength(1)
    expect(records[0].runId).toBe('run-new')
  })

  it('runs.json 内容非数组（如旧格式对象）时降级为空再追加', () => {
    const dir = join(tempDir, 'projects', 'proj1')
    const runsPath = join(dir, 'runs.json')
    appendRunRecord('proj1', makeRecord('run-old'))
    writeFileSync(runsPath, '{"legacy":"object-format"}', 'utf-8')

    appendRunRecord('proj1', makeRecord('run-new'))
    const records = readRunRecords('proj1')
    expect(records).toHaveLength(1)
    expect(records[0].runId).toBe('run-new')
  })

  it('原子写：写入后 .tmp 不残留，.bak 可存在', () => {
    appendRunRecord('proj1', makeRecord('run-1'))
    appendRunRecord('proj1', makeRecord('run-2'))

    const dir = join(tempDir, 'projects', 'proj1')
    expect(existsSync(join(dir, 'runs.json'))).toBe(true)
    // 临时文件不应残留
    expect(existsSync(join(dir, 'runs.json.tmp'))).toBe(false)
    // 第二次写入后旧版应留备份
    expect(existsSync(join(dir, 'runs.json.bak'))).toBe(true)
  })

  it('readRunRecords 对不存在文件返回空数组', () => {
    const records = readRunRecords('nonexistent-project')
    expect(records).toEqual([])
  })

  it('readRunRecords 对损坏文件返回空数组', () => {
    const dir = join(tempDir, 'projects', 'proj1')
    appendRunRecord('proj1', makeRecord('run-1'))
    writeFileSync(join(dir, 'runs.json'), 'corrupted', 'utf-8')
    const records = readRunRecords('proj1')
    expect(records).toEqual([])
  })

  it('runMeta 计时数据往返一致（appendRunRecord 透传不做转换）', () => {
    const rec = makeRecord('run-precision', 1235)
    appendRunRecord('proj1', rec)
    const records = readRunRecords('proj1')
    expect(records[0].durationMs).toBe(1235)
  })

  it('失败节点明细保留 errorReason 和 failed 计数', () => {
    const rec = makeRecord('run-fail', 500, {
      ok: 2,
      failed: 1,
      nodes: [
        { id: 'shape:A', label: '节点A', type: 'text', status: 'done', durationMs: 100 },
        {
          id: 'shape:B',
          label: '节点B',
          type: 'chat',
          status: 'failed',
          durationMs: 300,
          errorReason: 'API 超时'
        },
        { id: 'shape:C', label: '节点C', type: 'image', status: 'skipped', durationMs: 0 }
      ]
    })
    appendRunRecord('proj1', rec)
    const records = readRunRecords('proj1')
    expect(records[0].failed).toBe(1)
    expect(records[0].ok).toBe(2)
    const failedNode = records[0].nodes.find((n) => n.status === 'failed')
    expect(failedNode?.errorReason).toBe('API 超时')
  })
})
