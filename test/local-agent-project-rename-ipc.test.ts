import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basename, join, resolve } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
const state = vi.hoisted(() => ({ handlers: {} as Record<string, (...args: any[]) => any> }))
vi.mock('electron', () => ({
  app: undefined,
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      state.handlers[channel] = handler
    },
    on: () => {}
  }
}))
vi.mock('../src/main/store/canvas-structure-transfer', () => ({
  exportCanvasStructure: vi.fn(),
  importCanvasStructure: vi.fn()
}))
import { registerProjectIpc } from '../src/main/ipc/project.ipc'
import type { ProjectFileWatcher } from '../src/main/ipc/project-watcher'
import { LocalAccessService } from '../src/main/agent-access/service'
import { closeDb } from '../src/main/store/db'
import { createProject, openProject } from '../src/main/store/projects.repo'
import { IPC } from '../src/shared/contracts'
import { exportProject } from '../src/main/store/transfer'
import AdmZip from 'adm-zip'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let active: string | null
const previous = process.env.CANVAS_DATA_DIR
const events: any[] = []
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-rename-access-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  state.handlers = {}
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  registerProjectIpc({
    get activeProjectId() {
      return active
    }
  } as ProjectFileWatcher)
})
afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  if (previous === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = previous
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-rename-access-')
  )
    throw Error('RENAME_CLEANUP_REJECTED')
  rmSync(directory, { recursive: true, force: true })
})
describe('closed UI project rename and local access share revision authority', () => {
  it('persists the UI name in the snapshot and rejects a stale external mutation', async () => {
    const p = createProject('original')
    const ui = state.handlers[IPC.project.rename]({}, { id: p.id, name: 'private-ui-name' })
    expect(ui).toMatchObject({ ok: true, data: { name: 'private-ui-name', graphVersion: 1 } })
    expect(
      JSON.parse(readFileSync(join(directory, 'projects', p.id, 'project.json'), 'utf8')).meta.name
    ).toBe('private-ui-name')
    const service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(directory, 'agent-exports'),
      activeProjectId: () => active
    })
    const reply = await service.dispatch({
      apiVersion: 1,
      operationVersion: 1,
      operationId: 'project.rename',
      requestId: randomUUID(),
      expectedDataStoreId: service.dataStoreId,
      idempotencyKey: `${Date.now()}:${randomUUID()}`,
      input: { projectId: p.id, name: 'overwrite', expectedGraphVersion: 0 }
    })
    expect(reply.error?.code).toBe('REVISION_CONFLICT')
    expect(openProject(p.id)?.meta.name).toBe('private-ui-name')
    expect(events.filter((e) => e.event === 'project.save.started')).toHaveLength(1)
    expect(events.filter((e) => e.event === 'project.save.completed')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('private-ui-name')
  })
  it('preserves active-canvas metadata behavior without invalidating its unsaved graph revision', async () => {
    const p = createProject('active')
    active = p.id
    const reply = state.handlers[IPC.project.rename]({}, { id: p.id, name: 'active-new' })
    expect(reply).toMatchObject({ ok: true, data: { name: 'active-new', graphVersion: 0 } })
    expect(openProject(p.id)?.meta.graphVersion).toBe(0)
    const exported = exportProject(p.id, join(directory, 'active.canvasbundle'))
    expect(JSON.parse(new AdmZip(exported.path).readAsText('project.json')).meta.name).toBe(
      'active-new'
    )
  })
  it('does not let diagnostics failure change a successful closed UI rename', async () => {
    const p = createProject('logger')
    setGatewayEventSink({
      emit: () => {
        throw Error('logger unavailable')
      }
    })
    expect(state.handlers[IPC.project.rename]({}, { id: p.id, name: 'still-saved' })).toMatchObject(
      { ok: true, data: { name: 'still-saved', graphVersion: 1 } }
    )
  })
})
