import { mkdtempSync, mkdirSync, existsSync, utimesSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, basename } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it, afterEach } from 'vitest'
import {
  reconcileWorkspace,
  sweepStaleVideoTempFiles,
  checkWorkspaceHealth
} from '../src/main/store/workspace-health'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'

const directories: string[] = []
function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}
afterEach(() => {
  setGatewayEventSink(null)
  for (const dir of directories.splice(0)) {
    if (resolve(dir, '..') !== resolve(tmpdir()) || !/^canvas-(health|sweep)-/.test(basename(dir)))
      throw new Error('HEALTH_CLEANUP_REJECTED')
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('workspace startup health check', () => {
  it('moves interrupted imports to recovery and only reports other anomalies', () => {
    const projectsDir = temporary('canvas-health-')
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
  it('reports complete unindexed imports without deleting them or treating deleted indexed projects as new imports', () => {
    const root = temporary('canvas-health-')
    for (const id of ['unlisted', 'deleted']) {
      mkdirSync(join(root, id))
      writeFileSync(join(root, id, 'project.json'), '{}')
    }
    const report = reconcileWorkspace({
      projectsDir: root,
      projectIds: [],
      knownProjectIds: ['deleted']
    })
    expect(report.unlistedProjectIds).toEqual(['unlisted'])
    expect(existsSync(join(root, 'unlisted', 'project.json'))).toBe(true)
  })
  it('preserves blocked staging and emits one safe summary even when recovery is incomplete or logging fails', () => {
    const root = temporary('canvas-health-')
    mkdirSync(join(root, 'private-staging.importing'))
    writeFileSync(join(root, '.recovery'), 'blocked')
    const events: DiagnosticsEventInput[] = []
    setGatewayEventSink({
      emit: (event) => {
        if (event) events.push(event)
      }
    })
    const result = checkWorkspaceHealth({ projectsDir: root, projectIds: [] })
    expect(result.temporaryFiles).toEqual([join(root, 'private-staging.importing')])
    expect(existsSync(join(root, 'private-staging.importing'))).toBe(true)
    expect(events.map((event) => event.event)).toEqual([
      'workspace.recovery.started',
      'workspace.recovery.completed'
    ])
    expect(events[0].traceId).toBe(events[1].traceId)
    expect(events[1].attributes?.temporaryFileCount).toBe(1)
    expect(JSON.stringify(events)).not.toContain(root)
    expect(JSON.stringify(events)).not.toContain('private-staging')
    setGatewayEventSink({
      emit: () => {
        throw new Error('private-logger-failure')
      }
    })
    expect(checkWorkspaceHealth({ projectsDir: root, projectIds: [] })).toEqual(result)
  })
})

describe('tmp-video-* 启动清扫', () => {
  it('只删除修改时间超过 24 小时的 tmp-video-*，新文件与其它前缀不动', () => {
    const dir = temporary('canvas-sweep-')
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
