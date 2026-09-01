/**
 * Canvas Studio MCP Server — Model Context Protocol 服务端
 *
 * 这是 Agent 接入的主要交互入口。提供通用工具集和动态能力契约，
 * Agent 通过这些工具发现能力、创建节点、组装工作流并执行。
 *
 * 设计原则：
 * - MCP 工具保持稳定（通用操作），不为每个节点类型单独创建工具
 * - 能力信息通过 get_capability 动态暴露，新增节点无需修改 MCP
 * - 所有操作返回结构化结果，包含可展示的媒体信息
 *
 * 协议：MCP over stdio（JSON-RPC 2.0）
 */

import {
  agentWriteEnabledFromEnv,
  agentExecutionEnabledFromEnv,
  createServices,
  DesktopProjectStore,
  FileProjectStore
} from '@application'
import type { ServiceContainer, ProjectStore } from '@application'
import { listCapabilities } from '@capabilities'
import type { Readable, Writable } from 'stream'
import { z } from 'zod'
import type { NodeTypeId } from '@shared/types'
import { createHeadlessGateway } from '../main/headless/gateway-client'
import { HeadlessRunExecutor } from '../main/headless/run-executor'

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, '非法项目 ID')
const nodeIdSchema = z.string().min(1).max(128)
const portRefSchema = z.object({
  nodeId: nodeIdSchema,
  portId: z.string().regex(/^(in|out)-[a-z0-9]+(?:-[a-z0-9]+)*$/)
})
const writeSafetySchema = {
  expectedGraphVersion: z.number().int().min(0).optional(),
  idempotencyKey: z.string().min(8).max(128).optional()
}

/**
 * 草稿写入的并发控制字段。它们保持 optional，是为了让 MCP 在默认只读模式
 * 下仍能给出清晰的权限错误；当 CANVAS_AGENT_WRITE=draft 时由服务层强制要求。
 */
const writeSafetyProperties = {
  expectedGraphVersion: {
    type: 'number',
    description: '读取项目时获得的 graphVersion；草稿写入模式必填，用于避免覆盖并发修改'
  },
  idempotencyKey: {
    type: 'string',
    description: '本次写入请求的稳定唯一键（8–128 字符）；草稿写入模式必填，重试必须复用'
  }
} as const

const toolArgumentSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  list_projects: z.object({}).passthrough(),
  get_project: z.object({ projectId: projectIdSchema }),
  list_node_types: z.object({ exposure: z.enum(['desktop', 'cli', 'mcp']).optional() }),
  get_capability: z.object({ capabilityId: z.string().min(3).max(128) }),
  get_capability_by_node_type: z.object({ nodeType: z.string().min(1).max(64) }),
  validate_node_config: z.object({
    nodeType: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown())
  }),
  create_node: z.object({
    projectId: projectIdSchema,
    type: z.string().min(1).max(64),
    title: z.string().max(160).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    ...writeSafetySchema
  }),
  configure_node: z.object({
    projectId: projectIdSchema,
    nodeId: nodeIdSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    title: z.string().max(160).optional(),
    ...writeSafetySchema
  }),
  delete_node: z.object({ projectId: projectIdSchema, nodeId: nodeIdSchema, ...writeSafetySchema }),
  connect_nodes: z.object({
    projectId: projectIdSchema,
    from: portRefSchema,
    to: portRefSchema,
    ...writeSafetySchema
  }),
  disconnect_nodes: z.object({
    projectId: projectIdSchema,
    edgeId: nodeIdSchema,
    ...writeSafetySchema
  }),
  validate_workflow: z.object({
    projectId: projectIdSchema,
    nodeIds: z.array(nodeIdSchema).max(200).optional()
  }),
  estimate_run: z.object({
    projectId: projectIdSchema,
    nodeIds: z.array(nodeIdSchema).max(200).optional()
  }),
  run_node: z.object({
    projectId: projectIdSchema,
    nodeId: nodeIdSchema,
    dryRun: z.boolean().optional()
  }),
  run_workflow: z.object({
    projectId: projectIdSchema,
    nodeIds: z.array(nodeIdSchema).max(200).optional(),
    dryRun: z.boolean().optional()
  }),
  list_artifacts: z.object({ projectId: projectIdSchema })
}

// ── MCP 工具定义 ──────────────────────────────────────────

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

// ── 工具注册 ───────────────────────────────────────────────

export function defineTools(): McpTool[] {
  return [
    // ── 查询类 ──────────────────────────────────
    {
      name: 'list_projects',
      description: '列出所有项目',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_project',
      description: '获取项目详情（含完整图数据）',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' }
        },
        required: ['projectId']
      }
    },
    {
      name: 'list_node_types',
      description: '列出所有可用的节点类型（能力定义）',
      inputSchema: {
        type: 'object',
        properties: {
          exposure: {
            type: 'string',
            enum: ['desktop', 'cli', 'mcp'],
            description: '按暴露入口过滤'
          }
        }
      }
    },
    {
      name: 'get_capability',
      description: '获取指定能力的完整定义（输入/输出端口、配置 Schema、运行时特性）',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityId: { type: 'string', description: '能力 ID（如 image.crop）' }
        },
        required: ['capabilityId']
      }
    },
    {
      name: 'get_capability_by_node_type',
      description: '按节点类型获取能力定义',
      inputSchema: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', description: '节点类型（如 image-crop）' }
        },
        required: ['nodeType']
      }
    },
    {
      name: 'validate_node_config',
      description: '校验节点配置是否符合能力定义',
      inputSchema: {
        type: 'object',
        properties: {
          nodeType: { type: 'string', description: '节点类型' },
          config: { type: 'object', description: '配置对象' }
        },
        required: ['nodeType', 'config']
      }
    },
    // ── 编辑类 ──────────────────────────────────
    {
      name: 'create_node',
      description: '在项目中创建新节点',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          type: { type: 'string', description: '节点类型（如 text, image-gen, video-frame）' },
          title: { type: 'string', description: '节点标题' },
          params: { type: 'object', description: '节点配置参数' },
          ...writeSafetyProperties
        },
        required: ['projectId', 'type']
      }
    },
    {
      name: 'configure_node',
      description: '更新节点配置（参数、标题等）',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          nodeId: { type: 'string', description: '节点 ID' },
          params: { type: 'object', description: '要更新的配置参数' },
          title: { type: 'string', description: '新标题' },
          ...writeSafetyProperties
        },
        required: ['projectId', 'nodeId']
      }
    },
    {
      name: 'delete_node',
      description: '删除节点（同时删除关联连线）',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodeId: { type: 'string' },
          ...writeSafetyProperties
        },
        required: ['projectId', 'nodeId']
      }
    },
    {
      name: 'connect_nodes',
      description: '连接两个节点（从源端口到目标端口）',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          from: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              portId: { type: 'string' }
            },
            description: '源节点和输出端口'
          },
          to: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              portId: { type: 'string' }
            },
            description: '目标节点和输入端口'
          },
          ...writeSafetyProperties
        },
        required: ['projectId', 'from', 'to']
      }
    },
    {
      name: 'disconnect_nodes',
      description: '断开连线',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          edgeId: { type: 'string', description: '连线 ID' },
          ...writeSafetyProperties
        },
        required: ['projectId', 'edgeId']
      }
    },
    // ── 验证类 ──────────────────────────────────
    {
      name: 'validate_workflow',
      description: '校验整个工作流（检查输入完整性、连线类型兼容性、环路检测）',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '限定校验范围（空数组或省略表示全部节点）'
          }
        },
        required: ['projectId']
      }
    },
    {
      name: 'estimate_run',
      description: '预估运行（返回将调用的模型、预计消耗、缺失配置和风险提示）',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodeIds: { type: 'array', items: { type: 'string' } }
        },
        required: ['projectId']
      }
    },
    // ── 执行类 ──────────────────────────────────
    {
      name: 'run_node',
      description: '运行单个节点。返回 runId 和状态，不阻塞等待完成。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodeId: { type: 'string' },
          dryRun: { type: 'boolean', description: '预演模式' }
        },
        required: ['projectId', 'nodeId']
      }
    },
    {
      name: 'run_workflow',
      description: '运行整个工作流或指定范围的节点。返回 runId 和状态。',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          nodeIds: { type: 'array', items: { type: 'string' } },
          dryRun: { type: 'boolean' }
        },
        required: ['projectId']
      }
    },
    // ── 结果类 ──────────────────────────────────
    {
      name: 'list_artifacts',
      description: '列出项目中的媒体产物',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' }
        },
        required: ['projectId']
      }
    }
  ]
}

// ── 工具执行 ───────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  services: ServiceContainer,
  store: ProjectStore
): Promise<McpToolResult> {
  const json = (data: unknown): McpToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  })
  const error = (message: string): McpToolResult => ({
    content: [{ type: 'text', text: message }],
    isError: true
  })

  const schema = toolArgumentSchemas[name]
  if (schema) {
    const parsed = schema.safeParse(args)
    if (!parsed.success) {
      return error(`输入无效: ${parsed.error.issues.map((issue) => issue.message).join('；')}`)
    }
    args = parsed.data
  }

  try {
    switch (name) {
      // 查询类
      case 'list_projects': {
        const result = await services.projectService.listProjects()
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'get_project': {
        const result = await services.projectService.getProject(String(args.projectId))
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'list_node_types': {
        const result = await services.capabilityService.listCapabilities(
          args.exposure as 'desktop' | 'cli' | 'mcp' | undefined
        )
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'get_capability': {
        const result = await services.capabilityService.getCapability(String(args.capabilityId))
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'get_capability_by_node_type': {
        const result = await services.capabilityService.getCapabilityByNodeType(
          String(args.nodeType)
        )
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'validate_node_config': {
        const result = await services.capabilityService.validateNodeConfig(
          String(args.nodeType),
          args.config as Record<string, unknown>
        )
        return result.ok ? json(result.data) : error(result.error.message)
      }
      // 编辑类
      case 'create_node': {
        const result = await services.nodeService.createNode({
          projectId: String(args.projectId),
          type: String(args.type) as NodeTypeId,
          title: args.title as string | undefined,
          params: args.params as Record<string, unknown> | undefined,
          expectedGraphVersion: args.expectedGraphVersion as number | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined
        })
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'configure_node': {
        const result = await services.nodeService.updateNode({
          projectId: String(args.projectId),
          nodeId: String(args.nodeId),
          params: args.params as Record<string, unknown> | undefined,
          title: args.title as string | undefined,
          expectedGraphVersion: args.expectedGraphVersion as number | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined
        })
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'delete_node': {
        const result = await services.nodeService.deleteNode(
          String(args.projectId),
          String(args.nodeId),
          {
            expectedGraphVersion: args.expectedGraphVersion as number | undefined,
            idempotencyKey: args.idempotencyKey as string | undefined
          }
        )
        return result.ok ? json({ deleted: result.data }) : error(result.error.message)
      }
      case 'connect_nodes': {
        const result = await services.nodeService.connectNodes({
          projectId: String(args.projectId),
          from: args.from as { nodeId: string; portId: string },
          to: args.to as { nodeId: string; portId: string },
          expectedGraphVersion: args.expectedGraphVersion as number | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined
        })
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'disconnect_nodes': {
        const result = await services.nodeService.disconnectNodes(
          String(args.projectId),
          String(args.edgeId),
          {
            expectedGraphVersion: args.expectedGraphVersion as number | undefined,
            idempotencyKey: args.idempotencyKey as string | undefined
          }
        )
        return result.ok ? json({ disconnected: result.data }) : error(result.error.message)
      }
      // 验证类
      case 'validate_workflow': {
        const result = await services.workflowService.validateWorkflow({
          projectId: String(args.projectId),
          nodeIds: args.nodeIds as string[] | undefined
        })
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'estimate_run': {
        const result = await services.workflowService.estimateRun({
          projectId: String(args.projectId),
          nodeIds: args.nodeIds as string[] | undefined
        })
        return result.ok ? json(result.data) : error(result.error.message)
      }
      // 执行类
      case 'run_node': {
        const result = await services.workflowService.runNode({
          projectId: String(args.projectId),
          nodeId: String(args.nodeId),
          dryRun: Boolean(args.dryRun)
        })
        return result.ok ? json(result.data) : error(result.error.message)
      }
      case 'run_workflow': {
        const result = await services.workflowService.runWorkflow({
          projectId: String(args.projectId),
          nodeIds: args.nodeIds as string[] | undefined,
          dryRun: Boolean(args.dryRun)
        })
        return result.ok ? json(result.data) : error(result.error.message)
      }
      // 结果类
      case 'list_artifacts': {
        const artifacts = await store.listArtifacts(String(args.projectId))
        return json(artifacts)
      }
      default:
        return error(`未知工具: ${name}`)
    }
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err))
  }
}

// ── JSON-RPC 协议实现 ─────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const SERVER_INFO = {
  name: 'canvas-studio',
  version: '1.0.0'
} as const

const PROTOCOL_VERSION = '2024-11-05' as const

/**
 * 启动 MCP Server（stdio 传输）。
 * 读取 stdin 的 JSON-RPC 请求，写入 stdout 的 JSON-RPC 响应。
 *
 * 默认只读。CANVAS_AGENT_WRITE=draft（或显式传入 options.writeEnabled）时开放
 * 草稿写入——写入走图写入事务（快照同步 + 乐观锁），画布可见且可回滚。
 */
export interface McpServerOptions {
  /** 测试可显式注入写入开关；生产默认从 CANVAS_AGENT_WRITE 读取。 */
  writeEnabled?: boolean
}

export function startMcpServer(
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
  injectedStore?: ProjectStore,
  options?: McpServerOptions
): void {
  const store = injectedStore ?? new DesktopProjectStore()
  const writeEnabled = options?.writeEnabled ?? agentWriteEnabledFromEnv()
  const executionEnabled = agentExecutionEnabledFromEnv()
  const runner =
    executionEnabled && !injectedStore
      ? new HeadlessRunExecutor({ store, gateway: createHeadlessGateway() })
      : undefined
  const services = createServices(store, {
    permission: { level: executionEnabled ? 'execute' : writeEnabled ? 'edit' : 'read' },
    writeEnabled,
    executionEnabled,
    actor: 'agent',
    requireExpectedGraphVersion: writeEnabled,
    requireIdempotencyKey: writeEnabled,
    executeRun: runner ? (run) => runner.execute(run) : undefined
  })
  const tools = defineTools()

  let buffer = ''
  let pendingRequests = 0
  let stdinEnded = false

  const exitWhenDrained = (): void => {
    if (stdinEnded && pendingRequests === 0) process.exit(0)
  }

  stdin.setEncoding('utf-8')

  stdin.on('data', (chunk: string) => {
    buffer += chunk

    // 按换行符分割（NDJSON 格式）
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)

      if (!line) continue

      try {
        const request = JSON.parse(line) as JsonRpcRequest
        pendingRequests++
        handleRequest(request, tools, services, store)
          .then((response) => {
            if (response && request.id !== undefined) {
              stdout.write(JSON.stringify(response) + '\n')
            }
          })
          .finally(() => {
            pendingRequests--
            exitWhenDrained()
          })
      } catch {
        // 解析失败，忽略
        if (process.env.MCP_DEBUG) {
          console.error(`[MCP] JSON 解析失败: ${line}`)
        }
      }
    }
  })

  stdin.on('end', () => {
    stdinEnded = true
    exitWhenDrained()
  })
}

/** 测试专用：独立临时目录，不会触及真实桌面项目。 */
export function createIsolatedMcpStore(dataDir: string): ProjectStore {
  return new FileProjectStore({ dataDir })
}

async function handleRequest(
  request: JsonRpcRequest,
  tools: McpTool[],
  services: ServiceContainer,
  store: ProjectStore
): Promise<JsonRpcResponse | null> {
  const { method, params, id } = request

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: SERVER_INFO,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false }
            }
          }
        }

      case 'initialized':
      case 'notifications/initialized':
        return null // 通知，不需要响应

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools }
        }

      case 'tools/call': {
        const p = params as { name: string; arguments?: Record<string, unknown> }
        if (!p?.name) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: '缺少工具名称' }
          }
        }
        const result = await executeTool(p.name, p.arguments ?? {}, services, store)
        return {
          jsonrpc: '2.0',
          id,
          result
        }
      }

      case 'resources/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: [
              {
                uri: 'canvas://capabilities',
                name: '能力注册表',
                description: '所有节点能力的完整定义',
                mimeType: 'application/json'
              }
            ]
          }
        }

      case 'resources/read': {
        const p = params as { uri: string }
        if (p?.uri === 'canvas://capabilities') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: 'canvas://capabilities',
                  mimeType: 'application/json',
                  text: JSON.stringify(listCapabilities(), null, 2)
                }
              ]
            }
          }
        }
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `未知资源: ${p?.uri}` }
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `未知方法: ${method}` }
        }
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  }
}
