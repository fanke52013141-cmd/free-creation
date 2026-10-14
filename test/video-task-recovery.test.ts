import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { ProviderConfig } from '../src/shared/types'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import {
  cancelVideoTask,
  controlVideoTask,
  getVideoTask,
  submitVideoTask
} from '../src/main/gateway/video'
import { queryArkTask } from '../src/main/gateway/video-task-control'

const fixture = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  provider: null as unknown as ProviderConfig,
  directory: '',
  saved: 0
}))
vi.mock('../src/main/store/db', () => ({
  getDb: () => fixture.db,
  getDataDir: () => fixture.directory
}))
vi.mock('../src/main/gateway/providers.repo', () => ({ getProvider: () => fixture.provider }))
vi.mock('../src/main/store/media.repo', () => ({
  readMediaBuffer: vi.fn(),
  saveFileAsset: vi.fn(async () => {
    fixture.saved++
    fixture.db.prepare('INSERT INTO media VALUES (?,?)').run('media', 'projects/video.mp4')
    return { id: 'media', path: 'projects/video.mp4' }
  })
}))
const events: unknown[] = []
beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'canvas-video-recovery-'))
  fixture.db = new Database(':memory:')
  fixture.db.exec(`CREATE TABLE tasks (id TEXT, provider_id TEXT, model_id TEXT, node_id TEXT,
    project_id TEXT, kind TEXT, status TEXT, input TEXT, output TEXT, error TEXT, created_at INTEGER, updated_at INTEGER, attempts INTEGER DEFAULT 0);
    CREATE TABLE media (id TEXT PRIMARY KEY, path TEXT, kind TEXT, mime TEXT, size_bytes INTEGER, created_at INTEGER, name TEXT);`)
  fixture.provider = {
    id: 'provider',
    name: 'test',
    specId: 'seedance',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'private-test-key',
    models: [],
    createdAt: 0
  }
  fixture.saved = 0
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  setGatewayEventSink(null)
  fixture.db.close()
  if (
    resolve(fixture.directory, '..') !== resolve(tmpdir()) ||
    !basename(fixture.directory).startsWith('canvas-video-recovery-')
  )
    throw new Error('CLEANUP_REJECTED')
  rmSync(fixture.directory, { recursive: true, force: true })
})
function seed(patch: Record<string, unknown> = {}) {
  const state = {
    prompt: 'private-material',
    mode: 'text',
    referenceImageMediaIds: [],
    referenceVideoMediaIds: [],
    referenceAudioMediaIds: [],
    upstreamTaskId: 'remote-1',
    connection: {
      specId: fixture.provider.specId,
      baseURL: fixture.provider.baseURL.toLowerCase()
    },
    credentialHash: createHash('sha256').update(fixture.provider.apiKey).digest('hex'),
    ...patch
  }
  fixture.db
    .prepare(
      'INSERT INTO tasks (id,provider_id,model_id,node_id,project_id,kind,status,input,output,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      'local',
      'provider',
      'model',
      'node',
      'project',
      'video',
      'unknown',
      JSON.stringify(state),
      null,
      null,
      0,
      0
    )
}
function response(state: string, id = 'remote-1') {
  return new Response(
    JSON.stringify({
      id,
      status: state,
      content: { video_url: 'https://media.example/video.mp4' }
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}
describe('C4 supplier facts and conditional cancellation', () => {
  it('stopping before the submit reply preserves the later task ID without publishing success', async () => {
    let release!: (value: Response) => void
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            release = done
          })
      )
      .mockResolvedValue(response('succeeded'))
    vi.stubGlobal('fetch', fetcher)
    const input = {
      projectId: 'project',
      nodeId: 'node',
      providerId: 'provider',
      modelId: 'doubao-seedance-2-0',
      prompt: 'private-material'
    }
    const send = vi.fn()
    const submitted = submitVideoTask(send, input)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await cancelVideoTask(submitted.taskId)
    release(new Response(JSON.stringify({ id: 'remote-1' })))
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getVideoTask(submitted.taskId)?.status).toBe('unknown'))
    expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(0)
    expect(send.mock.calls.some((call) => call[0].kind === 'video-done')).toBe(false)
  })
  it('ambiguous submission remains occupied and identical retry never creates another remote task', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('accepted but connection lost'))
    vi.stubGlobal('fetch', fetcher)
    const input = {
      projectId: 'project',
      nodeId: 'node',
      providerId: 'provider',
      modelId: 'doubao-seedance-2-0',
      prompt: 'private-material'
    }
    const submitted = submitVideoTask(() => {}, input)
    await vi.waitFor(() => expect(getVideoTask(submitted.taskId)?.status).toBe('unknown'))
    expect(submitVideoTask(() => {}, input)).toEqual(submitted)
    expect((await controlVideoTask(submitted.taskId))?.status).toBe('unknown')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1].method).toBe('POST')
  })
  it('local stop does not treat queued as cancelled or risk deleting terminal records', async () => {
    seed()
    const fetcher = vi.fn().mockResolvedValueOnce(response('queued'))
    vi.stubGlobal('fetch', fetcher)
    await expect(cancelVideoTask('local')).resolves.toBe(true)
    expect(getVideoTask('local')?.status).toBe('unknown')
    expect(fetcher.mock.calls.map((call) => call[1].method ?? 'GET')).toEqual(['GET'])
    expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(0)
  })
  it.each(['running', 'succeeded', 'failed', 'cancelled'])(
    'does not DELETE a task observed as %s',
    async (state) => {
      const fetcher = vi.fn().mockResolvedValue(response(state))
      vi.stubGlobal('fetch', fetcher)
      expect((await queryArkTask(fixture.provider, 'remote-1')).state).toBe(state)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
  it.each(['404', 'disconnect', 'identity', 'status', 'missing-url'])(
    'keeps %s evidence unknown',
    async (failure) => {
      seed()
      const fetcher = vi.fn(async () => {
        if (failure === 'disconnect') throw new Error('private-test-key private-material')
        if (failure === '404') return new Response('{}', { status: 404 })
        if (failure === 'identity') return response('cancelled', 'wrong-task')
        if (failure === 'missing-url')
          return new Response(JSON.stringify({ id: 'remote-1', status: 'succeeded' }))
        return response('new-provider-status')
      })
      vi.stubGlobal('fetch', fetcher)
      expect((await controlVideoTask('local'))?.status).toBe('unknown')
      expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(
        0
      )
      expect(JSON.stringify(events)).not.toMatch(/private-test-key|private-material|media\.example/)
    }
  )
  it('confirms cancellation only from authoritative supplier state', async () => {
    seed()
    const fetcher = vi.fn().mockResolvedValueOnce(response('cancelled'))
    vi.stubGlobal('fetch', fetcher)
    await cancelVideoTask('local')
    expect(getVideoTask('local')?.status).toBe('cancelled')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(['credential', 'connection', 'missing-id', 'legacy', 'proxy'])(
    'does not contact a supplier with %s drift or missing authority',
    async (failure) => {
      seed(
        failure === 'missing-id'
          ? { upstreamTaskId: undefined }
          : failure === 'legacy'
            ? { credentialHash: undefined }
            : {}
      )
      if (failure === 'credential') fixture.provider.apiKey = 'changed'
      if (failure === 'connection') fixture.provider.baseURL = 'https://other.example/api/v3'
      if (failure === 'proxy') fixture.provider.specId = 'minimax'
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      expect((await controlVideoTask('local'))?.status).toBe('unknown')
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it('reattaches the identical unknown task; changed input cannot submit', () => {
    seed()
    const input = {
      projectId: 'project',
      nodeId: 'node',
      providerId: 'provider',
      modelId: 'model',
      prompt: 'private-material'
    }
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    expect(() => submitVideoTask(() => {}, { ...input, prompt: 'changed' })).toThrow(
      '原任务结果未知'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('coalesces successful reconciliation, downloads once and commits one media', async () => {
    seed()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('media.example')
          ? new Response(new Uint8Array([1, 2, 3]))
          : response('succeeded')
      )
    )
    const first = controlVideoTask('local'),
      second = controlVideoTask('local')
    expect(first).toBe(second)
    expect((await first)?.status).toBe('success')
    await controlVideoTask('local')
    expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(1)
  })
  it('logger failure does not change supplier facts', async () => {
    seed()
    setGatewayEventSink({
      emit: () => {
        throw new Error('LOGGER_DOWN')
      }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('cancelled')))
    expect((await controlVideoTask('local'))?.status).toBe('cancelled')
  })
  it('stop during a delayed query prevents late success from downloading', async () => {
    seed()
    let release!: (value: Response) => void
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            release = done
          })
      )
      .mockResolvedValue(response('succeeded'))
    vi.stubGlobal('fetch', fetcher)
    const query = controlVideoTask('local')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const stop = cancelVideoTask('local')
    release(response('succeeded'))
    await query
    await stop
    expect(getVideoTask('local')?.status).toBe('unknown')
    expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(0)
    expect(fetcher.mock.calls.every((call) => !call[1].method)).toBe(true)
  })
  it('persisted stop survives loss of process memory and requires explicit reattachment', async () => {
    seed({ cancelRequested: true })
    const fetcher = vi.fn().mockResolvedValue(response('succeeded'))
    vi.stubGlobal('fetch', fetcher)
    expect((await controlVideoTask('local'))?.status).toBe('unknown')
    expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(0)
    submitVideoTask(() => {}, {
      projectId: 'project',
      nodeId: 'node',
      providerId: 'provider',
      modelId: 'model',
      prompt: 'private-material'
    })
    fetcher.mockImplementation(async (url: string) =>
      url.includes('media.example') ? new Response(new Uint8Array([1])) : response('succeeded')
    )
    expect((await controlVideoTask('local'))?.status).toBe('success')
    expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(1)
  })
  it('credential drift during query prevents applying an otherwise terminal fact', async () => {
    seed()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fixture.provider.apiKey = 'changed'
        return response('cancelled')
      })
    )
    expect((await controlVideoTask('local'))?.status).toBe('unknown')
  })
  it('stop during a delayed download prevents result publication and keeps occupancy', async () => {
    seed()
    let release!: (value: Response) => void
    let started!: () => void
    const downloading = new Promise<void>((done) => {
      started = done
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.includes('media.example')) return response('succeeded')
        started()
        return new Promise<Response>((done) => {
          release = done
        })
      })
    )
    const work = controlVideoTask('local')
    await downloading
    const stop = cancelVideoTask('local')
    release(new Response(new Uint8Array([1])))
    await work
    await stop
    expect(getVideoTask('local')?.status).toBe('unknown')
    expect((fixture.db.prepare('SELECT count(*) AS n FROM media').get() as { n: number }).n).toBe(0)
  })
  it('rejects task path injection without a request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await queryArkTask(fixture.provider, '../foreign')).toEqual({ state: 'unknown' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses real HTTP transport for terminal query and emits a paired redacted lifecycle', async () => {
    seed()
    const observed: string[] = []
    const server = createServer((request, reply) => {
      observed.push(`${request.method} ${request.url}`)
      reply.setHeader('Content-Type', 'application/json')
      reply.end(JSON.stringify({ id: 'remote-1', status: 'cancelled' }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('SERVER_ADDRESS_INVALID')
    const transport = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
      transport(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init)
    )
    try {
      expect((await controlVideoTask('local'))?.status).toBe('cancelled')
      expect(observed).toEqual(['GET /api/v3/contents/generations/tasks/remote-1'])
      const lifecycle = events as Array<{ event: string; traceId: string; status?: string }>
      const start = lifecycle.filter((event) => event.event === 'task.control.started')
      const end = lifecycle.filter((event) => event.event === 'task.control.completed')
      expect(start).toHaveLength(1)
      expect(end).toHaveLength(1)
      expect(end[0].traceId).toBe(start[0].traceId)
      expect(end[0].status).toBe('success')
      expect(JSON.stringify(events)).not.toMatch(/private-test-key|private-material|http/)
    } finally {
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      )
    }
  })
})
