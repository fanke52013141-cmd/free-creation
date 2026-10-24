import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ACCESS_MAX_BYTES,
  AccessResponseSchema,
  type AccessOperationId,
  type AccessResponse
} from '../shared/agent-access/registry'
import { ConnectionDescriptorSchema } from '../shared/agent-access/connection'

export function defaultDataDirectory(): string {
  if (process.env.CANVAS_DATA_DIR) return process.env.CANVAS_DATA_DIR
  if (process.platform === 'darwin')
    return join(process.env.HOME ?? '.', 'Library', 'Application Support', 'canvas-studio', 'data')
  return (
    process.env.CANVAS_DATA_DIR ??
    join(
      process.env.APPDATA ??
        process.env.XDG_CONFIG_HOME ??
        join(process.env.HOME ?? '.', '.config'),
      'canvas-studio',
      'data'
    )
  )
}

export async function callLocalOperation(
  operationId: AccessOperationId,
  args: { input: unknown; requestId?: string; idempotencyKey?: string },
  dataDirectory = defaultDataDirectory()
): Promise<AccessResponse> {
  const requestId = args.requestId ?? randomUUID()
  const failure = (code: string, unknown = false): AccessResponse => ({
    apiVersion: 1,
    requestId,
    operationId,
    traceId: 'unavailable',
    status: unknown ? 'unknown' : 'failed',
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    error: { code, phase: 'connect', retryable: false }
  })
  let descriptor
  try {
    descriptor = ConnectionDescriptorSchema.parse(
      JSON.parse(readFileSync(join(dataDirectory, 'agent-access', 'connection.json'), 'utf8'))
    )
  } catch {
    return failure('APP_NOT_RUNNING')
  }
  const request = {
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    requestId,
    expectedDataStoreId: descriptor.dataStoreId,
    ...args
  }
  const payload =
    JSON.stringify({ token: descriptor.token, instanceId: descriptor.instanceId, request }) + '\n'
  if (Buffer.byteLength(payload) > ACCESS_MAX_BYTES) return failure('INPUT_TOO_LARGE')
  return await new Promise<AccessResponse>((resolve) => {
    let sent = false
    let finished = false
    let buffer = Buffer.alloc(0)
    const socket = createConnection(descriptor.endpoint)
    const finish = (response: AccessResponse): void => {
      if (finished) return
      finished = true
      resolve(response)
      socket.destroy()
    }
    const disconnected = (): void =>
      finish(failure(sent ? 'OUTCOME_UNKNOWN' : 'APP_NOT_RUNNING', sent))
    socket.setTimeout(15000, disconnected)
    socket.on('error', disconnected)
    socket.on('close', disconnected)
    socket.on('connect', () => {
      sent = true
      socket.write(payload)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > ACCESS_MAX_BYTES) {
        disconnected()
        return
      }
      const end = buffer.indexOf(10)
      if (end < 0) return
      try {
        const response = AccessResponseSchema.parse(
          JSON.parse(buffer.subarray(0, end).toString('utf8'))
        )
        if (response.requestId !== requestId || response.operationId !== operationId) {
          disconnected()
          return
        }
        finish(response)
      } catch {
        disconnected()
      }
    })
  })
}
