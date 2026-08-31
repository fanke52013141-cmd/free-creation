/**
 * MCP Server 测试
 *
 * 验证 MCP 协议实现：initialize、tools/list、tools/call、resources/list、resources/read。
 * 使用 PassThrough 流模拟 stdio 通信。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PassThrough } from 'stream'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { startMcpServer } from '../../src/mcp/server'

// ── 测试环境 ───────────────────────────────────────────────

let tempDir: string
let stdin: PassThrough
let stdout: PassThrough

function setupServer(): { stdin: PassThrough; stdout: PassThrough } {
  tempDir = mkdtempSync(join(tmpdir(), 'canvas-mcp-test-'))
  process.env.CANVAS_DATA_DIR = tempDir

  stdin = new PassThrough()
  stdout = new PassThrough()

  startMcpServer(stdin as any, stdout as any)

  return { stdin, stdout }
}

function sendRequest(stdin: PassThrough, req: Record<string, unknown>): void {
  stdin.write(JSON.stringify(req) + '\n')
}

function readResponse(stdout: PassThrough, timeout = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buffer = ''
    const timer = setTimeout(() => {
      stdout.removeAllListeners('data')
      resolve(buffer.trim() ? JSON.parse(buffer.trim()) : null)
    }, timeout)

    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const idx = buffer.indexOf('\n')
      if (idx !== -1) {
        clearTimeout(timer)
        stdout.removeAllListeners('data')
        const line = buffer.slice(0, idx).trim()
        resolve(line ? JSON.parse(line) : null)
      }
    })
  })
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── 辅助：创建项目并获取 ID ───────────────────────────────

async function createProject(): Promise<string> {
  const req = {
    jsonrpc: '2.0',
    id: `create-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: 'create_node',
      arguments: {} as Record<string, unknown>
    }
  }
  // 先用 resources 方式不行——需要通过 project 命令。
  // MCP 的 project 创建通过 createProject Service，
  // 但 MCP 工具列表中没有 create_project 工具。
  // 我们通过直接调用 ProjectService 来创建。
  // 实际上需要通过 store 创建——这里我们暂时跳过需要项目的测试，
  // 先验证不需要项目的协议级别测试。
  return req.id
}

// ── 测试 ───────────────────────────────────────────────────

describe('MCP Server', () => {
  beforeEach(() => {
    setupServer()
  })

  afterEach(() => {
    stdin.destroy()
    stdout.destroy()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    delete process.env.CANVAS_DATA_DIR
  })

  // ── initialize ────────────────────────────────────────────

  describe('initialize', () => {
    it('应返回协议版本和服务器信息', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize'
      })

      const res = await readResponse(stdout)
      expect(res).toBeDefined()
      expect(res!.jsonrpc).toBe('2.0')
      expect(res!.id).toBe(1)
      expect(res!.result).toBeDefined()
      expect(res!.result.protocolVersion).toBe('2024-11-05')
      expect(res!.result.serverInfo.name).toBe('canvas-studio')
      expect(res!.result.capabilities.tools).toBeDefined()
    })
  })

  // ── notifications/initialized ─────────────────────────────

  describe('notifications/initialized', () => {
    it('通知不需要响应', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      })

      // 等待一小段时间确认没有响应
      const res = await readResponse(stdout, 1000)
      expect(res).toBeNull()
    })
  })

  // ── tools/list ────────────────────────────────────────────

  describe('tools/list', () => {
    it('应返回工具列表', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      })

      const res = await readResponse(stdout)
      expect(res).toBeDefined()
      expect(res!.result.tools).toBeDefined()
      expect(Array.isArray(res!.result.tools)).toBe(true)
      expect(res!.result.tools.length).toBeGreaterThan(0)
    })

    it('应包含核心工具', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list'
      })

      const res = await readResponse(stdout)
      const toolNames = res!.result.tools.map((t: any) => t.name)

      // 查询类
      expect(toolNames).toContain('list_projects')
      expect(toolNames).toContain('get_project')
      expect(toolNames).toContain('list_node_types')
      expect(toolNames).toContain('get_capability')

      // 编辑类
      expect(toolNames).toContain('create_node')
      expect(toolNames).toContain('configure_node')
      expect(toolNames).toContain('delete_node')
      expect(toolNames).toContain('connect_nodes')
      expect(toolNames).toContain('disconnect_nodes')

      // 验证类
      expect(toolNames).toContain('validate_workflow')
      expect(toolNames).toContain('estimate_run')

      // 执行类
      expect(toolNames).toContain('run_node')
      expect(toolNames).toContain('run_workflow')
    })

    it('每个工具应有 name、description 和 inputSchema', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list'
      })

      const res = await readResponse(stdout)
      for (const tool of res!.result.tools) {
        expect(tool.name).toBeDefined()
        expect(tool.description).toBeDefined()
        expect(tool.inputSchema).toBeDefined()
        expect(tool.inputSchema.type).toBe('object')
      }
    })
  })

  // ── tools/call ────────────────────────────────────────────

  describe('tools/call', () => {
    it('list_projects 应返回数组', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'list_projects',
          arguments: {}
        }
      })

      const res = await readResponse(stdout)
      expect(res).toBeDefined()
      expect(res!.result).toBeDefined()
      expect(res!.result.isError).toBeFalsy()
      expect(res!.result.content[0].type).toBe('text')

      const data = JSON.parse(res!.result.content[0].text)
      expect(Array.isArray(data)).toBe(true)
    })

    it('list_node_types 应返回能力列表', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'list_node_types',
          arguments: {}
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBeFalsy()

      const data = JSON.parse(res!.result.content[0].text)
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThan(0)

      // 每个能力应有 id、nodeType、title
      const first = data[0]
      expect(first.id).toBeDefined()
      expect(first.nodeType).toBeDefined()
      expect(first.title).toBeDefined()
    })

    it('list_node_types 按 MCP 过滤应只返回 mcp 暴露的能力', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'list_node_types',
          arguments: { exposure: 'mcp' }
        }
      })

      const res = await readResponse(stdout)
      const data = JSON.parse(res!.result.content[0].text)
      for (const cap of data) {
        expect(cap.expose.mcp).toBe(true)
      }
    })

    it('get_capability 应返回能力定义', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'get_capability',
          arguments: { capabilityId: 'text.source' }
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBeFalsy()

      const data = JSON.parse(res!.result.content[0].text)
      expect(data.id).toBe('text.source')
      expect(data.nodeType).toBe('text')
      expect(data.inputs).toBeDefined()
      expect(data.outputs).toBeDefined()
      expect(data.configSchema).toBeDefined()
    })

    it('get_capability 对未知 ID 应返回错误', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'get_capability',
          arguments: { capabilityId: 'nonexistent.cap' }
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBe(true)
    })

    it('get_capability_by_node_type 应按节点类型返回', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: 'get_capability_by_node_type',
          arguments: { nodeType: 'text' }
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBeFalsy()

      const data = JSON.parse(res!.result.content[0].text)
      expect(data.nodeType).toBe('text')
    })

    it('validate_node_config 应校验节点配置', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: 'validate_node_config',
          arguments: {
            nodeType: 'text',
            config: { text: '你好' }
          }
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBeFalsy()

      const data = JSON.parse(res!.result.content[0].text)
      expect(data.valid).toBeDefined()
    })

    it('未知工具应返回错误', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'nonexistent_tool',
          arguments: {}
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBe(true)
    })

    it('缺少工具名应返回 JSON-RPC 错误', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: {
          arguments: {}
        }
      })

      const res = await readResponse(stdout)
      expect(res!.error).toBeDefined()
      expect(res!.error.code).toBe(-32602)
    })
  })

  // ── resources/list ────────────────────────────────────────

  describe('resources/list', () => {
    it('应返回资源列表', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 20,
        method: 'resources/list'
      })

      const res = await readResponse(stdout)
      expect(res!.result.resources).toBeDefined()
      expect(Array.isArray(res!.result.resources)).toBe(true)
      expect(res!.result.resources.length).toBeGreaterThan(0)
    })

    it('应包含 capabilities 资源', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 21,
        method: 'resources/list'
      })

      const res = await readResponse(stdout)
      const uris = res!.result.resources.map((r: any) => r.uri)
      expect(uris).toContain('canvas://capabilities')
    })
  })

  // ── resources/read ────────────────────────────────────────

  describe('resources/read', () => {
    it('应返回 capabilities 资源内容', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 22,
        method: 'resources/read',
        params: { uri: 'canvas://capabilities' }
      })

      const res = await readResponse(stdout)
      expect(res!.result.contents).toBeDefined()
      expect(res!.result.contents[0].uri).toBe('canvas://capabilities')
      expect(res!.result.contents[0].mimeType).toBe('application/json')

      const data = JSON.parse(res!.result.contents[0].text)
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThan(0)
    })

    it('未知资源 URI 应返回错误', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 23,
        method: 'resources/read',
        params: { uri: 'canvas://unknown' }
      })

      const res = await readResponse(stdout)
      expect(res!.error).toBeDefined()
    })
  })

  // ── 未知方法 ──────────────────────────────────────────────

  describe('未知方法', () => {
    it('应返回 method not found 错误', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 30,
        method: 'unknown/method'
      })

      const res = await readResponse(stdout)
      expect(res!.error).toBeDefined()
      expect(res!.error.code).toBe(-32601)
    })
  })

  // ── 完整 Agent 交互流程 ─────────────────────────────────

  describe('Agent 交互流程', () => {
    it('initialize → tools/list → list_node_types 全流程', async () => {
      // 1. initialize
      sendRequest(stdin, { jsonrpc: '2.0', id: 's1', method: 'initialize' })
      const initRes = await readResponse(stdout)
      expect(initRes!.result.protocolVersion).toBe('2024-11-05')

      // 2. tools/list
      sendRequest(stdin, { jsonrpc: '2.0', id: 's2', method: 'tools/list' })
      const listRes = await readResponse(stdout)
      expect(listRes!.result.tools.length).toBeGreaterThan(10)

      // 3. list_node_types
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 's3',
        method: 'tools/call',
        params: { name: 'list_node_types', arguments: {} }
      })
      const typesRes = await readResponse(stdout)
      const types = JSON.parse(typesRes!.result.content[0].text)
      expect(types.length).toBeGreaterThan(0)

      // 4. get_capability
      const firstCap = types[0]
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 's4',
        method: 'tools/call',
        params: { name: 'get_capability', arguments: { capabilityId: firstCap.id } }
      })
      const capRes = await readResponse(stdout)
      const cap = JSON.parse(capRes!.result.content[0].text)
      expect(cap.id).toBe(firstCap.id)
    })
  })
})
