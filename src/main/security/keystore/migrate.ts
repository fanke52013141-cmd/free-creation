/**
 * 旧密钥 → 设备绑定密钥库 迁移（方案 §4.3）。
 *
 * - 两张表（providers.api_key_ref / model_connections.secret_ref）逐行处理：
 *   `enc:/plain:/裸值` → keycrypto 读明文 → vault 设备密文 → 引用替换为 `vault:<kind>:<id>`；
 * - 失败的行保留原值并计入 pending（下次启动重试），绝不因单行失败中断整体；
 * - 每行引用替换带原值守卫（WHERE ref = 旧值），配合 vault 的幂等 upsert，
 *   任意时刻中断都不会产生半迁移状态；
 * - 发现 `plain:`/裸值即标记「曾存在可复制副本」——提示在供应商侧轮换旧 Key。
 *
 * 幂等：vault: 引用的行直接跳过；vault 行按 (kind,id) upsert。
 */
import { decryptSecret, parseVaultRef, vaultRef } from '../../gateway/keycrypto'
import type { SecretVault, VaultKind } from './vault'

export interface VaultMigrationRowResult {
  kind: VaultKind
  id: string
  status: 'migrated' | 'kept-empty' | 'kept-failed'
  /** 原存储是 plain:/裸值——历史上存在过可复制明文，建议供应商侧轮换。 */
  rotatedRecommended: boolean
}

export interface VaultMigrationReport {
  migrated: number
  keptEmpty: number
  keptFailed: number
  rotatedRecommended: number
  pending: number
  rows: VaultMigrationRowResult[]
}

interface VaultMigrationDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
  }
}

export async function migrateSecretsToVault(input: {
  vault: SecretVault
  database: VaultMigrationDatabase
}): Promise<VaultMigrationReport> {
  const report: VaultMigrationReport = {
    migrated: 0,
    keptEmpty: 0,
    keptFailed: 0,
    rotatedRecommended: 0,
    pending: 0,
    rows: []
  }

  await migrateTable(input, {
    kind: 'provider',
    // 旧版启动前的兜底表结构（id TEXT PRIMARY KEY, api_key_ref TEXT）。
    sql: 'SELECT id, api_key_ref AS ref FROM providers',
    refColumn: 'api_key_ref'
  }, report)
  await migrateTable(input, {
    kind: 'connection',
    sql: 'SELECT id, secret_ref AS ref FROM model_connections',
    refColumn: 'secret_ref'
  }, report)

  report.pending = report.keptFailed
  return report
}

async function migrateTable(
  input: { vault: SecretVault; database: VaultMigrationDatabase },
  table: { kind: VaultKind; sql: string; refColumn: string },
  report: VaultMigrationReport
): Promise<void> {
  const rows = input.database.prepare(table.sql).all() as Array<{ id: string; ref: string | null }>
  for (const row of rows) {
    const ref = row.ref
    if (!ref) {
      // 尚无密钥的行：无需迁移。
      continue
    }
    if (parseVaultRef(ref)) {
      continue // 已迁移
    }

    const bareOrPlain = !ref.startsWith('enc:')
    const plain = decryptSecret(ref)
    if (!plain) {
      // enc: 且当前账户无法解密（换 Windows 账户/加密能力缺失）→ 保留原值待修复。
      report.keptFailed += 1
      report.rows.push({ kind: table.kind, id: row.id, status: 'kept-failed', rotatedRecommended: false })
      continue
    }

    try {
      // 来源在迁移阶段取行的 base_url；旧 providers 表与 model_connections 都有 base_url 列。
      const baseUrlRow = input.database
        .prepare(`SELECT base_url FROM ${table.kind === 'provider' ? 'providers' : 'model_connections'} WHERE id = ?`)
        .get(row.id) as { base_url?: string } | undefined
      const origin = originOfSafe(baseUrlRow?.base_url)
      await input.vault.writeSecret({
        kind: table.kind,
        id: row.id,
        origin,
        source: 'migrated',
        scope: 'app.run',
        plain
      })
      // 引用替换带原值守卫：并发写入或重复迁移不会覆盖新值。
      input.database
        .prepare(`UPDATE ${table.kind === 'provider' ? 'providers' : 'model_connections'} SET ${table.refColumn} = ? WHERE id = ? AND ${table.refColumn} = ?`)
        .run(vaultRef(table.kind, row.id), row.id, ref)
      report.migrated += 1
      if (bareOrPlain) report.rotatedRecommended += 1
      report.rows.push({ kind: table.kind, id: row.id, status: 'migrated', rotatedRecommended: bareOrPlain })
    } catch {
      // TPM 不可用等：保留原值，下次启动重试。
      report.keptFailed += 1
      report.rows.push({ kind: table.kind, id: row.id, status: 'kept-failed', rotatedRecommended: bareOrPlain })
    }
  }
}

function originOfSafe(baseUrl: string | undefined | null): string {
  if (!baseUrl) return 'unknown'
  try {
    const url = new URL(baseUrl)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'unknown'
  }
}
