import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { qaOutputPath } = require('../scripts/qa-output.cjs')
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      resolve(directory, '..') === resolve(tmpdir()) &&
      basename(directory).startsWith('canvas-verification-')
    ) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

describe('verification evidence isolation', () => {
  it('preserves previous evidence while writing independent output for each run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-verification-'))
    directories.push(directory)
    const legacy = join(directory, 'qa/optimization-remaining/results.json')
    mkdirSync(resolve(legacy, '..'), { recursive: true })
    writeFileSync(legacy, 'previous evidence')
    const first = qaOutputPath('qa/optimization-remaining/results.json', join(directory, 'run-1'))
    const second = qaOutputPath('qa/optimization-remaining/results.json', join(directory, 'run-2'))
    writeFileSync(first, 'first run')
    writeFileSync(second, 'second run')
    expect(readFileSync(legacy, 'utf8')).toBe('previous evidence')
    expect(readFileSync(first, 'utf8')).toBe('first run')
    expect(readFileSync(second, 'utf8')).toBe('second run')
  })

  it('rejects absolute and relative paths outside the active run before writing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-verification-'))
    directories.push(directory)
    const root = join(directory, 'run')
    for (const output of [
      '../previous/results.json',
      join(directory, 'previous/results.json'),
      '.'
    ]) {
      expect(() => qaOutputPath(output, root)).toThrow('QA_OUTPUT_PATH_OUTSIDE_RUN')
    }
  })

  it('keeps standalone paths compatible when no isolation root is set', () => {
    expect(qaOutputPath('qa/example/results.json', '')).toBe(resolve('qa/example/results.json'))
  })

  it('propagates a failed gate and retains separate reports across retries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'canvas-verification-'))
    directories.push(directory)
    const fixture = join(directory, 'failed-gate.cjs')
    writeFileSync(fixture, `process.stdout.write('gate evidence'); process.exitCode = 7`)
    const runner = resolve('scripts/run-verification.cjs')
    // Windows treats env names case-insensitively; npm may provide NPM_EXECPATH.
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_execpath')
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, [runner], {
        cwd: directory,
        env: { ...environment, npm_execpath: fixture, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(7)
    }
    const parent = join(directory, 'qa/verification')
    const runs = readdirSync(parent)
    expect(runs).toHaveLength(2)
    for (const run of runs) {
      const report = JSON.parse(readFileSync(join(parent, run, 'status.json'), 'utf8'))
      expect(report.status).toBe('failed')
      expect(report.exitCode).toBe(7)
      expect(readFileSync(join(parent, run, 'verify.log'), 'utf8')).toBe('gate evidence')
    }
  })
})
