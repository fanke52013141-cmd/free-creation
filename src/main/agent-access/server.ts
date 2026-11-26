import { createServer, type Server, type Socket } from 'node:net'
import { spawnSync } from 'node:child_process'
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
import {
  ACCESS_MAX_BYTES,
  ACCESS_OPERATIONS,
  type AccessOperationId
} from '../../shared/agent-access/registry'
import { acquireProcessLock } from '../store/process-lock'
import { emitDomainEvent } from '../diagnostics/ipc-domain-events'
import { responseTimeoutMs } from '../../shared/agent-access/interactive'
import { LocalAccessService } from './service'
import { settleOrphanedExternalRuns } from './runs'
import type { AccessDesktop } from './desktop'
import type { DiagnosticsService } from '../diagnostics/service'

/**
 * Windows 上 mode 不会收紧文件 ACL。用系统自带的 .NET 安全 API 将临时发现文件
 * 设为仅当前用户可读写；失败时拒绝发布发现信息，不能静默回退到宽权限。
 */
function restrictWindowsFileToCurrentUser(filePath: string): void {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -TypeDefinition "using System; using System.IO; using System.Security.AccessControl; using System.Security.Principal; public static class CanvasDescriptorAcl { public static void Apply(string path) { var identity = WindowsIdentity.GetCurrent(); var rule = new FileSystemAccessRule(identity.User, FileSystemRights.FullControl, AccessControlType.Allow); var acl = new FileSecurity(); acl.SetOwner(identity.User); acl.SetAccessRuleProtection(true, false); acl.AddAccessRule(rule); File.SetAccessControl(path, acl); } }"',
    '[CanvasDescriptorAcl]::Apply($env:CANVAS_AGENT_DESCRIPTOR_PATH)'
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded
    ],
    {
      env: { ...process.env, CANVAS_AGENT_DESCRIPTOR_PATH: filePath },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }
  )
  if (result.error || result.status !== 0) {
    try {
      rmSync(filePath, { force: true })
    } catch {
      // 清理失败也不改变关闭本地接入的决定。
    }
    throw new Error('WINDOWS_DESCRIPTOR_ACL_FAILED')
  }
}

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
  const temporary = join(directory, `${instanceId}.tmp`)
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
        try {
          const message = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
            token?: unknown
            instanceId?: unknown
            request?: unknown
          }
          const request = message.request as
            | { operationId?: unknown; input?: unknown; requestId?: unknown }
            | undefined
          const operationId = typeof request?.operationId === 'string' ? request.operationId : ''
          const waitInput = request?.input as { timeoutMs?: unknown } | undefined
          const requestedWaitMs =
            operationId === 'run.wait' && typeof waitInput?.timeoutMs === 'number'
              ? Math.min(Math.max(waitInput.timeoutMs, 0), 120_000)
              : 0
          // 请求已到达：按 shared 中的操作元数据覆盖人工确认、长轮询与模型/网络长操作。
          socket.setTimeout(responseTimeoutMs(operationId, requestedWaitMs), () => socket.destroy())
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
            const effect = ACCESS_OPERATIONS[operationId as AccessOperationId]?.effect
            const failure = {
              apiVersion: 1,
              requestId: result.requestId,
              operationId: result.operationId,
              traceId: result.traceId,
              status: effect && effect !== 'read' ? 'unknown' : 'failed',
              error: { code: 'RESPONSE_TOO_LARGE', phase: 'serialize', retryable: false }
            }
            socket.end(JSON.stringify(failure) + '\n')
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
    if (process.platform === 'win32') restrictWindowsFileToCurrentUser(temporary)
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
    try {
      rmSync(temporary, { force: true })
    } catch {
      // 保留原始失败原因。
    }
    if (error instanceof Error && error.message === 'WINDOWS_DESCRIPTOR_ACL_FAILED') throw error
    throw error
  }
}
