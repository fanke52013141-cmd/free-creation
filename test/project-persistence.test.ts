import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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

const state = vi.hoisted(() => ({
  projectsDir: '',
  rows: new Map<string, StoredProjectRow>()
}))

vi.mock('../src/main/store/db', (): { getProjectsDir: () => string; getDb: () => unknown } => {
  const statement = (sql: string) => ({
    all: () => [...state.rows.values()].filter((row) => row.deleted === 0),
    get: (id: string) => {
      const row = state.rows.get(id)
      return row?.deleted === 0 ? row : undefined
    },
    run: (...values: unknown[]) => {
      if (sql.startsWith('INSERT INTO projects')) {
        const [id, name, createdAt, updatedAt] = values as [string, string, number, number]
        state.rows.set(id, {
          id,
          name,
          created_at: createdAt,
          updated_at: updatedAt,
          cover_media_id: null,
          graph_version: 0,
          deleted: 0
        })
      }
      if (sql.startsWith('UPDATE projects SET updated_at')) {
        const [updatedAt, graphVersion, id] = values as [number, number, string]
        const row = state.rows.get(id)
        if (row) {
          row.updated_at = updatedAt
          row.graph_version = graphVersion
        }
      }
      return { changes: 1 }
    }
  })
  return {
    getProjectsDir: () => state.projectsDir,
    getDb: () => ({ prepare: statement })
  }
})

import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canvas-project-persistence-'))
  state.projectsDir = join(root, 'projects')
  state.rows.clear()
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('项目保存与重开 · 媒体运行溯源', () => {
  it('保留媒体结果所属 runId、当前运行记录和历史记录', () => {
    const project = createProject('运行溯源')
    const nodeResult = JSON.stringify({
      kind: 'media-source',
      version: 1,
      selectedMediaId: 'media-new',
      results: [
        {
          mediaId: 'media-old',
          mediaPath: 'projects/p/media/media-old.png',
          mime: 'image/png',
          createdAt: 10,
          runId: 'run-old'
        },
        {
          mediaId: 'media-new',
          mediaPath: 'projects/p/media/media-new.png',
          mime: 'image/png',
          createdAt: 20,
          runId: 'run-current'
        }
      ]
    })
    const runCurrent = {
      runId: 'run-current',
      status: 'success',
      startedAt: 11,
      finishedAt: 20,
      durationMs: 9,
      inputs: {}
    }
    const runOld = {
      runId: 'run-old',
      status: 'success',
      startedAt: 1,
      finishedAt: 10,
      durationMs: 9,
      inputs: {}
    }

    saveProject({
      id: project.id,
      tldrawSnapshot: {
        store: {
          'shape:image': {
            type: 'node-card',
            props: { mediaId: 'media-new', mediaPath: 'projects/p/media/media-new.png' },
            meta: { nodeResult, nodeRun: runCurrent, nodeRunHistory: [runCurrent, runOld] }
          }
        }
      }
    })

    const reopened = openProject(project.id)
    const snapshot = reopened?.tldrawSnapshot as {
      store: Record<
        string,
        { meta: { nodeResult: string; nodeRun: unknown; nodeRunHistory: unknown } }
      >
    }
    const restored = snapshot.store['shape:image'].meta

    expect(
      JSON.parse(restored.nodeResult).results.map((item: { runId: string }) => item.runId)
    ).toEqual(['run-old', 'run-current'])
    expect(restored.nodeRun).toEqual(runCurrent)
    expect(restored.nodeRunHistory).toEqual([runCurrent, runOld])
  })
})
