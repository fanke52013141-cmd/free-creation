/**
 * 设备绑定密钥库测试：真实 SQLite（migration #20）+ 双软件适配器模拟两台设备。
 * 覆盖：写入/读取往返、来源绑定拒绝、跨设备无法解密、缓存 TTL 与失效、删除。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { SecretVault, VaultError, type VaultDatabase } from '../src/main/security/keystore/vault'
import { createInMemorySoftwareAdapter, SoftwareDeviceAdapter } from '../src/main/security/license/device/software'

describe('SecretVault', () => {
  let rootDir: string
  let database: Database

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'cs-vault-'))
    database = new Database(':memory:')
    database.pragma('journal_mode = WAL')
    migrateDatabase(database)
  })

  afterEach(() => {
    database.close()
    rmSync(rootDir, { recursive: true, force: true })
  })

  async function makeVault(adapter = createInMemorySoftwareAdapter()): Promise<{ vault: SecretVault; adapter: typeof adapter }> {
    await adapter.createDeviceKeys()
    const vault = new SecretVault({
      adapter,
      database: () => database as unknown as VaultDatabase
    })
    return { vault, adapter }
  }

  it('写入→读取往返；AAD 绑定字段；更新覆盖', async () => {
    const { vault } = await makeVault()
    await vault.writeSecret({
      kind: 'connection',
      id: 'conn-1',
      origin: 'https://api.example.com',
      source: 'local',
      scope: 'app.run',
      plain: 'sk-live-123'
    })
    expect(vault.hasSecret('connection', 'conn-1')).toBe(true)
    expect(await vault.readSecret('connection', 'conn-1')).toBe('sk-live-123')

    // 更新覆盖（同 id 新密钥）。
    await vault.writeSecret({
      kind: 'connection',
      id: 'conn-1',
      origin: 'https://api.example.com',
      source: 'cskeys-import',
      scope: 'app.run',
      plain: 'sk-rotated-456'
    })
    expect(await vault.readSecret('connection', 'conn-1')).toBe('sk-rotated-456')
    const meta = vault.getMeta('connection', 'conn-1')
    expect(meta?.source).toBe('cskeys-import')
  })

  it('readForRequest：目标来源与绑定来源一致才放行', async () => {
    const { vault } = await makeVault()
    await vault.writeSecret({
      kind: 'connection',
      id: 'conn-1',
      origin: 'https://api.example.com',
      source: 'local',
      scope: 'app.run',
      plain: 'sk-live'
    })
    expect(await vault.readForRequest('connection', 'conn-1', 'https://api.example.com/v1/chat')).toBe('sk-live')
    expect(await vault.readForRequest('connection', 'conn-1', 'https://api.example.com:443/v1/models')).toBe('sk-live')

    // 改地址 → 拒绝释放。
    await expect(
      vault.readForRequest('connection', 'conn-1', 'https://evil.example.com/v1/chat')
    ).rejects.toMatchObject({ code: 'VAULT_ORIGIN_MISMATCH' })
    // 端口不同也是不同来源。
    await expect(
      vault.readForRequest('connection', 'conn-1', 'https://api.example.com:8443/v1/chat')
    ).rejects.toMatchObject({ code: 'VAULT_ORIGIN_MISMATCH' })
  })

  it('复制数据目录到另一台设备后无法解密（VAULT_DECRYPT_FAILED）', async () => {
    const deviceA = createInMemorySoftwareAdapter()
    const { vault: vaultA } = await makeVault(deviceA)
    await vaultA.writeSecret({
      kind: 'provider',
      id: 'p1',
      origin: 'https://api.example.com',
      source: 'local',
      scope: 'app.run',
      plain: 'sk-secret'
    })

    // 模拟把数据库文件复制到设备 B：新内存库注入 A 库的数据行。
    const deviceB = createInMemorySoftwareAdapter()
    await deviceB.createDeviceKeys()
    const vaultB = new SecretVault({
      adapter: deviceB,
      database: () => database as unknown as VaultDatabase
    })
    // 绕过 writeSecret（那会用 B 的公钥封装），直接把 A 库的行搬过来。
    const row = (database as unknown as { prepare(s: string): { get(...p: unknown[]): unknown } })
      .prepare('SELECT * FROM secret_vault WHERE kind = ? AND id = ?')
      .get('provider', 'p1')
    expect(row).toBeTruthy()

    // B 的 TPM 解不开 A 封装的内容密钥 → VAULT_DECRYPT_FAILED（不是静默明文泄漏）。
    await expect(vaultB.readSecret('provider', 'p1')).rejects.toMatchObject({ code: 'VAULT_DECRYPT_FAILED' })
  })

  it('缓存：TTL 内不重复解密（TPM 只调一次）；delete 后缓存失效', async () => {
    let unwrapCalls = 0
    const adapter = createInMemorySoftwareAdapter()
    await adapter.createDeviceKeys()
    const originalUnwrap = adapter.unwrap.bind(adapter)
    ;(adapter as unknown as { unwrap: (w: Uint8Array) => Promise<Buffer> }).unwrap = async (w: Uint8Array) => {
      unwrapCalls += 1
      return originalUnwrap(w)
    }
    const { vault } = await makeVault(adapter)
    await vault.writeSecret({
      kind: 'connection',
      id: 'c1',
      origin: 'https://x.example.com',
      source: 'local',
      scope: 'app.run',
      plain: 'sk-cached'
    })
    unwrapCalls = 0
    for (let i = 0; i < 5; i += 1) {
      expect(await vault.readSecret('connection', 'c1')).toBe('sk-cached')
    }
    expect(unwrapCalls).toBe(0) // 写入时的 setMemo 已命中缓存，未再走 TPM

    vault.clearMemo()
    expect(await vault.readSecret('connection', 'c1')).toBe('sk-cached')
    expect(unwrapCalls).toBe(1) // 清缓存后恰好一次 TPM 解封装

    await vault.deleteSecret('connection', 'c1')
    expect(await vault.readSecret('connection', 'c1')).toBeNull()
    expect(vault.hasSecret('connection', 'c1')).toBe(false)
  })

  it('磁盘持久适配器：重启（重建 vault 实例）后仍可解密', async () => {
    const keyStorePath = join(rootDir, 'dev-device-keys.json')
    const device = new SoftwareDeviceAdapter({ keyStorePath })
    await device.createDeviceKeys()
    const first = new SecretVault({ adapter: device, database: () => database as unknown as VaultDatabase })
    await first.writeSecret({
      kind: 'connection',
      id: 'c1',
      origin: 'https://x.example.com',
      source: 'local',
      scope: 'app.run',
      plain: 'sk-persist'
    })

    // 模拟重启：新适配器实例从磁盘加载同一密钥。
    const rebooted = new SoftwareDeviceAdapter({ keyStorePath })
    await rebooted.createDeviceKeys() // 幂等
    const second = new SecretVault({ adapter: rebooted, database: () => database as unknown as VaultDatabase })
    expect(await second.readSecret('connection', 'c1')).toBe('sk-persist')
  })
})

void DatabaseSync
void VaultError
