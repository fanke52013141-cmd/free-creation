import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer } from 'node:http'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  ACCESS_MAX_BYTES,
  ACCESS_OPERATIONS,
  operationResponseSchema,
  nodeAccessDirectory,
  operationDirectory,
  toolInputSchema,
  validateAccessRegistry,
  type AccessOperationId
} from '../shared/agent-access/registry'
import { callLocalOperation, defaultDataDirectory } from './client'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at < 0 ? undefined : argv[at + 1]
  }
  const dataDirectory = option('--data-dir') ?? defaultDataDirectory()
  if (argv[0] === 'key') {
    process.stdout.write(`${Date.now()}:${randomUUID()}\n`)
    return
  }
  if (argv[0] === 'contracts') {
    const errors = validateAccessRegistry()
    if (errors.length) throw new Error('CONTRACT_INVALID')
    process.stdout.write(
      JSON.stringify(
        { apiVersion: 1, operations: operationDirectory(), nodes: nodeAccessDirectory() },
        null,
        2
      ) + '\n'
    )
    return
  }
  if (argv[0] === 'mcp' && argv[1] === 'serve') {
    /**
     * 每个连接一个新 Server：SSE 传输下 Server 与 transport 一对一绑定，
     * 复用同一实例会让第二个客户端抢走第一个的会话。
     */
    const createMcpServer = (): Server => {
      const server = new Server(
        { name: 'canvas-studio-local-agent', version: '1.0.0' },
        { capabilities: { tools: {} } }
      )
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(ACCESS_OPERATIONS).map(([id, spec]) => ({
          name: id.replaceAll('.', '_'),
          description: spec.description,
          inputSchema: z.toJSONSchema(toolInputSchema(id as AccessOperationId)) as {
            type: 'object'
            [key: string]: unknown
          },
          outputSchema: z.toJSONSchema(operationResponseSchema(id as AccessOperationId)) as {
            type: 'object'
            [key: string]: unknown
          },
          annotations: {
            readOnlyHint: spec.effect === 'read',
            destructiveHint: spec.effect !== 'read',
            idempotentHint: true,
            openWorldHint: false
          }
        }))
      }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const id = Object.keys(ACCESS_OPERATIONS).find(
          (candidate) => candidate.replaceAll('.', '_') === request.params.name
        ) as AccessOperationId | undefined
        // 协议层失败也给**结构化**回执：真实 Agent 要能按 error.code 分支，
        // 不能只收到一串纯文本（否则"缺幂等键"和"字段类型不对"无法区分）。
        // detail 只放字段路径，不放请求正文、路径或密钥。
        const protocolFailure = (
          code: string,
          phase: string,
          detail?: string
        ): {
          isError: true
          structuredContent: Record<string, unknown>
          content: Array<{ type: 'text'; text: string }>
        } => {
          // 必须满足 operationResponseSchema（strict）：含 traceId，失败态不带 data。
          const failure = {
            apiVersion: 1 as const,
            requestId: String(request.params.arguments?.requestId ?? '') || `mcp-${Date.now()}`,
            operationId: id ?? String(request.params.name),
            traceId: 'unavailable',
            status: 'failed' as const,
            error: { code, phase, retryable: false, ...(detail ? { detail } : {}) }
          }
          return {
            isError: true,
            structuredContent: failure,
            content: [{ type: 'text' as const, text: JSON.stringify(failure) }]
          }
        }
        if (!id) return protocolFailure('UNSUPPORTED_OPERATION', 'dispatch')
        const parsed = toolInputSchema(id).safeParse(request.params.arguments)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const path = issue?.path.join('.') || 'input'
          return protocolFailure(
            'INVALID_INPUT',
            'validate',
            (path + ': ' + (issue?.message ?? 'invalid')).slice(0, 200)
          )
        }
        const response = await callLocalOperation(
          id,
          parsed.data as { input: unknown; requestId?: string; idempotencyKey?: string },
          dataDirectory
        )
        return {
          isError: response.status !== 'completed',
          structuredContent: { ...response },
          content: [{ type: 'text', text: JSON.stringify(response) }]
        }
      })
      return server
    }

    const transportKind = option('--transport') ?? 'stdio'

    if (transportKind === 'stdio') {
      const server = createMcpServer()
      const transport = new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: ACCESS_MAX_BYTES
      })
      await server.connect(transport)
      process.stdin.once('end', () => {
        void server.close()
      })
      return
    }

    if (transportKind === 'sse') {
      /**
       * SSE 传输（给只支持 SSE 的客户端用）。
       *
       * 安全边界（缺一不可）：
       * - 只监听 127.0.0.1，不对外网暴露；
       * - 必须带本进程随机生成的令牌（?token=），否则 401；
       * - 令牌只写到 stdout 供本机客户端发现，不落盘、不进日志。
       * 实际操作仍走本机受控套接字（connection.json 的令牌），桌面侧鉴权不变。
       */
      const requestedPort = Number(option('--port') ?? '0')
      const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0
      const token = randomUUID()
      const sessions = new Map<string, SSEServerTransport>()
      const http = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.searchParams.get('token') !== token) {
          response.writeHead(401, { 'content-type': 'text/plain' })
          response.end('unauthorized')
          return
        }
        if (url.pathname === '/sse' && request.method === 'GET') {
          void (async () => {
            // endpoint 必须带上令牌：客户端会把消息 POST 到这个地址，
            // 不带令牌的话它自己的请求会被下面的令牌校验挡掉（401）。
            // endpoint 必须带上令牌：客户端会把消息 POST 到这个地址，
            // 不带令牌的话它自己的请求会被下面的令牌校验挡掉（401）。
            const transport = new SSEServerTransport(`/messages?token=${token}`, response)
            sessions.set(transport.sessionId, transport)
            const server = createMcpServer()
            await server.connect(transport)
            response.on('close', () => {
              sessions.delete(transport.sessionId)
              void server.close()
            })
          })()
          return
        }
        if (url.pathname === '/messages' && request.method === 'POST') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const transport = sessions.get(sessionId)
          if (!transport) {
            response.writeHead(404, { 'content-type': 'text/plain' })
            response.end('unknown session')
            return
          }
          void transport.handlePostMessage(request as never, response as never)
          return
        }
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found')
      })
      await new Promise<void>((resolveListen) => http.listen(port, '127.0.0.1', resolveListen))
      const address = http.address()
      const actualPort = address && typeof address === 'object' ? address.port : port
      // 发现信息只走 stdout：本机客户端据此连接。
      process.stdout.write(
        JSON.stringify({ transport: 'sse', url: `http://127.0.0.1:${actualPort}/sse`, token }) + '\n'
      )
      return
    }

    throw new Error('UNSUPPORTED_TRANSPORT')
  }

  const optionStart = argv.findIndex((argument) => argument.startsWith('--'))
  const command = argv.slice(0, optionStart < 0 ? argv.length : optionStart).join('.')
  const operation = (command === 'status' ? 'app.status' : command) as AccessOperationId
  if (!Object.hasOwn(ACCESS_OPERATIONS, operation)) throw new Error('UNSUPPORTED_OPERATION')
  const file = option('--input-file')
  const bytes = file ? readFileSync(file) : null
  if (bytes && bytes.length > ACCESS_MAX_BYTES) throw new Error('INPUT_TOO_LARGE')
  const raw: unknown = bytes ? JSON.parse(bytes.toString('utf8')) : { input: {} }
  const parsed = toolInputSchema(operation).safeParse(raw)
  if (!parsed.success) throw new Error('INVALID_INPUT')
  const response = await callLocalOperation(
    operation,
    parsed.data as { input: unknown; requestId?: string; idempotencyKey?: string },
    dataDirectory
  )
  process.stdout.write(JSON.stringify(response) + '\n')
  process.exitCode = response.status === 'completed' ? 0 : response.status === 'unknown' ? 3 : 2
}

void main().catch(() => {
  // Fixed protocol failure; never leak parser input, credentials, paths or raw exceptions.
  process.stderr.write('LOCAL_AGENT_COMMAND_FAILED\n')
  process.exitCode = 2
})
