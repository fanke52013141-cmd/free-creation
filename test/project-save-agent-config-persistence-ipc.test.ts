import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateDatabase } from '../src/main/store/db-migrations'

const state = vi.hoisted(() => ({
  root: '',
  db: null as unknown as Database.Database,
  handlers: {} as Record<string, (...args: any[]) => any>
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: any[]) => any) => { state.handlers[channel] = handler },
    handle: (channel: string, handler: (...args: any[]) => any) => { state.handlers[channel] = handler }
  },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }
}))
vi.mock('../src/main/store/db', () => ({
  getDb: () => state.db,
  getDataDir: () => state.root,
  getProjectsDir: () => join(state.root, 'projects'),
  getSetting: () => null,
  setSetting: () => undefined
}))
vi.mock('../src/main/ipc/project-watcher', () => ({
  ProjectFileWatcher: class {
    startWatching = vi.fn()
    stopWatching = vi.fn()
    notifySelfSave = vi.fn()
  }
}))
vi.mock('../src/main/store/transfer', () => ({ exportProject: vi.fn(), importProject: vi.fn() }))
vi.mock('../src/main/store/canvas-structure-transfer', () => ({
  exportCanvasStructure: vi.fn(),
  importCanvasStructure: vi.fn()
}))

import { createProject, openProject } from '../src/main/store/projects.repo'
import { registerProjectIpc } from '../src/main/ipc/project.ipc'
import { IPC } from '../src/shared/contracts'
import {
  AgentNodeConfigSchema,
  DEFAULT_AGENT_NODE_CONFIG
} from '../src/shared/agent-flow/node-contracts'

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'canvas-agent-config-save-ipc-'))
  state.db = new Database(':memory:')
  migrateDatabase(state.db)
  state.handlers = {}
  registerProjectIpc()
})

afterEach(() => {
  state.db?.close()
  if (
    resolve(state.root, '..') !== resolve(tmpdir()) ||
    !basename(state.root).startsWith('canvas-agent-config-save-ipc-')
  ) {
    throw new Error('AGENT_CONFIG_IPC_CLEANUP_REJECTED')
  }
  rmSync(state.root, { recursive: true, force: true })
})

describe('CFG-04 actual project-save IPC and repository persistence', () => {
  it.each([
    { key: 'maxSteps=0', patch: { maxSteps: 0 }, legal: false },
    { key: 'maxSteps=1', patch: { maxSteps: 1 }, legal: true },
    { key: 'maxSteps=64', patch: { maxSteps: 64 }, legal: true },
    { key: 'maxSteps=65', patch: { maxSteps: 65 }, legal: false },
    { key: 'maxParallelTasks=0', patch: { maxParallelTasks: 0 }, legal: false },
    { key: 'maxParallelTasks=1', patch: { maxParallelTasks: 1 }, legal: true },
    { key: 'maxParallelTasks=4', patch: { maxParallelTasks: 4 }, legal: true },
    { key: 'maxParallelTasks=5', patch: { maxParallelTasks: 5 }, legal: false }
  ])('$key is accepted only within the schema boundary', ({ key, patch, legal }) => {
    const project = createProject(`CFG04 IPC ${key}`)
    const config = { ...DEFAULT_AGENT_NODE_CONFIG, ...patch }
    const node = {
      id: `agent-${key}`,
      type: 'agent',
      contractVersion: 1,
      title: 'Agent',
      x: 100,
      y: 100,
      w: 340,
      h: 260,
      ports: [],
      params: { config: JSON.stringify(config) },
      content: { kind: 'empty' },
      exec: { status: 'idle' },
      meta: { source: 'input', createdAt: 1 }
    }
    const reply = state.handlers[IPC.project.save]({}, {
      id: project.id,
      expectedGraphVersion: 0,
      graph: { nodes: [node], edges: [], groups: [] }
    })
    const reopened = openProject(project.id)
    const savedNode = reopened?.nodes.find((candidate) => candidate.id === node.id) as
      | { params: { config: string } }
      | undefined
    const savedConfig = savedNode ? JSON.parse(savedNode.params.config) : null

    if (legal) {
      expect(reply).toMatchObject({ ok: true, data: { graphVersion: 1 } })
      expect(savedNode).toBeDefined()
      expect(AgentNodeConfigSchema.safeParse(savedConfig).success).toBe(true)
      expect(reopened?.meta.graphVersion).toBe(1)
    } else {
      expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_AGENT_CONFIG' } })
      expect(savedNode).toBeUndefined()
      expect(reopened?.meta.graphVersion).toBe(0)
    }
  })
})
