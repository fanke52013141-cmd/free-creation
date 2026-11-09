import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { assertLicenseActive } from '../security/license/gate'
import { tmpdir } from 'node:os'
import { ACCESS_MAX_BYTES } from '../../shared/agent-access/registry'
import { acquireProcessLock } from '../store/process-lock'
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'
import { RUN_WAIT_MAX_TIMEOUT_MS } from '../../shared/agent-access/run-ops'

/** 收到请求后的等待上限：覆盖契约内的最长 run.wait，并为慢操作留余量。 */
const ACCESS_SOCKET_RESPONSE_TIMEOUT_MS = RUN_WAIT_MAX_TIMEOUT_MS + 90_000
import { LocalAccessService } from './service'
import { settleOrphanedExternalRuns } from './runs'
import type { AccessDesktop } from './desktop'
import type { DiagnosticsService } from '../diagnostics/service'

export interface LocalAccessServer {
  close(): void
}
export async function startLocalAccessServer(options: {
  dataDirectory: string
  appVersion: string
  activeProjectId: () => string | null
  desktop?: AccessDesktop
  diagnostics?: Pick<DiagnosticsService, 'health'> | null
  /**
   * 桌面宿主首次启动接入服务时结算遗留任务。进程锁保证此刻没有其他存活宿主，
   * 因此所有非终态 external_runs 都已失去执行者。测试内的服务重启不传。
   */
  settleOrphanedRuns?: boolean
}): Promise<LocalAccessServer> {
  // 授权守卫（方案 §3.3）：外部接入只在有效授权下开启。
  assertLicenseActive('agent.access.start')
  const ownership = acquireProcessLock('local-agent-access-server')
  if (options.settleOrphanedRuns) {
    const settled = settleOrphanedExternalRuns()
    if (settled.length > 0)
      emitDomainEvent('agent.access.runs_settled', '宿主重启后结算遗留外部任务', {
        status: 'failed',
        attributes: {
          count: settled.length,
          states: [...new Set(settled.map((row) => row.from))].join(',')
        }
      })
  }
  const instanceId = randomUUID()
  const token = randomBytes(32).toString('hex')
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\canvas-studio-agent-${instanceId}`
      : join(tmpdir(), `canvas-agent-${process.getuid?.() ?? 'local'}-${instanceId}.sock`)
  const directory = join(realpathSync(options.dataDirectory), 'agent-access')
  const descriptorPath = join(directory, 'connection.json')
  const sockets = new Set<Socket>()
  let server: Server | undefined
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const child = relative(realpathSync(options.dataDirectory), realpathSync(directory))
    if (child !== 'agent-access' || isAbsolute(child)) throw new Error('ACCESS_DIRECTORY_INVALID')
    const service = new LocalAccessService({
      ...options,
      instanceId,
      exportDirectory: join(options.dataDirectory, 'agent-exports')
    })
    server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      socket.setTimeout(15000, () => socket.destroy())
      let buffer = Buffer.alloc(0)
      let handled = false
      socket.on('data', async (chunk: Buffer) => {
        if (handled) return
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > ACCESS_MAX_BYTES) {
          socket.destroy()
          return
        }
        const newline = buffer.indexOf(10)
        if (newline < 0) return
        handled = true
        socket.pause()
        // 请求已到达：run.wait 最长可等待 RUN_WAIT_MAX_TIMEOUT_MS，等待回执期间
        // 没有下行流量，不能被 15s 空闲超时切断（否则长轮询必然 OUTCOME_UNKNOWN）。
        socket.setTimeout(ACCESS_SOCKET_RESPONSE_TIMEOUT_MS, () => socket.destroy())
        try {
          const message = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
            token?: unknown
            instanceId?: unknown
            request?: unknown
          }
          const supplied =
            typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0)
          const expected = Buffer.from(token)
          if (
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected) ||
            message.instanceId !== instanceId
          ) {
            socket.destroy()
            return
          }
          const result = await service.dispatch(message.request)
          const encoded = JSON.stringify(result)
          if (Buffer.byteLength(encoded) > ACCESS_MAX_BYTES) {
            socket.destroy()
            return
          }
          socket.end(encoded + '\n')
        } catch {
          socket.destroy()
        }
      })
    })
    server.maxConnections = 16
    const listener = server
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(endpoint, () => {
        listener.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600)
    listener.on('error', () => {
      for (const socket of sockets) socket.destroy()
    })
    const temporary = join(directory, `${instanceId}.tmp`)
    writeFileSync(
      temporary,
      JSON.stringify({
        apiVersion: 1,
        instanceId,
        dataStoreId: service.dataStoreId,
        token,
        endpoint,
        appVersion: options.appVersion,
        pid: process.pid
      }),
      { mode: 0o600, flag: 'wx' }
    )
    renameSync(temporary, descriptorPath)
    return {
      close(): void {
        for (const socket of sockets) socket.destroy()
        listener.close()
        try {
          ownership.release(() => {
            try {
              const current = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
                instanceId?: string
              }
              if (current.instanceId === instanceId) rmSync(descriptorPath)
            } catch {
              /* An unavailable descriptor is never a reason to delete another file. */
            }
          })
        } catch {
          // Storage failure must not prevent application exit. A dead-owner lock is
          // conservatively reclaimed on the next start; a stale endpoint cannot execute work.
        }
      }
    }
  } catch (error) {
    server?.close()
    ownership.release()
    throw error
  }
}
