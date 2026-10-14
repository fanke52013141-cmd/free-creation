// Test-only failure injection around public repositories and gateway operations.
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { closeDb, getDb } from '../../src/main/store/db'
import { createProject, openProject, saveProject } from '../../src/main/store/projects.repo'
import { cancelVideoTask, controlVideoTask, submitVideoTask } from '../../src/main/gateway/video'
import { setGatewayEventSink } from '../../src/main/diagnostics/gateway-events'

const [directory, mode] = process.argv.slice(2)
if (
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-combined-')
)
  throw new Error('COMBINED_DIRECTORY_REJECTED')
process.env.CANVAS_DATA_DIR = directory
const db = getDb()
db.pragma('synchronous=FULL')
const baseURL = 'https://ark.cn-beijing.volces.com/api/v3'
const secret = 'combined-private-key',
  prompt = 'combined-private-prompt'
const bytes = 'combined-private-video-bytes'
const counter = (key: string) =>
  db.prepare('UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key=?').run(key)
const count = (key: string) =>
  Number((db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }).value)
const say = (value: unknown) => fs.writeSync(1, JSON.stringify(value) + '\n')
const cut = (): never => {
  say({ cut: true })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
  throw new Error('CUT_TIMEOUT')
}
setGatewayEventSink({
  emit: (event) => {
    if (mode === 'resume-logger-failure') throw new Error('LOGGER_FIXTURE_FAILURE')
    if (event)
      fs.appendFileSync(
        join(directory, `diagnostics-${process.pid}.jsonl`),
        JSON.stringify(event) + '\n'
      )
  }
})
globalThis.fetch = async (url, options) => {
  const address = String(url),
    method = options?.method ?? 'GET'
  if (method !== 'GET') {
    counter('mutations')
    throw new Error('GENERATION_OR_DELETE_FORBIDDEN')
  }
  if (address === `${baseURL}/contents/generations/tasks/remote-1`) {
    counter('queries')
    if (['query-drop', 'stop'].includes(mode)) throw new Error('OFFLINE_FIXTURE')
    return new Response(
      JSON.stringify({
        id: 'remote-1',
        status: 'succeeded',
        content: { video_url: 'https://fixture.example/video?signature=private-signature' }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }
  if (address === 'https://fixture.example/video?signature=private-signature') {
    counter('downloads')
    return new Response(bytes)
  }
  counter('unexpected')
  throw new Error('UNEXPECTED_NETWORK')
}
async function main() {
  if (mode === 'init') {
    const project = createProject('测试：C4 组合故障')
    fs.writeFileSync(join(directory, 'project-id'), project.id)
    saveProject({
      id: project.id,
      expectedGraphVersion: 0,
      tldrawSnapshot: { taskId: 'task', phase: 'pending' }
    })
    db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)').run(
      'provider',
      'fixture',
      'seedance',
      baseURL,
      secret,
      '[]',
      0
    )
    const input = {
      prompt,
      mode: 'text',
      referenceImageMediaIds: [],
      referenceVideoMediaIds: [],
      referenceAudioMediaIds: [],
      upstreamTaskId: 'remote-1',
      connection: { specId: 'seedance', baseURL },
      credentialHash: createHash('sha256').update(secret).digest('hex')
    }
    db.prepare(
      "INSERT INTO tasks(id,provider_id,model_id,node_id,project_id,kind,status,input,created_at,updated_at) VALUES ('task','provider','model','node',?,'video','unknown',?,0,0)"
    ).run(project.id, JSON.stringify(input))
    for (const key of ['queries', 'downloads', 'mutations', 'unexpected'])
      db.prepare('INSERT INTO settings VALUES (?,?)').run(key, '0')
    say({ initialized: true })
    return
  }
  const projectId = fs.readFileSync(join(directory, 'project-id'), 'utf8')
  if (mode === 'resume-hold') {
    const promises = createRequire(__filename)('fs/promises') as typeof import('node:fs/promises')
    const rename = promises.rename
    promises.rename = async (from, to) => {
      await rename(from, to)
      say({ held: true })
      const deadline = Date.now() + 12000
      while (!fs.existsSync(join(directory, 'release-promotion'))) {
        if (Date.now() > deadline) throw new Error('PROMOTION_TIMEOUT')
        await new Promise((done) => setTimeout(done, 20))
      }
    }
  }
  if (mode === 'prepared') {
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (sql.startsWith('UPDATE tasks SET output=')) {
        const run = statement.run.bind(statement)
        statement.run = ((...args: unknown[]) => {
          const result = run(...args)
          if (JSON.parse(String(args[0])).videoMaterialization?.phase === 'prepared') cut()
          return result
        }) as typeof statement.run
      }
      return statement
    }) as typeof db.prepare
  }
  if (mode.startsWith('save-')) {
    const file = openProject(projectId)!
    const path = join(directory, 'projects', projectId, 'project.json')
    const mutable = createRequire(__filename)('fs') as typeof fs
    const write = mutable.writeFileSync,
      rename = mutable.renameSync
    mutable.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      write(...args)
      if (mode === 'save-tmp' && String(args[0]) === path + '.tmp') cut()
    }) as typeof fs.writeFileSync
    mutable.renameSync = ((from, to) => {
      rename(from, to)
      if (mode === 'save-promoted' && String(to) === path) cut()
    }) as typeof fs.renameSync
    if (mode === 'save-transaction') {
      db.function('cut_combined', cut)
      db.exec(
        'CREATE TEMP TRIGGER combined_cut AFTER UPDATE OF graph_version ON projects BEGIN SELECT cut_combined(); END'
      )
    }
    saveProject({
      id: projectId,
      expectedGraphVersion: file.meta.graphVersion,
      tldrawSnapshot: { taskId: 'task', phase: 'stopped' }
    })
  } else if (mode === 'stop' || mode === 'stop-release') {
    await cancelVideoTask('task')
    if (mode === 'stop-release') fs.writeFileSync(join(directory, 'release-promotion'), 'release')
  } else if (['resume', 'resume-hold', 'resume-logger-failure', 'changed-input'].includes(mode)) {
    const input = {
      projectId,
      nodeId: 'node',
      providerId: 'provider',
      modelId: 'model',
      prompt: mode === 'changed-input' ? 'changed-private-prompt' : prompt
    }
    const submitted = submitVideoTask(() => {}, input)
    if (submitted.taskId !== 'task') throw new Error('TASK_ID_CHANGED')
    if (mode !== 'changed-input') await controlVideoTask('task')
  } else if (mode === 'corrupt') {
    const row = db.prepare("SELECT output FROM tasks WHERE id='task'").get() as { output: string }
    const identity = JSON.parse(row.output).videoMaterialization.identity
    fs.writeFileSync(join(directory, 'video-recovery', `${identity}.part`), 'corrupt-private-bytes')
  } else if (mode === 'publish') {
    const row = db.prepare("SELECT status,output FROM tasks WHERE id='task'").get() as {
      status: string
      output: string
    }
    if (row.status !== 'success') throw new Error('UNVERIFIED_OUTPUT')
    const file = openProject(projectId)!
    saveProject({
      id: projectId,
      expectedGraphVersion: file.meta.graphVersion,
      tldrawSnapshot: { taskId: 'task', phase: 'success', mediaId: JSON.parse(row.output).mediaId }
    })
  } else if (mode !== 'inspect') await controlVideoTask('task')
  const row = db.prepare("SELECT status,input,output FROM tasks WHERE id='task'").get() as {
    status: string
    input: string
    output: string
  }
  const project = openProject(projectId)!
  const media = db.prepare('SELECT id,path FROM media').all() as { id: string; path: string }[]
  const events = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith('diagnostics-'))
    .flatMap((name) =>
      fs
        .readFileSync(join(directory, name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
  const serialized = JSON.stringify(events)
  say({
    status: row.status,
    stopped: Boolean(JSON.parse(row.input).cancelRequested),
    phase: JSON.parse(row.output ?? '{}').videoMaterialization?.phase ?? null,
    snapshot: project.tldrawSnapshot,
    version: project.meta.graphVersion,
    dbVersion: (
      db.prepare('SELECT graph_version FROM projects WHERE id=?').get(projectId) as {
        graph_version: number
      }
    ).graph_version,
    media: media.map((asset) => ({
      id: asset.id,
      valid: fs.readFileSync(join(directory, asset.path), 'utf8') === bytes
    })),
    tasks: (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
    locks: (db.prepare('SELECT count(*) AS n FROM process_locks').get() as { n: number }).n,
    queries: count('queries'),
    downloads: count('downloads'),
    mutations: count('mutations'),
    unexpected: count('unexpected'),
    redacted: ![
      secret,
      prompt,
      bytes,
      directory,
      'private-signature',
      'corrupt-private-bytes'
    ].some((value) => serialized.includes(value)),
    controls: events.filter((e) => e.event === 'task.control.completed').length,
    unpairedMedia: events.filter(
      (e) =>
        e.event === 'media.persist_started' &&
        !events.some(
          (end) =>
            ['media.persist_completed', 'media.persist_failed'].includes(end.event) &&
            end.traceId === e.traceId &&
            end.spanId === e.spanId
        )
    ).length,
    unpairedDownloads: events.filter(
      (e) =>
        e.event === 'media.download_started' &&
        !events.some(
          (end) =>
            ['media.download_completed', 'media.download_failed'].includes(end.event) &&
            end.traceId === e.traceId &&
            end.spanId === e.spanId
        )
    ).length,
    unpairedControls: events.filter(
      (e) =>
        e.event === 'task.control.started' &&
        !events.some(
          (end) =>
            end.event === 'task.control.completed' &&
            end.traceId === e.traceId &&
            end.spanId === e.spanId
        )
    ).length,
    duplicateControlEnds: events.filter(
      (e) =>
        e.event === 'task.control.completed' &&
        events.filter(
          (end) => end.event === e.event && end.traceId === e.traceId && end.spanId === e.spanId
        ).length !== 1
    ).length
  })
}
void main()
  .catch((error) => {
    say({
      error:
        error instanceof Error && 'code' in error
          ? String(error.code)
          : error instanceof Error
            ? error.name
            : 'unexpected'
    })
    process.exitCode = 1
  })
  .finally(() => closeDb())
