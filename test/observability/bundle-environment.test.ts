import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { DiagnosticsProducer } from '@shared/observability'
import {
  bundleEnvironment,
  bundleSessionEnvironments
} from '../../src/main/diagnostics/bundle-environment'
import { memoryFsStore } from '../../src/main/diagnostics/fs-types'
import { initDiagnosticsService } from '../../src/main/diagnostics/service'

describe('diagnostic bundle runtime context', () => {
  it('exports only validated runtime fields and excludes private metadata', () => {
    expect(
      bundleEnvironment({
        appVersion: '1.2.3-beta.1',
        platform: 'win32',
        arch: 'x64',
        packaged: false,
        electron: '38.2.0',
        commit: 'abcdef123',
        apiKey: 'private-key',
        prompt: 'private-prompt',
        node: 'C:\\private\\runtime',
        chromium: 'https://private.example',
        buildId: 'private-build'
      })
    ).toEqual({
      appVersion: '1.2.3-beta.1',
      platform: 'win32',
      arch: 'x64',
      packaged: false,
      electron: '38.2.0',
      commit: 'abcdef123'
    })
    for (const value of [null, [], 'private', 42]) expect(bundleEnvironment(value)).toEqual({})
  })

  it('preserves missing, corrupt and mismatched history as unknown without rewriting it', async () => {
    const store = memoryFsStore()
    store.files.set('/sessions/session-broken.json', '{private-broken')
    store.files.set(
      '/sessions/session-mismatch.json',
      JSON.stringify({ sessionId: 'other', env: { appVersion: '2.0.0' } })
    )
    const before = [...store.files]
    const result = await bundleSessionEnvironments(
      store,
      '/sessions',
      ['missing', 'broken', 'mismatch', '../outside'],
      { sessionId: 'now', env: undefined }
    )
    expect(result.sessions).toHaveLength(5)
    expect(result.sessions.every((session) => !session.environmentAvailable)).toBe(true)
    expect([...store.files]).toEqual(before)
  })

  it('bounds reads and reports omitted sessions instead of silently discarding context', async () => {
    const store = memoryFsStore()
    store.files.set('/sessions/session-large.json', 'x'.repeat(65537))
    let reads = 0
    const original = store.readFile
    store.readFile = async (path) => {
      reads++
      return original(path)
    }
    const ids = ['large', ...Array.from({ length: 140 }, (_, index) => `old-${index}`)]
    const result = await bundleSessionEnvironments(store, '/sessions', ids, {
      sessionId: 'now',
      env: { appVersion: '1.0.0' }
    })
    expect(result.sessions).toHaveLength(128)
    expect(result.omittedSessions).toBe(14)
    expect(reads).toBe(0)
    expect(result.sessions[0].environment).toEqual({ appVersion: '1.0.0' })
  })

  it('exports historical event versions separately from the exporting session and redacts the real zip', async () => {
    const store = memoryFsStore()
    const env = {
      appVersion: '1.0.0',
      platform: 'win32',
      arch: 'x64',
      prompt: 'private-environment-body',
      apiKey: 'private-environment-key'
    }
    const old = await initDiagnosticsService({ dataDir: '/data', store, env, disableTimers: true })
    const producer = new DiagnosticsProducer({ process: 'main', producerId: 'bundle-test' })
    await old.ingest([
      producer.build('node.stage', 'info', '安全阶段', { traceId: 'bundle-trace' })
    ])
    await old.flushOnQuit()
    const current = await initDiagnosticsService({
      dataDir: '/data',
      store,
      env: { appVersion: '2.0.0', packaged: false },
      disableTimers: true
    })
    await current.exportBundle({ scope: { traceId: 'bundle-trace' } }, '/bundle.zip')
    const zip = new AdmZip(Buffer.from(store.files.get('/bundle.zip')!, 'latin1'))
    const manifest = JSON.parse(zip.readAsText('manifest.json'))
    expect(manifest.sessionId).toBe(current.sessionId)
    expect(manifest.sessions).toEqual([
      {
        sessionId: current.sessionId,
        environment: { appVersion: '2.0.0', packaged: false },
        environmentAvailable: true
      },
      {
        sessionId: old.sessionId,
        environment: { appVersion: '1.0.0', platform: 'win32', arch: 'x64' },
        environmentAvailable: true
      }
    ])
    expect(JSON.parse(zip.readAsText('events.jsonl').trim()).sessionId).toBe(old.sessionId)
    for (const name of ['manifest.json', 'events.jsonl', 'summary.txt', 'coverage.json']) {
      expect(zip.readAsText(name)).not.toContain('private-environment')
      expect(zip.readAsText(name)).not.toContain('apiKey')
    }
  })
})
