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
import { createIsolatedMcpStore, startMcpServer } from '../../src/mcp/server'

// ── 测试环境 ───────────────────────────────────────────────

let tempDir: string
let stdin: PassThrough
let stdout: PassThrough

function setupServer(): { stdin: PassThrough; stdout: PassThrough } {
  tempDir = mkdtempSync(join(tmpdir(), 'canvas-mcp-test-'))
  process.env.CANVAS_DATA_DIR = tempDir

  stdin = new PassThrough()
  stdout = new PassThrough()

  startMcpServer(stdin as any, stdout as any, createIsolatedMcpStore(tempDir))

  return { stdin, stdout }
}

function sendRequest(stdin: PassThrough, req: Record<string, unknown>): void {
  stdin.write(JSON.stringify(req) + '\n')
}

function readResponse(
  stdout: PassThrough,
  timeout = 3000
): Promise<Record<string, unknown> | null> {
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
      expect(toolNames).toContain('get_run')
      expect(toolNames).toContain('list_runs')
      expect(toolNames).toContain('cancel_run')
      expect(toolNames).toContain('retry_run')

      // 结果类
      expect(toolNames).toContain('list_artifacts')
      expect(toolNames).toContain('get_artifact')
      expect(toolNames).toContain('list_run_artifacts')
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

    it('草稿写入工具应公开 revision 与 idempotency 字段', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list'
      })

      const res = await readResponse(stdout)
      const createNode = res!.result.tools.find(
        (tool: { name: string }) => tool.name === 'create_node'
      ) as { inputSchema: { properties: Record<string, unknown> } }
      expect(createNode.inputSchema.properties.expectedGraphVersion).toBeDefined()
      expect(createNode.inputSchema.properties.idempotencyKey).toBeDefined()
    })
  })

  // ── tools/call ────────────────────────────────────────────

  describe('tools/call', () => {
    it('草稿写入要求 revision/key，重试会返回第一次结果而不会重复创建', async () => {
      const draftIn = new PassThrough()
      const draftOut = new PassThrough()
      const draftStore = createIsolatedMcpStore(tempDir)
      const project = await draftStore.createProject('draft safety')
      startMcpServer(draftIn, draftOut, draftStore, { writeEnabled: true })

      const request = async (
        id: number,
        arguments_: Record<string, unknown>,
        name = 'create_node'
      ): Promise<Record<string, unknown>> => {
        sendRequest(draftIn, {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: arguments_ }
        })
        return (await readResponse(draftOut))!
      }

      const missingSafety = await request(40, {
        projectId: project.id,
        type: 'text'
      })
      expect(missingSafety.result.isError).toBe(true)
      expect(missingSafety.result.content[0].text).toContain('expectedGraphVersion')

      const arguments_ = {
        projectId: project.id,
        type: 'text',
        title: '安全文本',
        expectedGraphVersion: 0,
        idempotencyKey: 'mcp-create-text-0001'
      }
      const first = await request(41, arguments_)
      const firstNode = JSON.parse(first.result.content[0].text) as { id: string }
      const replay = await request(42, arguments_)
      const replayNode = JSON.parse(replay.result.content[0].text) as { id: string }
      expect(replayNode.id).toBe(firstNode.id)
      expect(await draftStore.getNodes(project.id)).toHaveLength(1)

      const conflict = await request(43, { ...arguments_, title: '不同内容' })
      expect(conflict.result.isError).toBe(true)
      expect(conflict.result.content[0].text).toContain('idempotencyKey')

      const deleteArguments = {
        projectId: project.id,
        nodeId: firstNode.id,
        expectedGraphVersion: 1,
        idempotencyKey: 'mcp-delete-text-0001'
      }
      const deleted = await request(44, deleteArguments, 'delete_node')
      const deletedReplay = await request(45, deleteArguments, 'delete_node')
      expect(JSON.parse(deleted.result.content[0].text)).toEqual({ deleted: true })
      expect(JSON.parse(deletedReplay.result.content[0].text)).toEqual({ deleted: true })
      expect(await draftStore.getNodes(project.id)).toHaveLength(0)

      draftIn.destroy()
      draftOut.destroy()
    })

    it('P1：MCP 可完成文本→生图的发现、编排、校验与 dry-run，且画布图数据同步可读', async () => {
      const draftIn = new PassThrough()
      const draftOut = new PassThrough()
      const draftStore = createIsolatedMcpStore(tempDir)
      const project = await draftStore.createProject('P1 text to image')
      startMcpServer(draftIn, draftOut, draftStore, { writeEnabled: true })

      const call = async (
        id: number,
        name: string,
        arguments_: Record<string, unknown>
      ): Promise<Record<string, unknown>> => {
        sendRequest(draftIn, {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: arguments_ }
        })
        return (await readResponse(draftOut))!
      }

      const capability = await call(460, 'get_capability_by_node_type', { nodeType: 'image-gen' })
      expect(capability.result.isError).toBeFalsy()
      expect(JSON.parse(capability.result.content[0].text).outputs[0].id).toBe('out-image')

      const text = await call(461, 'create_node', {
        projectId: project.id,
        type: 'text',
        text: '一只戴红围巾的猫',
        expectedGraphVersion: 0,
        idempotencyKey: 'p1-text-create-0001'
      })
      const textNode = JSON.parse(text.result.content[0].text) as { id: string }

      const image = await call(462, 'create_node', {
        projectId: project.id,
        type: 'image-gen',
        expectedGraphVersion: 1,
        idempotencyKey: 'p1-image-create-0001'
      })
      const imageNode = JSON.parse(image.result.content[0].text) as { id: string }

      const connection = await call(463, 'connect_nodes', {
        projectId: project.id,
        from: { nodeId: textNode.id, portId: 'out-text' },
        to: { nodeId: imageNode.id, portId: 'in-text' },
        expectedGraphVersion: 2,
        idempotencyKey: 'p1-text-image-connect-0001'
      })
      expect(connection.result.isError).toBeFalsy()

      const validation = await call(464, 'validate_workflow', { projectId: project.id })
      expect(JSON.parse(validation.result.content[0].text).valid).toBe(true)
      const estimate = await call(465, 'estimate_run', { projectId: project.id })
      expect(JSON.parse(estimate.result.content[0].text).missingConfigs[0].nodeId).toBe(
        imageNode.id
      )
      const dryRun = await call(466, 'run_workflow', { projectId: project.id, dryRun: true })
      expect(JSON.parse(dryRun.result.content[0].text).runId).toBe('dry-run')

      const saved = await call(467, 'get_project', { projectId: project.id })
      const graph = JSON.parse(saved.result.content[0].text)
      expect(graph.nodes).toHaveLength(2)
      expect(graph.edges).toHaveLength(1)
      expect(graph.meta.graphVersion).toBe(3)

      draftIn.destroy()
      draftOut.destroy()
    })

    it('P1：MCP 真实执行文本→文本并查询终态，正文不会混入 params', async () => {
      const executionIn = new PassThrough()
      const executionOut = new PassThrough()
      const store = createIsolatedMcpStore(tempDir)
      const project = await store.createProject('P1 real execution')
      startMcpServer(executionIn, executionOut, store, {
        writeEnabled: true,
        executionEnabled: true,
        gateway: { listProviders: async () => ({ ok: true, data: [] }) } as any
      })
      const call = async (
        id: number,
        name: string,
        arguments_: Record<string, unknown>
      ): Promise<Record<string, unknown>> => {
        sendRequest(executionIn, {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: arguments_ }
        })
        return (await readResponse(executionOut))!
      }

      const source = await call(470, 'create_node', {
        projectId: project.id,
        type: 'text',
        text: '来自 Agent 的正文',
        params: { marker: 'config-only' },
        expectedGraphVersion: 0,
        idempotencyKey: 'p1-real-source-create-0001'
      })
      const sourceNode = JSON.parse(source.result.content[0].text) as {
        id: string
        content: unknown
      }
      expect(sourceNode.content).toEqual({ kind: 'text', text: '来自 Agent 的正文' })

      const target = await call(471, 'create_node', {
        projectId: project.id,
        type: 'text',
        text: '目标正文',
        expectedGraphVersion: 1,
        idempotencyKey: 'p1-real-target-create-0001'
      })
      const targetNode = JSON.parse(target.result.content[0].text) as { id: string }
      const connected = await call(472, 'connect_nodes', {
        projectId: project.id,
        from: { nodeId: sourceNode.id, portId: 'out-text' },
        to: { nodeId: targetNode.id, portId: 'in-text' },
        expectedGraphVersion: 2,
        idempotencyKey: 'p1-real-connect-0001'
      })
      expect(connected.result.isError).toBeFalsy()

      const run = await call(473, 'run_workflow', { projectId: project.id })
      const runHandle = JSON.parse(run.result.content[0].text) as { runId: string; status: string }
      expect(runHandle.status).toBe('succeeded')
      const queried = await call(474, 'get_run', { runId: runHandle.runId })
      expect(JSON.parse(queried.result.content[0].text).status).toBe('succeeded')

      const saved = await store.getNodes(project.id)
      expect(saved.find((node) => node.id === targetNode.id)?.content).toEqual({
        kind: 'text',
        text: '来自 Agent 的正文\n\n---\n\n目标正文'
      })

      executionIn.destroy()
      executionOut.destroy()
    })

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

    it('默认只读模式必须拒绝节点写入', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 171,
        method: 'tools/call',
        params: {
          name: 'create_node',
          arguments: { projectId: 'project_123', type: 'text' }
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBe(true)
      expect(res!.result.content[0].text).toContain('写入已安全关闭')
    })

    it('应在调用服务前拒绝非法项目 ID', async () => {
      sendRequest(stdin, {
        jsonrpc: '2.0',
        id: 172,
        method: 'tools/call',
        params: {
          name: 'get_project',
          arguments: { projectId: '../../outside' }
        }
      })

      const res = await readResponse(stdout)
      expect(res!.result.isError).toBe(true)
      expect(res!.result.content[0].text).toContain('输入无效')
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
