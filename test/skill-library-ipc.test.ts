import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { getDb } from '../src/main/store/db'
import { registerSkillLibraryIpc } from '../src/main/ipc/skill-library.ipc'
import { FlowSkillStore } from '../src/main/agent-flow/skill-store'
import { parseSkillUpload } from '../src/shared/skill-agent'
import { IPC } from '../src/shared/contracts'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../src/shared/observability'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/store/db', () => ({ getDb: vi.fn() }))
let db: Database.Database
const events: DiagnosticsEventInput[] = []
const frame = {}
const contents = { mainFrame: frame }
const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
type Handler = (
  event: IpcMainInvokeEvent,
  raw?: unknown
) => { ok: boolean; data?: unknown; error?: { code: string } }
function invoke(channel: string, raw?: unknown, sender = event): ReturnType<Handler> {
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.find((call) => call[0] === channel)?.[1] as Handler
  return handler(sender, raw)
}
beforeEach(() => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  migrateDatabase(db)
  vi.mocked(getDb).mockReturnValue(db)
  events.length = 0
  setGatewayEventSink((value) => {
    events.push(value)
  })
  registerSkillLibraryIpc(() => window)
})
afterEach(() => {
  setGatewayEventSink(null)
  db.close()
})

describe('shared skill library IPC', () => {
  it('installs immutable versions and lists the same library from a new store instance', () => {
    const skill = parseSkillUpload('a.md', 'PRIVATE-SKILL fake-secret')
    expect(invoke(IPC.skillLibrary.install, skill).ok).toBe(true)
    expect(invoke(IPC.skillLibrary.install, skill).ok).toBe(true)
    expect(new FlowSkillStore(db).list()).toMatchObject([skill])
    expect(invoke(IPC.skillLibrary.list).data).toMatchObject([skill])
    expect(invoke(IPC.skillLibrary.install, { ...skill, instructions: 'changed' })).toMatchObject({
      ok: false,
      error: { code: 'SKILL_VERSION_IMMUTABLE' }
    })
    expect(new FlowSkillStore(db).list()[0].instructions).toBe(skill.instructions)
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE-SKILL|fake-secret/)
    for (const start of events.filter((item) => item.event === 'skill.library.started'))
      expect(
        events.filter(
          (item) => item.traceId === start.traceId && /\.(completed|failed)$/.test(item.event)
        )
      ).toHaveLength(1)
  })
  it('rejects subframes and foreign windows before touching storage', () => {
    for (const sender of [
      { ...event, senderFrame: {} },
      { ...event, sender: {} }
    ])
      expect(invoke(IPC.skillLibrary.install, {}, sender as IpcMainInvokeEvent)).toMatchObject({
        ok: false,
        error: { code: 'SKILL_SENDER_REJECTED' }
      })
    expect(new FlowSkillStore(db).list()).toEqual([])
  })
  it('rejects malformed packages, filters disabled versions, and detects corruption', () => {
    expect(invoke(IPC.skillLibrary.install, { scripts: 'shell' }).ok).toBe(false)
    const skill = parseSkillUpload('a.md', 'body')
    invoke(IPC.skillLibrary.install, skill)
    const store = new FlowSkillStore(db)
    store.setEnabled(skill.id, skill.version, false)
    expect(invoke(IPC.skillLibrary.list).data).toEqual([])
    store.setEnabled(skill.id, skill.version, true)
    db.prepare("UPDATE flow_skill_versions SET content_hash='bad'").run()
    expect(invoke(IPC.skillLibrary.list)).toMatchObject({
      ok: false,
      error: { code: 'SKILL_CONTENT_INVALID' }
    })
  })
  it('diagnostic sink failure cannot change installation or lookup results', () => {
    setGatewayEventSink(() => {
      throw new Error('logger offline')
    })
    const skill = parseSkillUpload('a.md', 'body')
    expect(invoke(IPC.skillLibrary.install, skill).ok).toBe(true)
    expect(invoke(IPC.skillLibrary.list).data).toMatchObject([skill])
  })
})
