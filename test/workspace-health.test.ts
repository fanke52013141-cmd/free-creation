import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { reconcileWorkspace } from '../src/main/store/workspace-health'

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
