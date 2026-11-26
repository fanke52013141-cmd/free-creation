import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('../src/main/security/license/gate', () => ({
  assertLicenseActive: () => {
    throw new Error('LICENSE_INACTIVE')
  }
}))

import { closeDb } from '../src/main/store/db'
import { LocalAccessService } from '../src/main/agent-access/service'

let directory: string
const originalDirectory = process.env.CANVAS_DATA_DIR

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-agent-auth-test-'))
  process.env.CANVAS_DATA_DIR = directory
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

describe('外部接入授权失效', () => {
  it('returns a stable structured AUTH_FAILED error instead of an empty failure', async () => {
    const service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(directory, 'agent-exports'),
      activeProjectId: () => null
    })
    const requestId = randomUUID()
    const response = await service.dispatch({
      apiVersion: 1,
      operationVersion: 1,
      operationId: 'project.list',
      requestId,
      expectedDataStoreId: service.dataStoreId,
      input: {}
    })
    expect(response).toMatchObject({
      requestId,
      operationId: 'project.list',
      status: 'failed',
      error: { code: 'AUTH_FAILED', phase: 'authorization', retryable: false }
    })
  })
})
