import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { closeDb, getDb } from '../../src/main/store/db'
import { createProject } from '../../src/main/store/projects.repo'
import { finalizeVideo, controlVideoTask } from '../../src/main/gateway/video'
import { setGatewayEventSink } from '../../src/main/diagnostics/gateway-events'
import type { DiagnosticsEventInput } from '../../src/shared/observability'

const directory = process.argv[2],
  mode = process.argv[3]
if (
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-video-crash-')
)
  throw new Error('VIDEO_FIXTURE_DIRECTORY_REJECTED')
process.env.CANVAS_DATA_DIR = directory
const db = getDb()
db.pragma('synchronous = FULL')
const events: DiagnosticsEventInput[] = []
setGatewayEventSink({
  emit: (event) => {
    if (event) events.push(event)
  }
})
const cut = (): never => {
  fs.writeSync(1, 'cut-ready\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('CUT_NOT_TERMINATED')
}
async function main() {
  if (
    [
      'recover',
      'inspect',
      'corrupt',
      'retry',
      'identity',
      'missing',
      'metadata',
      'binding'
    ].includes(mode)
  ) {
    const id = fs.readFileSync(join(directory, 'project-id'), 'utf8')
    if (mode === 'corrupt') {
      const output = JSON.parse(
        (db.prepare('SELECT output FROM tasks WHERE id=?').get('task') as { output: string }).output
      )
      const mediaId = `video-${output.videoMaterialization.identity}`
      const target = join(directory, `projects/${id}/media/${mediaId}.mp4`)
      const stage = join(directory, `video-recovery/${output.videoMaterialization.identity}.part`)
      fs.writeFileSync(fs.existsSync(target) ? target : stage, 'corrupted')
    }
    if (['identity', 'missing', 'metadata', 'binding'].includes(mode)) {
      const row = db.prepare('SELECT input,output FROM tasks WHERE id=?').get('task') as {
        input: string
        output: string
      }
      const saved = JSON.parse(row.output).videoMaterialization
      if (mode === 'binding')
        db.prepare('UPDATE tasks SET output=? WHERE id=?').run(
          JSON.stringify({ ...JSON.parse(row.output), mediaId: 'unrelated-media' }),
          'task'
        )
      const mediaId = `video-${saved.identity}`
      if (mode === 'identity')
        db.prepare('UPDATE tasks SET input=? WHERE id=?').run(
          JSON.stringify({ upstreamTaskId: 'changed' }),
          'task'
        )
      if (mode === 'missing')
        fs.unlinkSync(join(directory, `video-recovery/${saved.identity}.part`))
      if (mode === 'metadata')
        db.prepare(
          'INSERT INTO media (id,kind,mime,path,size_bytes,created_at) VALUES (?,?,?,?,?,0)'
        ).run(mediaId, 'image', 'image/png', `projects/${id}/media/${mediaId}.mp4`, saved.size)
    }
    if (['recover', 'corrupt', 'identity', 'missing', 'metadata', 'binding'].includes(mode)) {
      globalThis.fetch = async () => {
        db.prepare('UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key=?').run(
          'unexpected-network'
        )
        throw new Error('NETWORK_NOT_ALLOWED')
      }
      await controlVideoTask('task')
    }
    if (mode === 'retry') {
      globalThis.fetch = async () => {
        db.prepare('UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key=?').run(
          'downloads'
        )
        return new Response('verified-video-material')
      }
      await finalizeVideo(() => {}, 'task', id, 'https://fixture.example/result', [])
    }
    const row = db.prepare('SELECT status,output FROM tasks WHERE id=?').get('task') as {
      status: string
      output: string
    }
    const media = db.prepare('SELECT id,path FROM media').all() as Array<{
      id: string
      path: string
    }>
    fs.writeSync(
      1,
      JSON.stringify({
        status: row.status,
        output: JSON.parse(row.output ?? '{}'),
        media,
        bytes: media.map((asset) =>
          fs.existsSync(join(directory, asset.path))
            ? fs.readFileSync(join(directory, asset.path), 'utf8')
            : null
        ),
        downloads: Number(
          (
            db.prepare('SELECT value FROM settings WHERE key=?').get('downloads') as {
              value: string
            }
          ).value
        ),
        network: Number(
          (
            db.prepare('SELECT value FROM settings WHERE key=?').get('unexpected-network') as {
              value: string
            }
          ).value
        ),
        diagnosticRedaction: !JSON.stringify(events).includes('verified-video-material'),
        lifecyclePaired:
          events.filter((event) => event.event === 'media.persist_started').length ===
          events.filter((event) =>
            ['media.persist_completed', 'media.persist_failed'].includes(event.event)
          ).length
      }) + '\n'
    )
    closeDb()
    return
  }
  const project = createProject('测试：视频成果强杀')
  fs.writeFileSync(join(directory, 'project-id'), project.id)
  db.prepare('INSERT INTO settings VALUES (?,?)').run('downloads', '0')
  db.prepare('INSERT INTO settings VALUES (?,?)').run('unexpected-network', '0')
  db.prepare(
    `INSERT INTO tasks (id,provider_id,model_id,node_id,project_id,kind,status,input,created_at,updated_at)
    VALUES ('task','provider','model','node',?,'video','unknown',?,0,0)`
  ).run(project.id, JSON.stringify({ upstreamTaskId: 'fixed-remote' }))
  globalThis.fetch = async () => {
    db.prepare('UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key=?').run('downloads')
    if (mode === 'partial')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'))
            setTimeout(cut, 100)
          }
        })
      )
    return new Response('verified-video-material')
  }
  const mutableFs = createRequire(__filename)('fs/promises') as typeof import('node:fs/promises')
  const originalRename = mutableFs.rename
  mutableFs.rename = (async (...args: Parameters<typeof mutableFs.rename>) => {
    await originalRename(...args)
    if (mode === 'promoted') cut()
  }) as typeof mutableFs.rename
  db.function('cut_video', cut)
  if (mode === 'prepared' || mode === 'unverified') {
    const originalPrepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql)
      if (sql.startsWith('UPDATE tasks SET output=')) {
        const originalRun = statement.run.bind(statement)
        statement.run = ((...args: unknown[]) => {
          if (
            mode === 'unverified' &&
            JSON.parse(String(args[0])).videoMaterialization.phase === 'prepared'
          )
            cut()
          const result = originalRun(...args)
          if (JSON.parse(String(args[0])).videoMaterialization.phase === 'prepared') cut()
          return result
        }) as typeof statement.run
      }
      return statement
    }) as typeof db.prepare
  }
  if (mode === 'transaction')
    db.exec('CREATE TEMP TRIGGER video_cut AFTER INSERT ON media BEGIN SELECT cut_video(); END')
  if (mode === 'committed')
    db.exec(`CREATE TEMP TRIGGER video_cut BEFORE UPDATE OF status ON tasks
    WHEN NEW.status='success' BEGIN SELECT cut_video(); END`)
  await finalizeVideo(() => {}, 'task', project.id, 'https://fixture.example/result', [])
  cut()
}
void main().catch(() => {
  fs.writeSync(2, 'VIDEO_CRASH_WORKER_FAILED\n')
  process.exitCode = 1
})
