import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'

let directory: string
const originalDirectory = process.env.CANVAS_DATA_DIR

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-agent-version-test-'))
  process.env.CANVAS_DATA_DIR = directory
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('外部接入操作版本', () => {
  it('rejects an unsupported operationVersion before any side effect', async () => {
    const service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(directory, 'agent-exports'),
      activeProjectId: () => null
    })
    const response = await service.dispatch({
      apiVersion: 1,
      operationVersion: 2,
      operationId: 'project.create',
      requestId: randomUUID(),
      expectedDataStoreId: service.dataStoreId,
      idempotencyKey: `${Date.now()}:${randomUUID()}`,
      input: { name: 'must-not-create' }
    })
    expect(response).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_OPERATION_VERSION', phase: 'validate', retryable: false }
    })
  })
})
