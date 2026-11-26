import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrateDatabase } from '../src/main/store/db-migrations'
import {
  assertFlowMediaInputLimit,
  fixedFlowMedia,
  FLOW_MEDIA_INPUT_MAX_BYTES,
  FLOW_VIDEO_OUTPUT_MAX_BYTES
} from '../src/main/agent-flow/image-assets'

let directory = ''
let previousDataDir: string | undefined
const databases: Database.Database[] = []

beforeEach(() => {
  previousDataDir = process.env.CANVAS_DATA_DIR
  directory = mkdtempSync(join(tmpdir(), 'canvas-flow-media-limits-'))
  process.env.CANVAS_DATA_DIR = directory
})

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  if (previousDataDir === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = previousDataDir
  if (resolve(directory, '..') === resolve(tmpdir())) rmSync(directory, { recursive: true, force: true })
})

describe('AF-08 media input/output limits', () => {
  it('keeps references at 20 MiB while allowing a common generated video above 20 MiB', () => {
    const db = new Database(':memory:')
    databases.push(db)
    migrateDatabase(db)
    db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('project-a', 'fixture')
    const mediaDir = join(directory, 'projects', 'project-a', 'media')
    mkdirSync(mediaDir, { recursive: true })
    const filePath = join(mediaDir, 'large.mp4')
    writeFileSync(filePath, Buffer.alloc(FLOW_MEDIA_INPUT_MAX_BYTES + 1, 1))
    const relativePath = 'projects/project-a/media/large.mp4'
    db.prepare(
      'INSERT INTO media(id,kind,mime,path,size_bytes,created_at) VALUES (?,?,?,?,?,?)'
    ).run('media-large', 'video', 'video/mp4', relativePath, FLOW_MEDIA_INPUT_MAX_BYTES + 1, 1)
    const value = {
      kind: 'video' as const,
      mediaId: 'media-large',
      mediaPath: relativePath,
      mime: 'video/mp4'
    }
    expect(() => assertFlowMediaInputLimit(db, value)).toThrow('FLOW_MEDIA_INPUT_TOO_LARGE')
    expect(() => fixedFlowMedia(db, 'project-a', value)).toThrow('ASSET_VIDEO_CHANGED')
    const fixed = fixedFlowMedia(db, 'project-a', value, {
      maxBytes: FLOW_VIDEO_OUTPUT_MAX_BYTES
    })
    expect(fixed.contentSha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
