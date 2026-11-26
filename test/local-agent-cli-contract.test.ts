import { describe, expect, it } from 'vitest'
import {
  CliInputError,
  cliFailure,
  parseCliInputBytes
} from '../src/local-agent/cli'
import { operationDirectory, operationSpec } from '../src/shared/agent-access/registry'

describe('local Agent CLI contract', () => {
  it('parses bounded JSON input and treats empty input as an empty operation input', () => {
    expect(parseCliInputBytes(Buffer.from('{"input":{"projectId":"p"}}'))).toEqual({
      input: { projectId: 'p' }
    })
    expect(parseCliInputBytes(Buffer.alloc(0))).toEqual({ input: {} })
  })

  it('rejects malformed and oversized input with stable codes', () => {
    expect(() => parseCliInputBytes(Buffer.from('{not-json'))).toThrowError(CliInputError)
    try {
      parseCliInputBytes(Buffer.from('{}'), 1)
      throw new Error('expected oversize rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(CliInputError)
      expect((error as CliInputError).code).toBe('INPUT_TOO_LARGE')
    }
  })

  it('returns a structured failure envelope without leaking raw input', () => {
    const response = cliFailure('project.create', 'INVALID_INPUT', 'validate', 'req-1', 'input.name: required')
    expect(response).toMatchObject({
      apiVersion: 1,
      requestId: 'req-1',
      operationId: 'project.create',
      status: 'failed',
      error: { code: 'INVALID_INPUT', phase: 'validate', retryable: false }
    })
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(cliFailure('bad command with spaces', 'UNSUPPORTED_OPERATION', 'dispatch').operationId).toBe('invalid')
  })

  it('advertises network operations and all supported transports in the machine directory', () => {
    const directory = operationDirectory() as Array<{
      operationId: string
      operationVersion: number
      openWorld: boolean
      transports: string[]
    }>
    const byId = new Map(directory.map((entry) => [entry.operationId, entry]))
    expect(byId.get('webSearch.run')?.openWorld).toBe(true)
    expect(byId.get('node.execute')?.openWorld).toBe(true)
    expect(byId.get('model.validate')?.openWorld).toBe(true)
    expect(byId.get('project.list')?.openWorld).toBe(false)
    expect(byId.get('project.list')?.operationVersion).toBe(1)
    expect(byId.get('project.list')?.transports).toEqual(['cli', 'mcp-stdio', 'mcp-sse'])
    expect(operationSpec('flowAgent.run').openWorld).toBe(true)
  })
})
