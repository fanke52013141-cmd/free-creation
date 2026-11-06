import { createDecipheriv, scryptSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const repo = vi.hoisted(() => ({
  listProviders: vi.fn(),
  getProvider: vi.fn(),
  saveProvider: vi.fn()
}))
vi.mock('../src/main/gateway/providers.repo', () => repo)
vi.mock('../src/main/store/db', () => ({ getDb: () => ({ transaction: (fn: () => void) => fn }) }))
import { exportProviders, importProviders } from '../src/main/gateway/provider-transfer'

const dir = mkdtempSync(join(tmpdir(), 'canvas-provider-export-test-'))
afterEach(() => vi.resetAllMocks())
describe('selected provider export', () => {
  it('encrypts only the selected credential and never reads the other provider', () => {
    repo.listProviders.mockReturnValue([{ id: 'selected' }, { id: 'other' }])
    repo.getProvider.mockImplementation((id: string) => ({
      id,
      name: id,
      specId: 'relay',
      baseURL: 'https://example.test',
      apiKey: id === 'selected' ? 'selected-secret' : 'other-secret',
      models: [{ id: 'model', modality: 'image' }]
    }))
    const file = join(dir, 'selected.canvasproviders')
    expect(exportProviders(file, 'test-password', ['selected'])).toBe(1)
    expect(repo.getProvider).toHaveBeenCalledTimes(1)
    expect(repo.getProvider).toHaveBeenCalledWith('selected')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('selected-secret')
    expect(raw).not.toContain('other-secret')
    const envelope = JSON.parse(raw)
    const key = scryptSync('test-password', Buffer.from(envelope.salt, 'base64'), 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(Buffer.from('canvas-studio-providers:1'))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8')
    )
    expect(payload.providers.map((p: { id: string }) => p.id)).toEqual(['selected'])
    expect(payload.providers[0].apiKey).toBe('selected-secret')
    expect(() => importProviders(file, 'wrong-password')).toThrow()
    repo.getProvider.mockReturnValue(null)
    expect(importProviders(file, 'test-password')).toEqual({ added: 1, updated: 0, count: 1 })
    expect(repo.saveProvider).toHaveBeenCalledTimes(1)
    expect(repo.saveProvider.mock.calls[0][0].id).toBe('selected')
  })
  it('rejects invalid and stale selections', () => {
    for (const ids of [[], ['selected', 'selected']])
      expect(() => exportProviders(join(dir, 'invalid'), 'test-password', ids)).toThrow()
    expect(repo.getProvider).not.toHaveBeenCalled()
    expect(() => exportProviders(join(dir, 'invalid'), 'test-password', ['missing'])).toThrow()
    expect(repo.getProvider).toHaveBeenCalledOnce()
  })
})
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
