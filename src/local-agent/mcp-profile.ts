import { z } from 'zod'
import {
  ACCESS_OPERATIONS,
  operationResponseSchema,
  operationSpec,
  toolInputSchema,
  type AccessOperationId
} from '../shared/agent-access/registry'
import { OPERATION_REQUIREMENTS } from '../shared/agent-access/metadata'

export type McpProfile = 'core' | 'full'

/**
 * 外部上帝 Agent 高频核心工具集（MCP 默认 core 档位）。
 * 控制在 24 个以内 + 3 个元工具（共 ≤27 个），兼容 Cursor（40-80 上限）与 OpenAI（128 上限），
 * 并将 tools/list 初始载荷从 ~1.76 MB 压缩到 ~30 KB（下降 >98%）。
 * 其余 170+ 低频管理/库/历史/配置操作通过 canvas_ops_search → canvas_ops_schema → canvas_ops_call 按需调用。
 */
export const MCP_CORE_OPERATION_IDS: readonly string[] = [
  // 项目生命周期
  'project.list',
  'project.open',
  'project.create',
  'project.save',
  // 画布读写与全 34 节点幽灵预览建图（方案 A 主路径）
  'graph.get',
  'graph.patch',
  'graph.patch.propose',
  'graph.patch.confirm',
  'graph.patch.discard',
  'graph.layout',
  // 节点类型契约与单节点查询
  'node.type.list',
  'node.type.get',
  'node.get',
  // 执行与产物读取
  'node.execute',
  'run.get',
  'run.wait',
  'output.get',
  // 复合节点流（可复用黑盒能力）
  'composite.search',
  'composite.get',
  'composite.execute',
  'composite.execute.wait',
  // 素材、模型与能力自省
  'media.list',
  'media.import',
  'model.definition.list',
  'capability.list'
]

export const MCP_META_TOOL_NAMES = {
  search: 'canvas_ops_search',
  schema: 'canvas_ops_schema',
  call: 'canvas_ops_call'
} as const

export const MCP_SERVER_INSTRUCTIONS = [
  'Canvas Studio Local Agent MCP Server.',
  'Required envelope rule: every non-read tool requires top-level idempotencyKey matching "<13-digit-ms-timestamp>:<lowercase-uuid-v4>" (e.g. "1764244200000:550e8400-e29b-41d4-a716-446655440000").',
  'Recommended external workflow (all 34 node types + published composites):',
  '1. Discover: call project_list / project_open, then graph_get (prefer view="latest" when the project is open to get the freshest graphVersion) and node_type_get (includes ports & configGuide examples). For local file import, place files under <dataDirectory>/agent-exports before calling media_import.',
  '2. Build with human preview (preferred): call graph_patch_propose with typed ops (node.create / edge.create / etc.) and autoLayout=true to validate ports/configs and display ghost nodes & edges on the user canvas without mutating it; then let the user click confirm in the canvas preview panel or call graph_patch_confirm (triggers desktop human approval). Note: video node image port is "in-images" (not in-first-frame); processor ports are "in-value"/"out-value" with "{{value}}" template placeholder.',
  '3. Execute & verify: call node_execute (or composite_execute + composite_execute_wait) -> run_wait -> output_get. Pure local nodes (code/processor/image-crop/image-split/video-frame/video-clip/sound-adjust/silence-trim) do not require confirmPaidRerun; paid model upstream nodes require explicit user consent and confirmPaidRerun=true. Never assume success without checking run status and outputs.',
  '4. Extended operations: for library, history, providers, diagnostics, node.runPlan, director, or legacy flowAgent operations not listed directly, use canvas_ops_search -> canvas_ops_schema -> canvas_ops_call.'
].join('\n')

export function resolveMcpProfile(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): McpProfile {
  const idx = argv.indexOf('--profile')
  const flag = idx >= 0 ? argv[idx + 1] : undefined
  const inline = argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length)
  const raw = (flag ?? inline ?? env.CANVAS_MCP_PROFILE ?? 'core').trim().toLowerCase()
  return raw === 'full' ? 'full' : 'core'
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: { type: 'object'; [key: string]: unknown }
  outputSchema?: { type: 'object'; [key: string]: unknown }
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}

function buildOperationTool(id: AccessOperationId, includeOutputSchema: boolean): McpToolDefinition {
  const spec = operationSpec(id)
  return {
    name: id.replaceAll('.', '_'),
    description:
      spec.cost === 'none'
        ? spec.description
        : `${spec.description}（费用：${{ possible: '可能产生费用', certain: '会产生费用' }[spec.cost]}）`,
    inputSchema: z.toJSONSchema(toolInputSchema(id)) as {
      type: 'object'
      [key: string]: unknown
    },
    ...(includeOutputSchema
      ? {
          outputSchema: z.toJSONSchema(operationResponseSchema(id)) as {
            type: 'object'
            [key: string]: unknown
          }
        }
      : {}),
    annotations: {
      readOnlyHint: spec.effect === 'read',
      destructiveHint: spec.destructive,
      idempotentHint: spec.idempotent,
      openWorldHint: spec.openWorld === true
    }
  }
}

const searchInputSchema = z
  .object({
    query: z.string().max(120).optional().describe('关键词过滤（匹配操作 ID 或中文说明）'),
    group: z
      .string()
      .max(60)
      .optional()
      .describe('按命名空间前缀过滤，如 library / history / provider / model / composite / flowAgent / diagnostics'),
    effect: z
      .enum(['read', 'write', 'execute', 'export', 'delete'])
      .optional()
      .describe('按操作类型过滤（read/write/execute/export/delete）'),
    limit: z.number().int().min(1).max(60).default(25)
  })
  .strict()

const schemaInputSchema = z
  .object({
    operationId: z.string().min(1).max(120).describe('完整操作 ID（如 library.template.list）')
  })
  .strict()

const callInputSchema = z
  .object({
    operationId: z.string().min(1).max(120).describe('要调用的完整操作 ID（可用 canvas_ops_search 查询）'),
    input: z.record(z.string(), z.unknown()).default({}).describe('该操作的 input 载荷对象'),
    requestId: z.string().min(1).max(120).optional(),
    idempotencyKey: z.string().min(1).max(120).optional()
  })
  .strict()

export function buildMcpToolsList(profile: McpProfile): McpToolDefinition[] {
  if (profile === 'full') {
    return (Object.keys(ACCESS_OPERATIONS) as AccessOperationId[]).map((id) =>
      buildOperationTool(id, true)
    )
  }

  const coreTools: McpToolDefinition[] = []
  for (const id of MCP_CORE_OPERATION_IDS) {
    if (Object.hasOwn(ACCESS_OPERATIONS, id)) {
      coreTools.push(buildOperationTool(id as AccessOperationId, false))
    }
  }

  const metaTools: McpToolDefinition[] = [
    {
      name: MCP_META_TOOL_NAMES.search,
      description:
        '按关键词或命名空间检索 Canvas Studio 其余 170+ 扩展操作（库、历史、模型配置、诊断、导演台、旧 Flow 等），返回操作 ID、说明与前置条件。',
      inputSchema: z.toJSONSchema(searchInputSchema) as { type: 'object'; [key: string]: unknown },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: MCP_META_TOOL_NAMES.schema,
      description:
        '按需获取单个扩展操作的精确 JSON inputSchema（用于调用 canvas_ops_call 前确认必填字段与类型）。',
      inputSchema: z.toJSONSchema(schemaInputSchema) as { type: 'object'; [key: string]: unknown },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: MCP_META_TOOL_NAMES.call,
      description:
        '按 operationId 调用任意已注册的 Canvas Studio 操作（与直接暴露工具走完全相同的校验、权限、人工确认门禁与结构化返回）。',
      inputSchema: z.toJSONSchema(callInputSchema) as { type: 'object'; [key: string]: unknown },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    }
  ]

  return [...coreTools, ...metaTools]
}

export function runOpsSearch(rawArgs: unknown): {
  ok: true
  data: {
    totalRegistered: number
    matched: number
    groups: string[]
    operations: Array<{
      operationId: string
      group: string
      effect: 'read' | 'write' | 'execute' | 'export' | 'delete' | 'execute' | 'export' | 'delete'
      cost: string
      destructive: boolean
      idempotent: boolean
      requirements: readonly string[]
      description: string
    }>
  }
} | { ok: false; code: string; detail: string } {
  const parsed = searchInputSchema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, code: 'INVALID_INPUT', detail: `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}` }
  }
  const { query, group, effect, limit } = parsed.data
  const q = query?.trim().toLowerCase() ?? ''
  const g = group?.trim().toLowerCase() ?? ''
  const allIds = Object.keys(ACCESS_OPERATIONS) as AccessOperationId[]
  const groups = [...new Set(allIds.map((id) => id.split('.')[0]))].sort()

  const matchedAll = allIds.filter((id) => {
    const spec = operationSpec(id)
    if (effect && spec.effect !== effect) return false
    if (g && !id.toLowerCase().startsWith(g)) return false
    if (q && !id.toLowerCase().includes(q) && !spec.description.toLowerCase().includes(q)) return false
    return true
  })

  const operations = matchedAll.slice(0, limit).map((id) => {
    const spec = operationSpec(id)
    return {
      operationId: id,
      group: id.split('.')[0],
      effect: spec.effect,
      cost: spec.cost,
      destructive: spec.destructive,
      idempotent: spec.idempotent,
      requirements: OPERATION_REQUIREMENTS[id] ?? [],
      description: spec.description
    }
  })

  return {
    ok: true,
    data: {
      totalRegistered: allIds.length,
      matched: matchedAll.length,
      groups,
      operations
    }
  }
}

export function runOpsSchema(rawArgs: unknown): {
  ok: true
  data: {
    operationId: string
    effect: 'read' | 'write' | 'execute' | 'export' | 'delete'
    cost: string
    destructive: boolean
    idempotent: boolean
    requirements: readonly string[]
    description: string
    inputSchema: unknown
  }
} | { ok: false; code: string; detail: string } {
  const parsed = schemaInputSchema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, code: 'INVALID_INPUT', detail: `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}` }
  }
  const id = parsed.data.operationId as AccessOperationId
  if (!Object.hasOwn(ACCESS_OPERATIONS, id)) {
    return { ok: false, code: 'UNSUPPORTED_OPERATION', detail: `Unknown operationId: ${id}` }
  }
  const spec = operationSpec(id)
  return {
    ok: true,
    data: {
      operationId: id,
      effect: spec.effect,
      cost: spec.cost,
      destructive: spec.destructive,
      idempotent: spec.idempotent,
      requirements: OPERATION_REQUIREMENTS[id] ?? [],
      description: spec.description,
      inputSchema: z.toJSONSchema(toolInputSchema(id))
    }
  }
}

export function parseOpsCallArgs(rawArgs: unknown):
  | { ok: true; operationId: AccessOperationId; args: Record<string, unknown> }
  | { ok: false; code: string; detail: string } {
  const parsed = callInputSchema.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, code: 'INVALID_INPUT', detail: `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}` }
  }
  const id = parsed.data.operationId as AccessOperationId
  if (!Object.hasOwn(ACCESS_OPERATIONS, id)) {
    return { ok: false, code: 'UNSUPPORTED_OPERATION', detail: `Unknown operationId: ${id}` }
  }
  return {
    ok: true,
    operationId: id,
    args: {
      input: parsed.data.input,
      ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}),
      ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {})
    }
  }
}
