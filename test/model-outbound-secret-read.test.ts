import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (relativePath: string): string =>
  readFileSync(join(__dirname, '..', relativePath), 'utf8')

describe('outbound model request secret reads', () => {
  it('binds Agent Flow capability checks and execution reads to the connection origin', () => {
    const source = read('src/main/ipc/flow-agents.ipc.ts')
    const boundReads = source.match(/readSecretForRequest\(connection\.id, connection\.baseUrl\)/g) ?? []

    expect(boundReads).toHaveLength(2)
    expect(source).not.toMatch(/readSecret\(connection\.id\)/)
  })

  it('binds the headless Agent probe read to the connection origin', () => {
    const source = read('test/harness/agent-flow/model-probe-electron.ts')

    expect(source).toContain('readSecretForRequest(connection.id, connection.baseUrl)')
    expect(source).not.toMatch(/readSecret\(connection\.id\)/)
  })
})
