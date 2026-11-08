/**
 * 授权存储：与项目数据分离的 `<dataDir>/security/` 目录。
 *
 * - license-current.json：当前生效授权（信封）+ 签发人证书信封；
 * - license-state.json：历史最大授权序号、上次已接受系统 UTC、已应用策略序号
 *   与撤销名单（识别普通回拨与旧文件覆盖）；
 * - pending-request.json：导出申请后暂存的请求摘要（激活成功后删除）。
 *
 * 全部写入走「同卷临时文件 + 原子替换」；进程内单写者队列避免并发交错。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Envelope } from '@free-creation/license-protocol'

export interface StoredLicenseFile {
  version: 1
  license: Envelope
  /** 签发人证书信封（由根签名）。缺少时授权无法验证。 */
  issuerCert: Envelope
  storedAtUtcSec: number
}

export interface LicenseStateFile {
  version: 1
  maxSequenceSeen: number
  /** 上一次判定 active 时已接受的系统 UTC 秒；识别普通时钟回拨。 */
  lastAcceptedUtcSec: number | null
  appliedPolicySequence: number
  revokedLicenseIds: string[]
  revokedIssuerCertIds: string[]
  updatedAtUtcSec: number
}

export interface PendingRequestFile {
  version: 1
  requestId: string
  /** .csreq 规范 JSON 文本，用于挑战摘要比对。 */
  requestText: string
  /** requestText 规范字节的 SHA-256（十六进制）。 */
  requestSha256: string
  deviceSummary: string
  createdAtUtcSec: number
}

function freshState(nowSec: number): LicenseStateFile {
  return {
    version: 1,
    maxSequenceSeen: 0,
    lastAcceptedUtcSec: null,
    appliedPolicySequence: 0,
    revokedLicenseIds: [],
    revokedIssuerCertIds: [],
    updatedAtUtcSec: nowSec
  }
}

export class LicenseStore {
  private readonly licensePath: string
  private readonly statePath: string
  private readonly pendingPath: string
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {
    this.licensePath = join(dir, 'license-current.json')
    this.statePath = join(dir, 'license-state.json')
    this.pendingPath = join(dir, 'pending-request.json')
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmpPath = join(this.dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
    await writeFile(tmpPath, text, { mode: 0o600 })
    await rename(tmpPath, path)
  }

  /** 进程内单写者：所有读改写串行执行，避免交错丢失更新。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task)
    this.writeQueue = run.catch(() => undefined)
    return run
  }

  async readStoredLicense(): Promise<StoredLicenseFile | null> {
    if (!existsSync(this.licensePath)) return null
    const raw = await readFile(this.licensePath, 'utf8')
    const parsed = JSON.parse(raw) as StoredLicenseFile
    if (parsed.version !== 1 || !parsed.license || !parsed.issuerCert) {
      throw new Error('license-current.json 结构非法')
    }
    return parsed
  }

  async writeStoredLicense(file: StoredLicenseFile): Promise<void> {
    await this.enqueue(() => this.writeAtomic(this.licensePath, JSON.stringify(file, null, 2)))
  }

  async readState(nowSec: number): Promise<LicenseStateFile> {
    if (!existsSync(this.statePath)) return freshState(nowSec)
    const raw = await readFile(this.statePath, 'utf8')
    const parsed = JSON.parse(raw) as LicenseStateFile
    if (parsed.version !== 1) return freshState(nowSec)
    return {
      ...freshState(nowSec),
      ...parsed,
      revokedLicenseIds: parsed.revokedLicenseIds ?? [],
      revokedIssuerCertIds: parsed.revokedIssuerCertIds ?? []
    }
  }

  async updateState(
    nowSec: number,
    mutate: (state: LicenseStateFile) => LicenseStateFile
  ): Promise<LicenseStateFile> {
    return this.enqueue(async () => {
      const current = await this.readState(nowSec)
      const next = mutate({ ...current })
      next.updatedAtUtcSec = nowSec
      await this.writeAtomic(this.statePath, JSON.stringify(next, null, 2))
      return next
    })
  }

  async readPendingRequest(): Promise<PendingRequestFile | null> {
    if (!existsSync(this.pendingPath)) return null
    const raw = await readFile(this.pendingPath, 'utf8')
    return JSON.parse(raw) as PendingRequestFile
  }

  async writePendingRequest(file: PendingRequestFile): Promise<void> {
    await this.enqueue(() => this.writeAtomic(this.pendingPath, JSON.stringify(file, null, 2)))
  }

  async clearPendingRequest(): Promise<void> {
    await this.enqueue(() => rm(this.pendingPath, { force: true }))
  }
}
