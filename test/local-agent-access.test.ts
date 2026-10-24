import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'
vi.mock('electron', () => ({ app: undefined }))
import { closeDb, getDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import {
  ACCESS_KEY_TTL_MS,
  ACCESS_OPERATIONS,
  AccessResponseSchema,
  nodeAccessDirectory,
  toolInputSchema,
  validateAccessRegistry
} from '../src/shared/agent-access/registry'
import { startLocalAccessServer, type LocalAccessServer } from '../src/main/agent-access/server'
import { callLocalOperation } from '../src/local-agent/client'
import { DesktopAccessError, type AccessDesktop } from '../src/main/agent-access/desktop'

let directory: string
let service: LocalAccessService
let active: string | null
let server: LocalAccessServer | undefined
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`
function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  })
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-local-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active
  })
})
afterEach(() => {
  server?.close()
  server = undefined
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-local-access-test-')
  )
    throw new Error('ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent vertical slice', () => {
  function withDesktop(desktop: AccessDesktop): void {
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(directory, 'agent-exports'),
      activeProjectId: () => active,
      desktop
    })
  }

  it('flushes active edits before save/export and commits metadata with acknowledged renderer version', async () => {
    const p = createProject('before')
    active = p.id
    withDesktop({
      run: async (request, commit) => {
        const saved = saveProject({
          id: p.id,
          expectedGraphVersion: openProject(p.id)!.meta.graphVersion,
          graph: {
            nodes: [{ id: 'draft', type: 'text', params: { text: 'private unsaved text' } }],
            edges: [],
            groups: []
          }
        })!
        return commit ? commit(saved.graphVersion).graphVersion : saved.graphVersion
      }
    })
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: 0 }, key())).data
    ).toEqual({ graphVersion: 1, saved: true })
    const updated = await call(
      'project.update',
      { projectId: p.id, expectedGraphVersion: 1, name: 'after' },
      key()
    )
    expect(updated.status).toBe('completed')
    expect(openProject(p.id)!.meta).toMatchObject({ name: 'after', graphVersion: 3 })
    const exported = await call(
      'project.export',
      { projectId: p.id, expectedGraphVersion: 3, fileName: 'active.canvasbundle' },
      key()
    )
    expect(exported.status).toBe('completed')
    const bundled = JSON.parse(new AdmZip((exported.data as any).path).readAsText('project.json'))
    expect(bundled.meta).toMatchObject({ name: 'after', graphVersion: 4 })
    expect(bundled.nodes[0].params.text).toBe('private unsaved text')
    expect(JSON.stringify(events)).not.toContain('private unsaved text')
  })

  it('rejects stale version before desktop dispatch and checks ownership again after flush', async () => {
    const p = createProject('active')
    active = p.id
    const run = vi.fn(async () => {
      active = null
      return 0
    })
    withDesktop({ run })
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: 9 }, key())).error?.code
    ).toBe('REVISION_CONFLICT')
    expect(run).not.toHaveBeenCalled()
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: 0 }, key())).status
    ).toBe('unknown')
  })

  it('checks new recovery ownership at switch admission after waiting for the current canvas', async () => {
    const current = createProject('current'),
      target = createProject('target')
    active = current.id
    withDesktop({
      run: async (_request, admit) => {
        writeFileSync(join(directory, 'projects', current.id, 'project.json.local-recovery'), '{}')
        admit!(0)
        active = target.id
        return 0
      }
    })
    const response = await call('project.open', { projectId: target.id }, key())
    expect(response).toMatchObject({
      status: 'failed',
      error: { code: 'RESOURCE_BUSY', phase: 'recovery-ownership' }
    })
    expect(active).toBe(current.id)
  })

  it('opens through the desktop and does not replay an unknown handshake', async () => {
    const p = createProject('open')
    const run = vi.fn(async () => {
      active = p.id
      return 0
    })
    withDesktop({ run })
    const same = key()
    expect((await call('project.open', { projectId: p.id }, same)).data).toMatchObject({
      opened: true,
      meta: { id: p.id }
    })
    await call('project.open', { projectId: p.id }, same)
    expect(run).toHaveBeenCalledTimes(1)
    run.mockImplementation(async () => {
      throw new DesktopAccessError('DESKTOP_TIMEOUT', true)
    })
    const timeoutKey = key()
    expect((await call('project.open', { projectId: p.id }, timeoutKey)).status).toBe('unknown')
    expect((await call('project.open', { projectId: p.id }, timeoutKey)).status).toBe('unknown')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps pending idempotency and serializes external effects while the desktop is saving', async () => {
    const p = createProject('open')
    let finish!: (version: number) => void
    withDesktop({
      run: async () => {
        active = p.id
        return await new Promise<number>((resolve) => {
          finish = resolve
        })
      }
    })
    const same = key()
    const pending = call('project.open', { projectId: p.id }, same)
    expect((await call('project.open', { projectId: p.id }, same)).status).toBe('unknown')
    expect((await call('project.create', { name: 'concurrent' }, key())).error?.code).toBe(
      'RESOURCE_BUSY'
    )
    finish(0)
    expect((await pending).status).toBe('completed')
    expect((await call('project.list')).data).toMatchObject({ total: 1 })
  })

  it('declares all Active nodes as planned, only finite operations and strict input/output schemas', async () => {
    expect(validateAccessRegistry()).toEqual([])
    expect(validateAccessRegistry(['new-node'], [])).toContain('UNDECLARED_NODE:new-node')
    expect(validateAccessRegistry(['text'], ['text', 'text'])).toContain('DUPLICATE_NODE')
    expect(nodeAccessDirectory()).toHaveLength(31)
    expect(nodeAccessDirectory().every((n) => n.actions === 'planned')).toBe(true)
    expect(Object.keys(ACCESS_OPERATIONS)).not.toContain('project.import')
    expect(
      toolInputSchema('project.create').safeParse({
        input: { name: 'ok', snapshot: {} },
        idempotencyKey: key()
      }).success
    ).toBe(false)
    expect(toolInputSchema('project.create').safeParse({ input: { name: 'ok' } }).success).toBe(
      false
    )
  })

  it('creates once, persists receipts across restart, rejects a different intent', async () => {
    const same = key()
    const a = await call('project.create', { name: 'private-project-body' }, same)
    expect(a.status).toBe('completed')
    const second = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(directory, 'agent-exports'),
      activeProjectId: () => null
    })
    service = second
    const b = await call('project.create', { name: 'private-project-body' }, same)
    expect(b.data).toEqual(a.data)
    expect(((await call('project.list')).data as any).total).toBe(1)
    expect((await call('project.create', { name: 'changed' }, same)).error?.code).toBe(
      'IDEMPOTENCY_CONFLICT'
    )
    expect(JSON.stringify(events)).not.toContain('private-project-body')
  })

  it('rejects expired keys before a side effect, including after receipt pruning', async () => {
    expect(
      (
        await call(
          'project.create',
          { name: 'expired' },
          `${Date.now() - ACCESS_KEY_TTL_MS - 1000}:${randomUUID()}`
        )
      ).error?.code
    ).toBe('IDEMPOTENCY_EXPIRED')
    expect(((await call('project.list')).data as any).total).toBe(0)
  })

  it('turns abandoned receipts into unknown without replaying', async () => {
    const same = key()
    await call('project.create', { name: 'original' }, same)
    getDb().prepare("UPDATE local_agent_operations SET status='pending'").run()
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(directory, 'agent-exports'),
      activeProjectId: () => null
    })
    expect(await call('project.create', { name: 'original' }, same)).toMatchObject({
      status: 'unknown',
      error: { code: 'OUTCOME_UNKNOWN' }
    })
    expect(((await call('project.list')).data as any).total).toBe(1)
  })

  it('renames and saves through normal snapshots while preserving graph and text', async () => {
    const p = createProject('before')
    saveProject({
      id: p.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [{ id: 'n', type: 'json', params: { text: '{"keep":true}', config: {} } }],
        edges: [],
        groups: []
      }
    })
    const rename = await call(
      'project.rename',
      { projectId: p.id, name: 'after', expectedGraphVersion: 1 },
      key()
    )
    expect(rename.status).toBe('completed')
    expect((rename.data as any).meta.graphVersion).toBe(2)
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: 1 }, key())).error?.code
    ).toBe('REVISION_CONFLICT')
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: 2 }, key())).status
    ).toBe('completed')
    const file = openProject(p.id)!
    expect(file.meta.name).toBe('after')
    expect(file.meta.graphVersion).toBe(3)
    expect((file.nodes[0].params as any).text).toBe('{"keep":true}')
    expect(
      JSON.parse(readFileSync(join(directory, 'projects', p.id, 'project.json'), 'utf8')).meta.name
    ).toBe('after')
  })

  it('blocks UI-owned projects without changing disk, even for export', async () => {
    const p = createProject('busy')
    active = p.id
    for (const op of ['project.rename', 'project.save', 'project.export']) {
      const input = {
        projectId: p.id,
        expectedGraphVersion: 0,
        ...(op === 'project.rename' ? { name: 'changed' } : {}),
        ...(op === 'project.export' ? { fileName: 'busy.canvasbundle' } : {})
      }
      expect((await call(op, input, key())).error?.code).toBe('RESOURCE_BUSY')
    }
    expect(openProject(p.id)?.meta.graphVersion).toBe(0)
  })

  it('refuses pending/unknown Flow occupancy even when the project is closed', async () => {
    const p = createProject('occupied')
    getDb()
      .prepare(
        'INSERT INTO flow_coordination_runs(project_id,node_id,task_id,body_json) VALUES (?,?,?,?)'
      )
      .run(p.id, 'node', 'task', '{}')
    getDb()
      .prepare('INSERT INTO flow_coordination_scope(project_id,node_id,task_id) VALUES (?,?,?)')
      .run(p.id, 'node', 'task')
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: 0 }, key())).error?.code
    ).toBe('RESOURCE_BUSY')
  })

  it('does not overwrite or export around an unresolved desktop recovery copy', async () => {
    const p = createProject('recovery')
    writeFileSync(
      join(directory, 'projects', p.id, 'project.json.local-recovery'),
      JSON.stringify({ graph: { nodes: [{ text: 'unsaved-recovery' }] } })
    )
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: 0 }, key())).error?.phase
    ).toBe('recovery-ownership')
    expect(
      (
        await call(
          'project.export',
          { projectId: p.id, expectedGraphVersion: 0, fileName: 'stale.canvasbundle' },
          key()
        )
      ).error?.phase
    ).toBe('recovery-ownership')
    expect(
      readFileSync(join(directory, 'projects', p.id, 'project.json.local-recovery'), 'utf8')
    ).toContain('unsaved-recovery')
    expect(openProject(p.id)?.meta.graphVersion).toBe(0)
  })

  it('exports atomically, strips credentials and never overwrites existing files', async () => {
    const p = createProject('export')
    saveProject({
      id: p.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [
          {
            id: 'node',
            type: 'text',
            params: { config: { apiKey: 'fake-secret-key' }, text: 'private-fixture-body' }
          }
        ],
        edges: [],
        groups: []
      }
    })
    const input = { projectId: p.id, expectedGraphVersion: 1, fileName: 'output.canvasbundle' }
    const result = await call('project.export', input, key())
    expect(result.status).toBe('completed')
    const file = (result.data as any).path
    const zip = new AdmZip(file)
    const text = zip.readAsText('project.json')
    expect(text).not.toContain('fake-secret-key')
    expect(text).toContain('private-fixture-body')
    expect((await call('project.export', input, key())).error?.code).toBe('OUTPUT_EXISTS')
    expect(readdirSync(join(directory, 'agent-exports'))).toEqual(['output.canvasbundle'])
    expect(JSON.stringify(events)).not.toContain('private-fixture-body')
    expect(JSON.stringify(events)).not.toContain(directory)
  })

  it('refuses incomplete media without publishing or leaving temporary bundles', async () => {
    const p = createProject('missing')
    getDb()
      .prepare('INSERT INTO media(id,kind,mime,path,size_bytes,created_at) VALUES (?,?,?,?,?,?)')
      .run('missing', 'image', 'image/png', `projects/${p.id}/media/missing.png`, 1, Date.now())
    expect(
      (
        await call(
          'project.export',
          { projectId: p.id, expectedGraphVersion: 0, fileName: 'missing.canvasbundle' },
          key()
        )
      ).error?.code
    ).toBe('EXPORT_INCOMPLETE')
    expect(readdirSync(join(directory, 'agent-exports'))).toEqual([])
  })

  it('rejects dangling snapshot/result media references even when the media index has lost the row', async () => {
    const p = createProject('dangling')
    saveProject({
      id: p.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [
          {
            id: 'asset',
            type: 'image',
            params: { mediaId: 'unindexed', mediaPath: `projects/${p.id}/media/unindexed.png` }
          }
        ],
        edges: [],
        groups: []
      }
    })
    expect(
      (
        await call(
          'project.export',
          { projectId: p.id, expectedGraphVersion: 1, fileName: 'dangling.canvasbundle' },
          key()
        )
      ).error?.code
    ).toBe('EXPORT_INCOMPLETE')
    expect(readdirSync(join(directory, 'agent-exports'))).toEqual([])
  })

  it('rejects traversal, project imports, forged fields and instance mismatch', async () => {
    expect((await call('project.get', { projectId: '../secret' })).error?.code).toBe(
      'INVALID_INPUT'
    )
    expect(
      (
        await call(
          'project.export',
          { projectId: 'safe', expectedGraphVersion: 0, fileName: '../escape.canvasbundle' },
          key()
        )
      ).error?.code
    ).toBe('INVALID_INPUT')
    expect((await call('project.import', {})).error?.code).toBe('UNSUPPORTED_OPERATION')
    expect(
      (
        await service.dispatch({
          apiVersion: 1,
          operationVersion: 1,
          operationId: 'project.list',
          requestId: randomUUID(),
          expectedDataStoreId: randomUUID(),
          input: {}
        })
      ).error?.code
    ).toBe('INSTANCE_MISMATCH')
  })

  it('pairs each started operation with one terminal and logger failure cannot change business result', async () => {
    const p = createProject('lifecycle')
    await call('project.get', { projectId: p.id })
    await call('project.save', { projectId: p.id, expectedGraphVersion: 0 }, key())
    await call('project.save', { projectId: p.id, expectedGraphVersion: 0 }, key())
    const starts = events.filter((e) => e.event === 'agent.access.started')
    expect(starts).toHaveLength(3)
    for (const begin of starts)
      expect(
        events.filter(
          (e) =>
            e.traceId === begin.traceId &&
            ['agent.access.completed', 'agent.access.failed', 'agent.access.unknown'].includes(
              e.event
            )
        )
      ).toHaveLength(1)
    setGatewayEventSink({
      emit: () => {
        throw new Error('private log failure')
      }
    })
    expect((await call('project.create', { name: 'logger-failed' }, key())).status).toBe(
      'completed'
    )
    expect(
      AccessResponseSchema.safeParse(await call('project.get', { projectId: p.id })).success
    ).toBe(true)
  })

  it('serves actual local IPC and fails closed when the application is unavailable', async () => {
    server = await startLocalAccessServer({
      dataDirectory: directory,
      appVersion: 'test',
      activeProjectId: () => null
    })
    const response = await callLocalOperation(
      'project.create',
      { input: { name: 'through-transport' }, idempotencyKey: key() },
      directory
    )
    expect(response.status).toBe('completed')
    expect(((await call('project.list')).data as any).total).toBe(1)
    expect(JSON.stringify(events)).not.toContain('through-transport')
    expect(
      (await callLocalOperation('app.status', { input: {} }, join(directory, 'absent'))).error?.code
    ).toBe('APP_NOT_RUNNING')
  })

  it('refuses unauthenticated and stale-instance transport messages before business dispatch', async () => {
    server = await startLocalAccessServer({
      dataDirectory: directory,
      appVersion: 'test',
      activeProjectId: () => null
    })
    const descriptor = JSON.parse(
      readFileSync(join(directory, 'agent-access', 'connection.json'), 'utf8')
    )
    for (const changed of [{ token: 'bad' }, { instanceId: randomUUID() }]) {
      const reply = await new Promise<string>((resolveReply, reject) => {
        const socket = createConnection(descriptor.endpoint)
        let received = ''
        socket.setTimeout(3000, () => {
          socket.destroy()
          reject(new Error('AUTH_TIMEOUT'))
        })
        socket.on('connect', () =>
          socket.write(
            JSON.stringify({
              token: descriptor.token,
              instanceId: descriptor.instanceId,
              ...changed,
              request: {
                apiVersion: 1,
                operationVersion: 1,
                operationId: 'project.create',
                requestId: randomUUID(),
                expectedDataStoreId: descriptor.dataStoreId,
                idempotencyKey: key(),
                input: { name: 'unauthorized' }
              }
            }) + '\n'
          )
        )
        socket.on('data', (chunk) => {
          received += chunk
        })
        socket.on('error', () => {})
        socket.on('close', () => resolveReply(received))
      })
      expect(reply).toBe('')
    }
    expect(((await call('project.list')).data as any).total).toBe(0)
    expect(events.some((e) => e.attributes?.operation === 'project.create')).toBe(false)
  })

  it('never starts a mutation if receipt admission fails and never replays a lost final receipt', async () => {
    getDb().exec(
      "CREATE TRIGGER deny_access_admission BEFORE INSERT ON local_agent_operations BEGIN SELECT RAISE(ABORT,'test'); END;"
    )
    expect((await call('project.create', { name: 'not-created' }, key())).status).toBe('failed')
    expect(((await call('project.list')).data as any).total).toBe(0)
    getDb().exec('DROP TRIGGER deny_access_admission')
    getDb().exec(
      "CREATE TRIGGER deny_access_receipt BEFORE UPDATE ON local_agent_operations BEGIN SELECT RAISE(ABORT,'test'); END;"
    )
    const same = key()
    expect((await call('project.create', { name: 'created-once' }, same)).status).toBe('unknown')
    expect((await call('project.create', { name: 'created-once' }, same)).status).toBe('unknown')
    expect(((await call('project.list')).data as any).total).toBe(1)
    getDb().exec('DROP TRIGGER deny_access_receipt')
  })

  it('blocks stale generated contracts and unacknowledged protected-source changes', async () => {
    const snapshot = JSON.parse(
      readFileSync('docs/local-agent-access/generated/contracts.json', 'utf8')
    )
    snapshot.operations.pop()
    const stale = join(directory, 'stale-contract.json')
    writeFileSync(stale, JSON.stringify(snapshot))
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['scripts/check-agent-access.cjs', ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 15000
      })
    const staleResult = run(['--snapshot-file', stale])
    expect(staleResult.status).not.toBe(0)
    expect(staleResult.stderr).toContain('Generated contract is stale')
    const impact = join(directory, 'missing-impact.json')
    writeFileSync(
      impact,
      JSON.stringify({ reason: 'test missing source acknowledgement', sourceHashes: {} })
    )
    const missing = run(['--impact-file', impact])
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('Protected source changed')
  })

  it('clones a closed project at a fixed version without touching the source', async () => {
    const p = createProject('clone-source')
    saveProject({
      id: p.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [{ id: 'n', type: 'json', params: { text: '{"keep":true}', config: {} } }],
        edges: [],
        groups: []
      }
    })
    const cloneKey = key()
    const cloned = await call(
      'project.clone',
      { projectId: p.id, expectedGraphVersion: 1, name: 'clone-target' },
      cloneKey
    )
    expect(cloned.status).toBe('completed')
    expect((cloned.data as any).meta).toMatchObject({ name: 'clone-target', graphVersion: 0 })
    expect((cloned.data as any).saved).toBe(true)
    expect((cloned.data as any).meta.id).not.toBe(p.id)
    expect(
      (
        await call(
          'project.clone',
          { projectId: p.id, expectedGraphVersion: 1, name: 'clone-target' },
          cloneKey
        )
      ).data
    ).toEqual(cloned.data)
    const source = openProject(p.id)!
    expect(source.meta.graphVersion).toBe(1)
    expect((source.nodes[0].params as any).text).toBe('{"keep":true}')
    const copy = openProject((cloned.data as any).meta.id)!
    expect(copy.nodes[0].id).not.toBe('n')
    expect((copy.nodes[0].params as any).text).toBe('{"keep":true}')
    expect(
      (await call('project.clone', { projectId: p.id, expectedGraphVersion: 0, name: 'stale' }, key())).error
        ?.code
    ).toBe('REVISION_CONFLICT')
    expect(
      (await call('project.clone', { projectId: 'missing', expectedGraphVersion: 0, name: 'x' }, key())).error
        ?.code
    ).toBe('NOT_FOUND')
  })

  it('clones an active source only after the flush handshake and never logs its text', async () => {
    const p = createProject('active-clone')
    active = p.id
    let flushed = 0
    withDesktop({
      run: async (request) => {
        expect(request.action).toBe('flush')
        const saved = saveProject({
          id: p.id,
          expectedGraphVersion: openProject(p.id)!.meta.graphVersion,
          graph: {
            nodes: [{ id: 'draft', type: 'text', params: { text: 'private flush clone' } }],
            edges: [],
            groups: []
          }
        })!
        flushed++
        return saved.graphVersion
      }
    })
    const cloned = await call(
      'project.clone',
      { projectId: p.id, expectedGraphVersion: 0, name: 'active-clone-copy' },
      key()
    )
    expect(cloned.status).toBe('completed')
    expect(flushed).toBe(1)
    const copy = openProject((cloned.data as any).meta.id)!
    expect((copy.nodes[0].params as any).text).toBe('private flush clone')
    expect(copy.meta.graphVersion).toBe(0)
    expect(JSON.stringify(events)).not.toContain('private flush clone')
  })

  it('prechecks delete impact and withholds tokens for occupied targets', async () => {
    const closed = createProject('precheck-closed')
    saveProject({
      id: closed.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [{ id: 'n', type: 'json', params: { text: '{}', config: {} } }],
        edges: [],
        groups: []
      }
    })
    const pre = await call('project.delete.precheck', { projectId: closed.id })
    expect(pre.status).toBe('completed')
    expect(pre.data).toMatchObject({
      projectId: closed.id,
      graphVersion: 1,
      blockers: [],
      impact: { nodeCount: 1, edgeCount: 0, groupCount: 0, libraryUsageCount: 0 }
    })
    expect(typeof (pre.data as any).impactToken).toBe('string')
    expect((pre.data as any).expiresAt).toBeGreaterThan(Date.now())
    const busy = createProject('precheck-busy')
    getDb()
      .prepare(
        'INSERT INTO flow_coordination_runs(project_id,node_id,task_id,body_json) VALUES (?,?,?,?)'
      )
      .run(busy.id, 'node', 'task', '{}')
    getDb()
      .prepare('INSERT INTO flow_coordination_scope(project_id,node_id,task_id) VALUES (?,?,?)')
      .run(busy.id, 'node', 'task')
    const busyPre = await call('project.delete.precheck', { projectId: busy.id })
    expect((busyPre.data as any).blockers).toEqual(['TASK_OCCUPANCY'])
    expect((busyPre.data as any).impactToken).toBeUndefined()
  })

  it('rejects delete without a token, with a forged token and after fact drift', async () => {
    const p = createProject('delete-guarded')
    saveProject({
      id: p.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [{ id: 'n', type: 'json', params: { text: '{}', config: {} } }],
        edges: [],
        groups: []
      }
    })
    expect(
      (await call('project.delete', { projectId: p.id }, key())).error?.code
    ).toBe('IMPACT_CONFIRM_REQUIRED')
    expect(
      (
        await call(
          'project.delete',
          { projectId: p.id, impactToken: `${'9'.repeat(13)}.${'0'.repeat(64)}` },
          key()
        )
      ).error?.code
    ).toBe('IMPACT_TOKEN_INVALID')
    const pre = await call('project.delete.precheck', { projectId: p.id })
    saveProject({ id: p.id, expectedGraphVersion: 1, graph: { nodes: [], edges: [], groups: [] } })
    expect(
      (
        await call(
          'project.delete',
          { projectId: p.id, impactToken: (pre.data as any).impactToken },
          key()
        )
      ).error?.code
    ).toBe('IMPACT_TOKEN_INVALID')
    expect(openProject(p.id)).not.toBeNull()
    const deletes = events.filter(
      (e) => e.event === 'agent.access.started' && e.attributes?.operation === 'project.delete'
    )
    expect(deletes.length).toBe(3)
    for (const start of deletes)
      expect(
        events.filter(
          (e) =>
            e.traceId === start.traceId &&
            ['agent.access.completed', 'agent.access.failed', 'agent.access.unknown'].includes(
              e.event
            )
        ).length
      ).toBe(1)
  })

  it('deletes a confirmed project, keeps receipts and never touches same-named projects', async () => {
    const p = createProject('delete-me')
    saveProject({
      id: p.id,
      expectedGraphVersion: 0,
      graph: {
        nodes: [{ id: 'n', type: 'json', params: { text: '{}', config: {} } }],
        edges: [],
        groups: []
      }
    })
    const pre = await call('project.delete.precheck', { projectId: p.id })
    const deleteKey = key()
    const deleted = await call(
      'project.delete',
      { projectId: p.id, impactToken: (pre.data as any).impactToken },
      deleteKey
    )
    expect(deleted.status).toBe('completed')
    expect(deleted.data).toEqual({ deleted: true, projectId: p.id, graphVersion: 1 })
    expect(openProject(p.id)).toBeNull()
    expect(existsSync(join(directory, 'projects', p.id))).toBe(false)
    const replay = await call(
      'project.delete',
      { projectId: p.id, impactToken: (pre.data as any).impactToken },
      deleteKey
    )
    expect(replay.data).toEqual(deleted.data)
    expect(
      (await call('project.delete.precheck', { projectId: p.id })).error?.code
    ).toBe('NOT_FOUND')
    const namesake = createProject('delete-me')
    expect(openProject(namesake.id)).not.toBeNull()
    expect(namesake.id).not.toBe(p.id)
  })

  it('never deletes the open desktop project regardless of tokens', async () => {
    const p = createProject('open-stays')
    active = p.id
    withDesktop({
      run: async () => {
        throw new Error('delete must not run a desktop handshake')
      }
    })
    const pre = await call('project.delete.precheck', { projectId: p.id })
    expect((pre.data as any).blockers).toContain('ACTIVE_PROJECT')
    expect((pre.data as any).impactToken).toBeUndefined()
    expect(
      (await call('project.delete', { projectId: p.id, impactToken: 'x' }, key())).error?.phase
    ).toBe('desktop-ownership')
    expect(openProject(p.id)).not.toBeNull()
    expect(existsSync(join(directory, 'projects', p.id))).toBe(true)
  })
})
