import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer } from 'node:http'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  ACCESS_MAX_BYTES,
  ACCESS_OPERATIONS,
  nodeAccessDirectory,
  operationDirectory,
  toolInputSchema,
  validateAccessRegistry,
  type AccessOperationId
} from '../shared/agent-access/registry'
import {
  buildMcpToolsList,
  MCP_META_TOOL_NAMES,
  MCP_SERVER_INSTRUCTIONS,
  parseOpsCallArgs,
  resolveMcpProfile,
  runOpsSchema,
  runOpsSearch
} from './mcp-profile'
import { callLocalOperation, defaultDataDirectory } from './client'
import { CliInputError, cliFailure, parseCliInput, writeCliResponse } from './cli'

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
    const profile = resolveMcpProfile(argv)
    /**
     * 每个连接一个新 Server：SSE 传输下 Server 与 transport 一对一绑定，
     * 复用同一实例会让第二个客户端抢走第一个的会话。
     */
    const createMcpServer = (): Server => {
      const server = new Server(
        { name: 'canvas-studio-local-agent', version: '1.0.0' },
        {
          capabilities: { tools: {} },
          instructions: MCP_SERVER_INSTRUCTIONS
        }
      )
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: buildMcpToolsList(profile)
      }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = String(request.params.name)
        // 元工具（core 档位渐进发现）：本地查表或按同一校验/门禁通道透传调用。
        if (toolName === MCP_META_TOOL_NAMES.search) {
          const res = runOpsSearch(request.params.arguments)
          if (!res.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: { code: res.code, detail: res.detail } })
                }
              ]
            }
          }
          return {
            isError: false,
            structuredContent: res.data,
            content: [{ type: 'text', text: JSON.stringify(res.data) }]
          }
        }
        if (toolName === MCP_META_TOOL_NAMES.schema) {
          const res = runOpsSchema(request.params.arguments)
          if (!res.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: { code: res.code, detail: res.detail } })
                }
              ]
            }
          }
          return {
            isError: false,
            structuredContent: res.data,
            content: [{ type: 'text', text: JSON.stringify(res.data) }]
          }
        }

        let targetOperationId: AccessOperationId | undefined
        let rawArguments: unknown = request.params.arguments
        if (toolName === MCP_META_TOOL_NAMES.call) {
          const unwrapped = parseOpsCallArgs(request.params.arguments)
          if (!unwrapped.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: { code: unwrapped.code, detail: unwrapped.detail } })
                }
              ]
            }
          }
          targetOperationId = unwrapped.operationId
          rawArguments = unwrapped.args
        } else {
          targetOperationId = Object.keys(ACCESS_OPERATIONS).find(
            (candidate) => candidate.replaceAll('.', '_') === toolName
          ) as AccessOperationId | undefined
        }
        const id = targetOperationId
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
            requestId:
              String((rawArguments as Record<string, unknown> | undefined)?.requestId ?? '') ||
              `mcp-${Date.now()}`,
            operationId: id ?? toolName,
            traceId: 'unavailable',
            status: 'failed' as const,
            error: { code, phase, retryable: false, ...(detail ? { detail } : {}) }
          }
          return {
            isError: true,
            structuredContent: failure,
            content: [{ type: 'text', text: JSON.stringify(failure) }]
          }
        }
        if (!id) return protocolFailure('UNSUPPORTED_OPERATION', 'dispatch')
        const parsed = toolInputSchema(id).safeParse(rawArguments)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const path = issue?.path.join('.') || 'input'
          return protocolFailure(
            'INVALID_INPUT',
            'validate',
            (path + ': ' + (issue?.message ?? 'invalid')).slice(0, 200)
          )
        }
        const clientName = server.getClientVersion()?.name
        const clientId = clientName
          ? `mcp-${createHash('sha256').update(clientName).digest('hex').slice(0, 16)}`
          : 'mcp'
        const response = await callLocalOperation(
          id,
          parsed.data as { input: unknown; requestId?: string; idempotencyKey?: string },
          dataDirectory,
          clientId
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
       * - 必须带本进程随机生成的令牌（Authorization: Bearer），否则 401；
       * - URL 不携带令牌，令牌只写到 stdout 供本机客户端发现，不落盘、不进日志。
       * 实际操作仍走本机受控套接字（connection.json 的令牌），桌面侧鉴权不变。
       */
      const requestedPort = Number(option('--port') ?? '0')
      const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0
      const token = randomUUID()
      const sessions = new Map<string, SSEServerTransport>()
      const http = createServer((request, response) => {
        const hostHeader = request.headers.host ?? ''
        const hostName = hostHeader.startsWith('[')
          ? hostHeader.slice(1, hostHeader.indexOf(']'))
          : hostHeader.split(':')[0]
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostName ?? '')) {
          response.writeHead(403, { 'content-type': 'text/plain' })
          response.end('forbidden')
          return
        }
        const origin = request.headers.origin
        if (origin) {
          try {
            const parsedOrigin = new URL(origin)
            if (
              !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedOrigin.hostname) ||
              parsedOrigin.port !== String(request.socket.localPort)
            )
              throw new Error('origin')
          } catch {
            response.writeHead(403, { 'content-type': 'text/plain' })
            response.end('forbidden')
            return
          }
        }
        const authorization = request.headers.authorization
        const suppliedToken =
          typeof authorization === 'string' && /^Bearer [^\s]+$/i.test(authorization)
            ? authorization.slice(7)
            : ''
        const supplied = Buffer.from(suppliedToken)
        const expected = Buffer.from(token)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          response.writeHead(401, {
            'content-type': 'text/plain',
            'www-authenticate': 'Bearer realm="canvas-local-agent"'
          })
          response.end('unauthorized')
          return
        }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/sse' && request.method === 'GET') {
          void (async () => {
            // endpoint 只携带随机会话 ID；每条请求都由 Authorization 请求头鉴权。
            const transport = new SSEServerTransport('/messages', response)
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
        JSON.stringify({ transport: 'sse', url: `http://127.0.0.1:${actualPort}/sse`, token }) +
          '\n'
      )
      return
    }

    throw new Error('UNSUPPORTED_TRANSPORT')
  }

  const optionStart = argv.findIndex((argument) => argument.startsWith('--'))
  const command = argv.slice(0, optionStart < 0 ? argv.length : optionStart).join('.')
  const operation = (command === 'status' ? 'app.status' : command) as AccessOperationId
  if (!Object.hasOwn(ACCESS_OPERATIONS, operation)) {
    writeCliResponse(cliFailure(operation, 'UNSUPPORTED_OPERATION', 'dispatch'))
    return
  }
  let raw: unknown
  try {
    raw = parseCliInput(option('--input-file'))
  } catch (error) {
    if (error instanceof CliInputError) {
      writeCliResponse(cliFailure(operation, error.code, error.phase))
      return
    }
    throw error
  }
  const parsed = toolInputSchema(operation).safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || 'input'
    writeCliResponse(
      cliFailure(
        operation,
        'INVALID_INPUT',
        'validate',
        undefined,
        `${path}: ${issue?.message ?? 'invalid'}`
      )
    )
    return
  }
  const response = await callLocalOperation(
    operation,
    parsed.data as { input: unknown; requestId?: string; idempotencyKey?: string },
    dataDirectory
  )
  writeCliResponse(response)
}

void main().catch((error: unknown) => {
  // MCP stdio 的 stdout 只能写协议消息；CLI 则必须输出结构化 JSON 失败信封。
  if (process.argv[2] === 'mcp') {
    process.stderr.write('LOCAL_AGENT_COMMAND_FAILED\n')
    process.exitCode = 2
    return
  }
  const code = error instanceof CliInputError ? error.code : 'LOCAL_AGENT_COMMAND_FAILED'
  const phase = error instanceof CliInputError ? error.phase : 'dispatch'
  writeCliResponse(cliFailure('invalid', code, phase))
  process.stderr.write('LOCAL_AGENT_COMMAND_FAILED\n')
})
