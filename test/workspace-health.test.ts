import { mkdtempSync, mkdirSync, existsSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { reconcileWorkspace, sweepStaleVideoTempFiles } from '../src/main/store/workspace-health'

describe('workspace startup health check', () => {
  it('moves interrupted imports to recovery and only reports other anomalies', () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'canvas-health-'))
    mkdirSync(join(projectsDir, 'new.importing', 'media'), { recursive: true })
    mkdirSync(join(projectsDir, 'live'), { recursive: true })
    writeFileSync(join(projectsDir, 'live', 'project.json'), '{}')
    writeFileSync(join(projectsDir, 'live', 'project.json.tmp'), '{}')

    const report = reconcileWorkspace({ projectsDir, projectIds: ['live', 'ghost'], now: 123 })

    expect(report.recoveredImports).toEqual([join(projectsDir, '.recovery', 'new.importing-123')])
    expect(existsSync(join(projectsDir, 'new.importing'))).toBe(false)
    expect(existsSync(report.recoveredImports[0]!)).toBe(true)
    expect(report.orphanedProjectIds).toEqual(['ghost'])
    expect(report.temporaryFiles).toEqual([join(projectsDir, 'live', 'project.json.tmp')])
  })
})

describe('tmp-video-* 启动清扫', () => {
  it('只删除修改时间超过 24 小时的 tmp-video-*，新文件与其它前缀不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-sweep-'))
    const stale = join(dir, 'tmp-video-stale.mp4')
    const fresh = join(dir, 'tmp-video-fresh.mp4')
    const other = join(dir, 'tmp-image-x')
    writeFileSync(stale, 'a')
    writeFileSync(fresh, 'b')
    writeFileSync(other, 'c')
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(stale, staleTime, staleTime)

    const removed = sweepStaleVideoTempFiles(dir)

    expect(removed).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    // 24 小时以内可能是并行实例正在写的文件，绝不能误删
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('目录不存在时静默返回空列表', () => {
    expect(sweepStaleVideoTempFiles(join(tmpdir(), 'canvas-sweep-missing-xyz'))).toEqual([])
  })
})
