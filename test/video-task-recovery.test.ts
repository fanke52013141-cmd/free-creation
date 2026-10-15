import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
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
import { readMediaBuffer } from '../src/main/store/media.repo'
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
    CREATE TABLE media (id TEXT PRIMARY KEY, path TEXT, kind TEXT, mime TEXT, size_bytes INTEGER, created_at INTEGER, name TEXT);
    CREATE TABLE process_locks (resource TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL);`)
  fixture.db.exec(
    `CREATE TABLE flow_commands (project_id TEXT, command_id TEXT, lease_id TEXT, admitted INTEGER, state TEXT, command_json TEXT, target_node_id TEXT);`
  )
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
function bindFlowCommand(admitted = 1) {
  const command = {
    schemaVersion: 1,
    kind: 'node.execute',
    projectId: 'project',
    commandId: 'command',
    taskId: 'agent-task',
    agentNodeId: 'agent',
    targetNodeId: 'node',
    contractVersion: 7,
    expectedSemanticRevision: `sha256:${'a'.repeat(64)}`,
    inputs: [],
    traceId: 'trace',
    spanId: 'span'
  }
  fixture.db
    .prepare("INSERT INTO flow_commands VALUES ('project','command','lease',?,'pending',?,'node')")
    .run(admitted, JSON.stringify(command))
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
  it.each(['unknown', 'success', 'failed', 'cancelled'])(
    'an admitted Agent command reuses its %s video task without POST',
    (status) => {
      seed({ flowCommandId: 'command', cancelRequested: true })
      fixture.db.prepare("UPDATE tasks SET status=? WHERE id='local'").run(status)
      bindFlowCommand()
      const fetcher = vi.fn(() => {
        throw new Error('POST_FORBIDDEN')
      })
      vi.stubGlobal('fetch', fetcher)
      const result = submitVideoTask(() => {}, {
        projectId: 'project',
        nodeId: 'node',
        providerId: 'provider',
        modelId: 'model',
        prompt: 'private-material',
        mode: 'text',
        flowCommand: { projectId: 'project', commandId: 'command', leaseId: 'lease' }
      })
      expect(result).toEqual({ taskId: 'local' })
      expect(fetcher).not.toHaveBeenCalled()
      expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    }
  )
  it('rejects an unadmitted/forged Agent lease and changed fixed request before side effects', () => {
    seed({ flowCommandId: 'command' })
    bindFlowCommand(0)
    const input = {
      projectId: 'project',
      nodeId: 'node',
      providerId: 'provider',
      modelId: 'model',
      prompt: 'private-material',
      mode: 'text' as const,
      flowCommand: { projectId: 'project', commandId: 'command', leaseId: 'lease' }
    }
    expect(() => submitVideoTask(() => {}, input)).toThrow('视频命令未获准执行')
    fixture.db.prepare('UPDATE flow_commands SET admitted=1').run()
    expect(() => submitVideoTask(() => {}, { ...input, prompt: 'changed' })).toThrow(
      '原视频命令输入发生变化'
    )
    expect(() =>
      submitVideoTask(() => {}, { ...input, referenceImageMediaIds: ['foreign'] })
    ).toThrow('Agent 视频支持文本、提示词包、固定首尾帧及有序图片、视频和音频参考')
    const stored = fixture.db.prepare('SELECT command_json FROM flow_commands').get() as {
      command_json: string
    }
    fixture.db
      .prepare('UPDATE flow_commands SET command_json=?')
      .run(JSON.stringify({ ...JSON.parse(stored.command_json), contractVersion: 1 }))
    expect(() => submitVideoTask(() => {}, input)).toThrow('视频命令未获准执行')
  })
  function firstFrameInput() {
    bindFlowCommand()
    const bytes = Buffer.from('fixed-frame'),
      path = 'projects/project/media/frame.png'
    mkdirSync(join(fixture.directory, 'projects/project/media'), { recursive: true })
    writeFileSync(join(fixture.directory, path), bytes)
    fixture.db
      .prepare('INSERT INTO media(id,path,kind,mime,size_bytes,created_at) VALUES (?,?,?,?,?,0)')
      .run('frame', path, 'image', 'image/png', bytes.length)
    fixture.db.exec(
      'CREATE TABLE flow_asset_versions (project_id TEXT,version_id TEXT,asset_id TEXT,node_id TEXT,port_id TEXT,value_json TEXT,digest TEXT)'
    )
    const value = JSON.stringify({
      kind: 'image',
      mediaId: 'frame',
      mediaPath: path,
      mime: 'image/png',
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    })
    fixture.db
      .prepare('INSERT INTO flow_asset_versions VALUES (?,?,?,?,?,?,?)')
      .run(
        'project',
        'version',
        'asset',
        'source',
        'out-image',
        value,
        createHash('sha256').update(value).digest('hex')
      )
    const row = fixture.db.prepare('SELECT command_json FROM flow_commands').get() as {
      command_json: string
    }
    fixture.db.prepare('UPDATE flow_commands SET command_json=?').run(
      JSON.stringify({
        ...JSON.parse(row.command_json),
        inputs: [
          {
            targetPortId: 'in-images',
            assets: [
              {
                assetId: 'asset',
                versionId: 'version',
                sourceNodeId: 'source',
                sourcePortId: 'out-image'
              }
            ]
          }
        ]
      })
    )
    return {
      projectId: 'project',
      nodeId: 'node',
      providerId: 'provider',
      modelId: 'model',
      prompt: 'private-material',
      mode: 'first-frame' as const,
      firstFrameMediaId: 'frame',
      flowCommand: { projectId: 'project', commandId: 'command', leaseId: 'lease' }
    }
  }
  it('recovers the fixed first-frame task without POST and rejects replacement bytes or media IDs', () => {
    seed({ flowCommandId: 'command', mode: 'first-frame', firstFrameMediaId: 'frame' })
    const input = firstFrameInput(),
      fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    expect(() => submitVideoTask(() => {}, { ...input, firstFrameMediaId: 'foreign' })).toThrow(
      '不匹配固定媒体版本'
    )
    writeFileSync(join(fixture.directory, 'projects/project/media/frame.png'), 'other-frame')
    expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_IMAGE_CHANGED')
    expect(fetcher).not.toHaveBeenCalled()
    expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })
  function twoFrameInput() {
    const input = firstFrameInput()
    const bytes = Buffer.from('fixed--tail'),
      path = 'projects/project/media/tail.png'
    writeFileSync(join(fixture.directory, path), bytes)
    fixture.db
      .prepare('INSERT INTO media(id,path,kind,mime,size_bytes,created_at) VALUES (?,?,?,?,?,0)')
      .run('tail', path, 'image', 'image/png', bytes.length)
    const value = JSON.stringify({
      kind: 'image',
      mediaId: 'tail',
      mediaPath: path,
      mime: 'image/png',
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    })
    fixture.db
      .prepare('INSERT INTO flow_asset_versions VALUES (?,?,?,?,?,?,?)')
      .run(
        'project',
        'tail-version',
        'tail-asset',
        'tail-source',
        'out-image',
        value,
        createHash('sha256').update(value).digest('hex')
      )
    const row = fixture.db.prepare('SELECT command_json FROM flow_commands').get() as {
      command_json: string
    }
    const command = JSON.parse(row.command_json)
    command.inputs[0].assets.push({
      assetId: 'tail-asset',
      versionId: 'tail-version',
      sourceNodeId: 'tail-source',
      sourcePortId: 'out-image'
    })
    fixture.db.prepare('UPDATE flow_commands SET command_json=?').run(JSON.stringify(command))
    return { ...input, mode: 'first-last-frame' as const, lastFrameMediaId: 'tail' }
  }
  it('recovers both ordered frames without POST; swap, tail replacement and missing tail remain blocked', () => {
    seed({
      flowCommandId: 'command',
      mode: 'first-last-frame',
      firstFrameMediaId: 'frame',
      lastFrameMediaId: 'tail'
    })
    const input = twoFrameInput(),
      fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    expect(() =>
      submitVideoTask(() => {}, { ...input, firstFrameMediaId: 'tail', lastFrameMediaId: 'frame' })
    ).toThrow('不匹配固定媒体版本')
    expect(() => submitVideoTask(() => {}, { ...input, lastFrameMediaId: 'foreign' })).toThrow(
      '不匹配固定媒体版本'
    )
    writeFileSync(join(fixture.directory, 'projects/project/media/tail.png'), 'other--tail')
    expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_IMAGE_CHANGED')
    unlinkSync(join(fixture.directory, 'projects/project/media/tail.png'))
    expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_IMAGE_CHANGED')
    expect(fetcher).not.toHaveBeenCalled()
    expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })
  function referenceInput() {
    const { firstFrameMediaId: _first, lastFrameMediaId: _last, ...input } = twoFrameInput()
    return {
      ...input,
      modelId: 'doubao-seedance-2-0',
      mode: 'reference' as const,
      referenceImageMediaIds: ['frame', 'tail']
    }
  }
  function motionInput(withImage = false) {
    const { firstFrameMediaId: _first, ...input } = firstFrameInput()
    const bytes = Buffer.from('motion-bytes'),
      path = 'projects/project/media/motion.mp4'
    writeFileSync(join(fixture.directory, path), bytes)
    fixture.db
      .prepare('INSERT INTO media(id,path,kind,mime,size_bytes,created_at) VALUES (?,?,?,?,?,0)')
      .run('motion', path, 'video', 'video/mp4', bytes.length)
    const value = JSON.stringify({
      kind: 'video',
      mediaId: 'motion',
      mediaPath: path,
      mime: 'video/mp4',
      contentSha256: createHash('sha256').update(bytes).digest('hex')
    })
    fixture.db
      .prepare('INSERT INTO flow_asset_versions VALUES (?,?,?,?,?,?,?)')
      .run(
        'project',
        'motion-version',
        'motion-asset',
        'motion-source',
        'out-video',
        value,
        createHash('sha256').update(value).digest('hex')
      )
    const row = fixture.db.prepare('SELECT command_json FROM flow_commands').get() as {
      command_json: string
    }
    const command = JSON.parse(row.command_json)
    if (!withImage) command.inputs = []
    command.inputs.push({
      targetPortId: 'in-reference-video',
      assets: [
        {
          assetId: 'motion-asset',
          versionId: 'motion-version',
          sourceNodeId: 'motion-source',
          sourcePortId: 'out-video'
        }
      ]
    })
    fixture.db.prepare('UPDATE flow_commands SET command_json=?').run(JSON.stringify(command))
    return {
      ...input,
      modelId: 'doubao-seedance-2-0',
      mode: 'reference' as const,
      referenceVideoMediaIds: ['motion'],
      ...(withImage ? { referenceImageMediaIds: ['frame'] } : {})
    }
  }
  function audioInput(withImage = false) {
    const { referenceVideoMediaIds: _video, ...input } = motionInput(withImage)
    const path = 'projects/project/media/motion.wav'
    writeFileSync(join(fixture.directory, path), 'audio--bytes')
    fixture.db
      .prepare("UPDATE media SET kind='audio',mime='audio/wav',path=? WHERE id='motion'")
      .run(path)
    const value = JSON.stringify({
      kind: 'audio',
      mediaId: 'motion',
      mediaPath: path,
      mime: 'audio/wav',
      contentSha256: createHash('sha256').update('audio--bytes').digest('hex')
    })
    fixture.db
      .prepare(
        "UPDATE flow_asset_versions SET port_id='out-audio',value_json=?,digest=? WHERE version_id='motion-version'"
      )
      .run(value, createHash('sha256').update(value).digest('hex'))
    const row = fixture.db.prepare('SELECT command_json FROM flow_commands').get() as {
      command_json: string
    }
    const command = JSON.parse(row.command_json)
    const audio = command.inputs.find(
      (item: { targetPortId: string }) => item.targetPortId === 'in-reference-video'
    )
    audio.targetPortId = 'in-reference-audio'
    audio.assets[0].sourcePortId = 'out-audio'
    fixture.db.prepare('UPDATE flow_commands SET command_json=?').run(JSON.stringify(command))
    return { ...input, referenceAudioMediaIds: ['motion'] }
  }
  it.each(['video', 'audio'] as const)(
    'resumes ordered distinct %s references and rejects swapping, duplication or changed bytes before POST',
    (kind) => {
      const input = kind === 'video' ? motionInput() : audioInput()
      const extension = kind === 'video' ? 'mp4' : 'wav'
      const mediaPath = `projects/project/media/second.${extension}`
      const bytes = Buffer.from('second-fixed-reference')
      writeFileSync(join(fixture.directory, mediaPath), bytes)
      fixture.db
        .prepare('INSERT INTO media(id,path,kind,mime,size_bytes,created_at) VALUES (?,?,?,?,?,0)')
        .run(
          'motion-second',
          mediaPath,
          kind,
          kind === 'video' ? 'video/mp4' : 'audio/wav',
          bytes.length
        )
      const value = JSON.stringify({
        kind,
        mediaId: 'motion-second',
        mediaPath,
        mime: kind === 'video' ? 'video/mp4' : 'audio/wav',
        contentSha256: createHash('sha256').update(bytes).digest('hex')
      })
      fixture.db
        .prepare('INSERT INTO flow_asset_versions VALUES (?,?,?,?,?,?,?)')
        .run(
          'project',
          'motion-second-version',
          'motion-second-asset',
          'motion-second-source',
          `out-${kind}`,
          value,
          createHash('sha256').update(value).digest('hex')
        )
      const row = fixture.db.prepare('SELECT command_json FROM flow_commands').get() as {
        command_json: string
      }
      const command = JSON.parse(row.command_json)
      command.inputs
        .find((item: { targetPortId: string }) => item.targetPortId === `in-reference-${kind}`)
        .assets.push({
          assetId: 'motion-second-asset',
          versionId: 'motion-second-version',
          sourceNodeId: 'motion-second-source',
          sourcePortId: `out-${kind}`
        })
      fixture.db.prepare('UPDATE flow_commands SET command_json=?').run(JSON.stringify(command))
      const field = kind === 'video' ? 'referenceVideoMediaIds' : 'referenceAudioMediaIds'
      const ordered = { ...input, [field]: ['motion', 'motion-second'] }
      seed({ flowCommandId: 'command', mode: 'reference', [field]: ordered[field] })
      fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      expect(submitVideoTask(() => {}, ordered)).toEqual({ taskId: 'local' })
      for (const ids of [['motion-second', 'motion'], ['motion', 'motion'], ['motion']])
        expect(() => submitVideoTask(() => {}, { ...ordered, [field]: ids })).toThrow()
      writeFileSync(join(fixture.directory, mediaPath), 'changed-second-reference')
      expect(() => submitVideoTask(() => {}, ordered)).toThrow(
        kind === 'video' ? 'ASSET_VIDEO_CHANGED' : 'ASSET_AUDIO_CHANGED'
      )
      expect(fetcher).not.toHaveBeenCalled()
      expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    }
  )
  it.each([false, true])(
    'reattaches one fixed audio with image=%s and rejects changed or missing bytes before POST',
    (withImage) => {
      seed({
        flowCommandId: 'command',
        mode: 'reference',
        referenceAudioMediaIds: ['motion'],
        referenceImageMediaIds: withImage ? ['frame'] : []
      })
      const input = audioInput(withImage),
        fetcher = vi.fn()
      fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
      vi.stubGlobal('fetch', fetcher)
      expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
      for (const ids of [[], ['other'], ['motion', 'motion']])
        expect(() => submitVideoTask(() => {}, { ...input, referenceAudioMediaIds: ids })).toThrow()
      expect(() =>
        submitVideoTask(() => {}, { ...input, mode: 'first-frame', firstFrameMediaId: 'frame' })
      ).toThrow()
      writeFileSync(join(fixture.directory, 'projects/project/media/motion.wav'), 'other--bytes')
      expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_AUDIO_CHANGED')
      unlinkSync(join(fixture.directory, 'projects/project/media/motion.wav'))
      expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_AUDIO_CHANGED')
      expect(fetcher).not.toHaveBeenCalled()
      expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    }
  )
  it('binds the original audio list and refuses unsupported model capability without POST', () => {
    seed({ flowCommandId: 'command', mode: 'reference', referenceAudioMediaIds: ['other'] })
    const input = audioInput()
    fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
    expect(() => submitVideoTask(() => {}, input)).toThrow('原视频命令输入发生变化')
    expect(() =>
      submitVideoTask(() => {}, { ...input, modelId: 'doubao-seedance-1-5-pro' })
    ).toThrow('不支持该参考媒体或数量')
  })
  it.each(['bytes', 'mime'] as const)(
    'checks actual asynchronously encoded audio %s before POST',
    async (changed) => {
      const input = audioInput()
      vi.mocked(readMediaBuffer).mockResolvedValueOnce({
        buf: Buffer.from(changed === 'bytes' ? 'other--bytes' : 'audio--bytes'),
        mime: changed === 'mime' ? 'audio/mpeg' : 'audio/wav'
      })
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      const result = submitVideoTask(() => {}, input)
      await vi.waitFor(() => expect(getVideoTask(result.taskId)?.status).toBe('unknown'))
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it('persists audio reference stop, and explicit resume attaches only the original task', async () => {
    seed({ flowCommandId: 'command', mode: 'reference', referenceAudioMediaIds: ['motion'] })
    const input = audioInput(),
      fetcher = vi.fn().mockResolvedValue(response('running'))
    fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
    vi.stubGlobal('fetch', fetcher)
    await cancelVideoTask('local')
    expect(
      JSON.parse(
        (fixture.db.prepare('SELECT input FROM tasks WHERE id=?').get('local') as { input: string })
          .input
      ).cancelRequested
    ).toBe(true)
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    expect(fetcher.mock.calls.every((call) => (call[1]?.method ?? 'GET') === 'GET')).toBe(true)
    expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })
  it.each([false, true])(
    'reattaches fixed video reference with image=%s and rejects identity/content drift without POST',
    (withImage) => {
      seed({
        flowCommandId: 'command',
        mode: 'reference',
        referenceVideoMediaIds: ['motion'],
        referenceImageMediaIds: withImage ? ['frame'] : []
      })
      const input = motionInput(withImage),
        fetcher = vi.fn()
      fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
      vi.stubGlobal('fetch', fetcher)
      expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
      expect(() =>
        submitVideoTask(() => {}, { ...input, referenceVideoMediaIds: ['other'] })
      ).toThrow('不匹配固定媒体版本')
      expect(() =>
        submitVideoTask(() => {}, { ...input, referenceVideoMediaIds: ['motion', 'motion'] })
      ).toThrow()
      expect(() =>
        submitVideoTask(() => {}, { ...input, referenceAudioMediaIds: ['audio'] })
      ).toThrow()
      writeFileSync(join(fixture.directory, 'projects/project/media/motion.mp4'), 'other--bytes')
      expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_VIDEO_CHANGED')
      unlinkSync(join(fixture.directory, 'projects/project/media/motion.mp4'))
      expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_VIDEO_CHANGED')
      expect(fetcher).not.toHaveBeenCalled()
      expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    }
  )
  it('rejects original video reference list drift and unsupported provider capability', () => {
    seed({ flowCommandId: 'command', mode: 'reference', referenceVideoMediaIds: ['other'] })
    const input = motionInput()
    fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
    expect(() => submitVideoTask(() => {}, input)).toThrow('原视频命令输入发生变化')
    expect(() =>
      submitVideoTask(() => {}, { ...input, modelId: 'doubao-seedance-1-5-pro' })
    ).toThrow('不支持该参考媒体或数量')
  })
  it('checks the actual asynchronously encoded video bytes before POST', async () => {
    const input = motionInput()
    vi.mocked(readMediaBuffer).mockResolvedValueOnce({
      buf: Buffer.from('other--bytes'),
      mime: 'video/mp4'
    })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = submitVideoTask(() => {}, input)
    await vi.waitFor(() => expect(getVideoTask(result.taskId)?.status).toBe('unknown'))
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('persists video reference stop and requires original task reattachment without POST', async () => {
    seed({ flowCommandId: 'command', mode: 'reference', referenceVideoMediaIds: ['motion'] })
    const input = motionInput(),
      fetcher = vi.fn().mockResolvedValue(response('running'))
    fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
    vi.stubGlobal('fetch', fetcher)
    await cancelVideoTask('local')
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    expect(fetcher.mock.calls.every((call) => (call[1]?.method ?? 'GET') === 'GET')).toBe(true)
    expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })
  it('reattaches ordered image references without POST and rejects changed order, missing, duplicate and mixed inputs', () => {
    seed({
      flowCommandId: 'command',
      modelId: 'doubao-seedance-2-0',
      mode: 'reference',
      referenceImageMediaIds: ['frame', 'tail']
    })
    // seed stores model identity in the task row separately.
    fixture.db.prepare('UPDATE tasks SET model_id=?').run('doubao-seedance-2-0')
    const input = referenceInput(),
      fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    for (const ids of [
      ['tail', 'frame'],
      ['frame'],
      ['frame', 'frame'],
      ['frame', 'tail', 'extra']
    ])
      expect(() => submitVideoTask(() => {}, { ...input, referenceImageMediaIds: ids })).toThrow()
    expect(() => submitVideoTask(() => {}, { ...input, firstFrameMediaId: 'frame' })).toThrow()
    expect(() =>
      submitVideoTask(() => {}, { ...input, referenceVideoMediaIds: ['video'] })
    ).toThrow()
    writeFileSync(join(fixture.directory, 'projects/project/media/tail.png'), 'other--tail')
    expect(() => submitVideoTask(() => {}, input)).toThrow('ASSET_IMAGE_CHANGED')
    expect(fetcher).not.toHaveBeenCalled()
    expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })
  it('rejects drift in an original reference task and unsupported model capability before POST', () => {
    seed({ flowCommandId: 'command', mode: 'reference', referenceImageMediaIds: ['tail', 'frame'] })
    const input = referenceInput()
    fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
    expect(() => submitVideoTask(() => {}, input)).toThrow('原视频命令输入发生变化')
    expect(() =>
      submitVideoTask(() => {}, { ...input, modelId: 'doubao-seedance-1-5-pro' })
    ).toThrow('不支持该参考媒体或数量')
  })
  it.each(['frame', 'tail'])(
    'checks actual encoded reference bytes for %s before POST',
    async (slot) => {
      const input = referenceInput()
      vi.mocked(readMediaBuffer).mockImplementation(async (id) => ({
        buf: Buffer.from(
          id === slot ? 'wrong-bytes' : id === 'frame' ? 'fixed-frame' : 'fixed--tail'
        ),
        mime: 'image/png'
      }))
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      const result = submitVideoTask(() => {}, input)
      await vi.waitFor(() => expect(getVideoTask(result.taskId)?.status).toBe('unknown'))
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it('keeps reference-image stop persistent and reattaches one original task without POST', async () => {
    seed({ flowCommandId: 'command', mode: 'reference', referenceImageMediaIds: ['frame', 'tail'] })
    const input = referenceInput()
    fixture.db.prepare('UPDATE tasks SET model_id=?').run(input.modelId)
    const fetcher = vi.fn().mockResolvedValue(response('running'))
    vi.stubGlobal('fetch', fetcher)
    await cancelVideoTask('local')
    expect(
      JSON.parse(
        (fixture.db.prepare('SELECT input FROM tasks WHERE id=?').get('local') as { input: string })
          .input
      ).cancelRequested
    ).toBe(true)
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    expect(fetcher.mock.calls.every((call) => (call[1]?.method ?? 'GET') === 'GET')).toBe(true)
    expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
  })
  it('rejects tail drift in an existing task even when the fixed command is valid', () => {
    seed({
      flowCommandId: 'command',
      mode: 'first-last-frame',
      firstFrameMediaId: 'frame',
      lastFrameMediaId: 'different-tail'
    })
    const input = twoFrameInput()
    expect(() => submitVideoTask(() => {}, input)).toThrow('原视频命令输入发生变化')
  })
  it('persists stop for both fixed frames and explicit reattachment keeps the original task', async () => {
    seed({
      flowCommandId: 'command',
      mode: 'first-last-frame',
      firstFrameMediaId: 'frame',
      lastFrameMediaId: 'tail'
    })
    const input = twoFrameInput(),
      fetcher = vi.fn().mockResolvedValue(response('running'))
    vi.stubGlobal('fetch', fetcher)
    await cancelVideoTask('local')
    const row = fixture.db.prepare('SELECT input FROM tasks WHERE id=?').get('local') as {
      input: string
    }
    expect(JSON.parse(row.input).cancelRequested).toBe(true)
    expect(submitVideoTask(() => {}, input)).toEqual({ taskId: 'local' })
    expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.method ?? 'GET').toBe('GET')
  })
  it.each(['first', 'last'])(
    'checks actual asynchronous %s frame bytes before any POST',
    async (slot) => {
      const input = { ...twoFrameInput(), modelId: 'doubao-seedance-2-0' }
      vi.mocked(readMediaBuffer).mockImplementation(async (id) => ({
        buf: Buffer.from(
          id === (slot === 'first' ? 'frame' : 'tail')
            ? 'wrong-bytes'
            : id === 'frame'
              ? 'fixed-frame'
              : 'fixed--tail'
        ),
        mime: 'image/png'
      }))
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      const result = submitVideoTask(() => {}, input)
      for (let i = 0; i < 100; i++) {
        const row = fixture.db
          .prepare('SELECT status FROM tasks WHERE id=?')
          .get(result.taskId) as { status: string }
        if (row.status === 'unknown') break
        await new Promise((done) => setTimeout(done, 5))
      }
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(result.taskId)).toEqual({
        status: 'unknown'
      })
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it('checks the exact bytes returned by the asynchronous media read before POST', async () => {
    const input = { ...firstFrameInput(), modelId: 'doubao-seedance-2-0' }
    vi.mocked(readMediaBuffer).mockResolvedValueOnce({
      buf: Buffer.from('other-frame'),
      mime: 'image/png'
    })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = submitVideoTask(() => {}, input)
    for (let i = 0; i < 100; i++) {
      const row = fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(result.taskId) as {
        status: string
      }
      if (row.status === 'unknown') break
      await new Promise((done) => setTimeout(done, 5))
    }
    const row = fixture.db
      .prepare('SELECT status,error FROM tasks WHERE id=?')
      .get(result.taskId) as { status: string; error: string }
    expect(row.status).toBe('unknown')
    expect(fetcher).not.toHaveBeenCalled()
  })
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
