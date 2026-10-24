import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
        (id) => id.replaceAll('.', '_') === request.params.name
      ) as AccessOperationId | undefined
      if (!id) return { isError: true, content: [{ type: 'text', text: 'UNSUPPORTED_OPERATION' }] }
      const parsed = toolInputSchema(id).safeParse(request.params.arguments)
      if (!parsed.success)
        return { isError: true, content: [{ type: 'text', text: 'INVALID_INPUT' }] }
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
    const transport = new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: ACCESS_MAX_BYTES
    })
    await server.connect(transport)
    process.stdin.once('end', () => {
      void server.close()
    })
    return
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
