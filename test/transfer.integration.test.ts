import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  projectsDir: '',
  projects: [] as unknown[][],
  media: [] as unknown[][]
}))

vi.mock('../src/main/store/db', (): { getProjectsDir: () => string; getDb: () => unknown } => {
  const statement = (
    sql: string
  ): { all: () => unknown[]; run: (...values: unknown[]) => void } => ({
    all: () => [],
    run: (...values: unknown[]) => {
      if (sql.startsWith('INSERT INTO projects')) state.projects.push(values)
      else if (sql.startsWith('INSERT INTO media')) state.media.push(values)
      else if (sql.startsWith('DELETE FROM media')) state.media = []
      else if (sql.startsWith('DELETE FROM projects')) state.projects = []
    }
  })
  return {
    getProjectsDir: () => state.projectsDir,
    getDb: () => ({ prepare: statement, transaction: (fn: () => void) => () => fn() })
  }
})

import { importProject } from '../src/main/store/transfer'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canvas-transfer-'))
  state.projectsDir = join(root, 'projects')
  state.projects = []
  state.media = []
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('importProject · 本地导入集成', () => {
  it('重映射节点、tldraw 快照、运行结果与导演台媒体引用，并在提交后创建项目', () => {
    const sourceId = 'source-project'
    const oldId = 'old-image'
    const oldPath = `projects/${sourceId}/media/${oldId}.png`
    const zipPath = join(root, 'source.canvasbundle')
    const zip = new AdmZip()
    zip.addFile(
      'project.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          meta: { id: sourceId, name: '来源项目', createdAt: 1, updatedAt: 1, graphVersion: 4 },
          nodes: [{ content: { kind: 'media', mediaId: oldId } }],
          edges: [],
          groups: [],
          tldrawSnapshot: {
            store: {
              'shape:node': {
                props: { mediaId: oldId, mediaPath: oldPath },
                meta: {
                  nodeResult: {
                    frame: { mediaId: oldId, mediaPath: oldPath },
                    referenceMediaIds: [oldId]
                  }
                }
              }
            }
          }
        })
      )
    )
    zip.addFile('media/old-image.png', Buffer.from([137, 80, 78, 71]))
    zip.writeZip(zipPath)

    const result = importProject(zipPath)
    const projectPath = join(state.projectsDir, result.id, 'project.json')
    const imported = JSON.parse(readFileSync(projectPath, 'utf-8'))
    const mediaId = imported.nodes[0].content.mediaId
    const mediaPath = imported.tldrawSnapshot.store['shape:node'].props.mediaPath

    expect(result.graphVersion).toBe(0)
    expect(mediaId).not.toBe(oldId)
    expect(imported.tldrawSnapshot.store['shape:node'].props.mediaId).toBe(mediaId)
    expect(imported.tldrawSnapshot.store['shape:node'].meta.nodeResult.frame.mediaId).toBe(mediaId)
    expect(imported.tldrawSnapshot.store['shape:node'].meta.nodeResult.referenceMediaIds).toEqual([
      mediaId
    ])
    expect(mediaPath).toBe(`projects/${result.id}/media/${mediaId}.png`)
    expect(existsSync(join(state.projectsDir, result.id, 'media', `${mediaId}.png`))).toBe(true)
    expect(state.projects).toHaveLength(1)
    expect(state.media).toHaveLength(1)
    expect(existsSync(join(state.projectsDir, `${result.id}.importing`))).toBe(false)
  })

  it('项目版本不支持时不写入数据库或项目目录', () => {
    const zipPath = join(root, 'invalid.canvasbundle')
    const zip = new AdmZip()
    zip.addFile(
      'project.json',
      Buffer.from(
        JSON.stringify({
          version: 99,
          meta: { id: 'bad', name: '坏包', graphVersion: 0 },
          nodes: [],
          edges: [],
          groups: []
        })
      )
    )
    zip.writeZip(zipPath)

    expect(() => importProject(zipPath)).toThrow(/版本不兼容/)
    expect(state.projects).toHaveLength(0)
    expect(state.media).toHaveLength(0)
  })
})
