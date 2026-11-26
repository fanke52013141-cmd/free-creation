import { randomUUID } from 'node:crypto'
import { readFileSync, readSync } from 'node:fs'
import { ACCESS_MAX_BYTES, type AccessResponse } from '../shared/agent-access/registry'

export class CliInputError extends Error {
  constructor(
    public readonly code: 'INPUT_TOO_LARGE' | 'INPUT_NOT_FOUND' | 'INVALID_INPUT',
    public readonly phase: 'parse' | 'validate' = 'parse'
  ) {
    super(code)
  }
}

/** Read stdin without allowing an unbounded local buffer. */
export function readBoundedStdin(maxBytes = ACCESS_MAX_BYTES): Buffer {
  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(64 * 1024)
  let total = 0
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.length, null)
    if (count <= 0) break
    total += count
    if (total > maxBytes) throw new CliInputError('INPUT_TOO_LARGE')
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks)
}

export function parseCliInputBytes(bytes: Buffer, maxBytes = ACCESS_MAX_BYTES): unknown {
  if (bytes.length > maxBytes) throw new CliInputError('INPUT_TOO_LARGE')
  if (bytes.length === 0) return { input: {} }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new CliInputError('INVALID_INPUT')
  }
}

/** CLI input is explicit file or bounded stdin; command-line JSON is intentionally not accepted. */
export function parseCliInput(filePath?: string, maxBytes = ACCESS_MAX_BYTES): unknown {
  if (filePath) {
    let bytes: Buffer
    try {
      bytes = readFileSync(filePath)
    } catch {
      throw new CliInputError('INPUT_NOT_FOUND')
    }
    return parseCliInputBytes(bytes, maxBytes)
  }
  if (process.stdin.isTTY) return { input: {} }
  return parseCliInputBytes(readBoundedStdin(maxBytes), maxBytes)
}

export function cliFailure(
  operationId: string,
  code: string,
  phase: string,
  requestId = randomUUID(),
  detail?: string
): AccessResponse {
  return {
    apiVersion: 1,
    requestId,
    operationId: /^[a-zA-Z0-9_.:-]{1,80}$/.test(operationId) ? operationId : 'invalid',
    traceId: 'unavailable',
    status: 'failed',
    error: { code, phase, retryable: false, ...(detail ? { detail: detail.slice(0, 200) } : {}) }
  }
}

export function writeCliResponse(response: AccessResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
  process.exitCode = response.status === 'completed' ? 0 : response.status === 'unknown' ? 3 : 2
}
