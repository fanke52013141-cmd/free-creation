import { z } from 'zod'
import { ACTIVE_NODE_TYPE_IDS } from '../types'
import {
  NODE_ACTION_IDS,
  NODE_ACTION_STATUSES,
  nodeActionSummary,
  validateNodeActionMatrix
} from './node-actions'
import { validateNodeContractSnapshot } from './node-contracts'
export { nodeAccessDirectory } from './node-actions'
import {
  bindings,
  empty,
  identifier,
  metadata,
  nodeId,
  page,
  project,
  revision,
  savedMetadata,
  skillSummary,
  templateSummary
} from './ops/common'
import { FLOW_AGENTS_OPERATIONS, FLOW_AGENTS_OUTPUTS } from './ops/flow-agents'
import { FLOW_ASSETS_OPERATIONS, FLOW_ASSETS_OUTPUTS } from './ops/flow-assets'
import { FLOW_COMMANDS_OPERATIONS, FLOW_COMMANDS_OUTPUTS } from './ops/flow-commands'
import { HISTORY_OPERATIONS, HISTORY_OUTPUTS } from './ops/history'
import { LIBRARY_OPERATIONS, LIBRARY_OUTPUTS } from './ops/library'
import { NODE_LIBRARY_OPERATIONS, NODE_LIBRARY_OUTPUTS } from './ops/node-library'
import { PUBLISH_OPERATIONS, PUBLISH_OUTPUTS } from './ops/publish'
import { SETTINGS_OPERATIONS, SETTINGS_OUTPUTS } from './ops/settings'
import { DIAGNOSTICS_OPERATIONS, DIAGNOSTICS_OUTPUTS } from './ops/diagnostics'
import { PROJECT_SETTINGS_OPERATIONS, PROJECT_SETTINGS_OUTPUTS } from './ops/project-settings'
import { NODE_CATALOG_OPERATIONS, NODE_CATALOG_OUTPUTS } from './ops/node-catalog'
import { MODEL_ADMIN_OPERATIONS, MODEL_ADMIN_OUTPUTS } from './ops/model-admin'
import { MEDIA_ASSET_OPERATIONS, MEDIA_ASSET_OUTPUTS } from './ops/media-assets'
import { LIBRARY_CAPTURE_OPERATIONS, LIBRARY_CAPTURE_OUTPUTS } from './ops/library-capture'
import { CANVAS_HISTORY_OPERATIONS, CANVAS_HISTORY_OUTPUTS } from './ops/canvas-history'
import { PROVIDER_OPERATIONS, PROVIDER_OUTPUTS } from './ops/providers'
import { PROVIDER_NETWORK_OPERATIONS, PROVIDER_NETWORK_OUTPUTS } from './ops/provider-network'
import { KEY_PACKAGE_OPERATIONS, KEY_PACKAGE_OUTPUTS } from './ops/key-package'
import { TRANSFER_OPERATIONS, TRANSFER_OUTPUTS } from './ops/transfer'
import {
  GRAPH_PATCH_MAX_OPS,
  GRAPH_VIEW_MAX_EDGES,
  GRAPH_VIEW_MAX_NODES,
  GraphPatchOpsSchema,
  accessClientRef,
  graphEdgeDto,
  graphGroupDto,
  graphNodeDto
} from './graph-ops'
import {
  NODE_EXECUTE_MAX_NODES,
  RUN_WAIT_MAX_TIMEOUT_MS,
  nodeRunTaskDto,
  outputValueDto
} from './run-ops'

export const ACCESS_API_VERSION = 1
export const ACCESS_MAX_BYTES = 1024 * 1024
export const ACCESS_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const ACCESS_OPERATIONS = {
  'skill.list': {
    effect: 'read',
    description: '分页查询已安装技能的名称、固定版本和摘要，不返回指令正文',
    input: page
  },
  'skill.install': {
    effect: 'write',
    description:
      '安装本机 SKILL.md、JSON 技能包或扁平技能目录；name 为独立技能名称；仅支持指令与文本参考，不执行脚本',
    input: z
      .object({ sourcePath: z.string().min(2).max(1000), name: z.string().trim().min(1).max(120) })
      .strict()
  },
  'chat.skill.list': {
    effect: 'read',
    description: '分页查询项目已保存的 AI 对话节点及其绑定技能版本；活动画布的未保存修改不在结果中',
    input: project
      .extend({
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(100).default(50)
      })
      .strict()
  },
  'chat.skill.bind': {
    effect: 'write',
    description:
      '替换当前打开的 AI 对话节点的完整技能集合（空数组为清空），经桌面保存；必须使用已安装的固定版本，不启动对话',
    input: revision
      .extend({ nodeId, skills: bindings, maxSteps: z.number().int().min(1).max(12).default(6) })
      .strict()
  },
  'node.library.save': {
    effect: 'write',
    description:
      '以独立 name 将指定 AI 对话节点和固定版本技能保存到节点库；排除聊天记录、附件与运行结果',
    input: revision.extend({ nodeId, name: z.string().trim().min(1).max(120) }).strict()
  },
  'node.library.list': {
    effect: 'read',
    description: '分页查询节点库条目摘要，不返回配置正文',
    input: page
  },
  'graph.get': {
    effect: 'read',
    description:
      '读取画布节点/连线/分组的版本化视图（分页）；config 与正文经 node.get 显式读取；latest 视图仅限当前打开项目',
    input: project
      .extend({
        view: z.enum(['persisted', 'latest']).default('persisted'),
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(GRAPH_VIEW_MAX_NODES).default(100)
      })
      .strict()
  },
  'node.get': {
    effect: 'read',
    description:
      '读取单个已保存节点的类型、契约版本、配置、正文、端口与连线引用；运行事实与结果经 run/output 族查询',
    input: project.extend({ nodeId }).strict()
  },
  'graph.patch': {
    effect: 'write',
    description:
      '向当前打开项目提交一批类型化画布编辑（建/改/删节点与连线）；整体校验后原子应用并保存；返回ID映射与保存版本',
    input: revision.extend({ ops: GraphPatchOpsSchema }).strict()
  },
  'node.execute': {
    effect: 'execute',
    description:
      '向当前打开项目提交节点执行（single=仅该节点读取已持久化上游；subgraph=所选节点及其上游闭包）；返回持久任务ID，最终状态以 run.get 为准',
    input: revision
      .extend({
        nodeIds: z.array(nodeId).min(1).max(NODE_EXECUTE_MAX_NODES),
        mode: z.enum(['single', 'subgraph']).default('subgraph'),
        confirmPaidRerun: z.boolean().default(false)
      })
      .strict()
  },
  'run.wait': {
    effect: 'read',
    description: '等待任务到达终态或超时；返回任务当前状态，不自动重放或取消任务',
    input: project
      .extend({
        taskId: z.string().regex(/^[a-zA-Z0-9_:-]{1,160}$/),
        timeoutMs: z.number().int().min(100).max(RUN_WAIT_MAX_TIMEOUT_MS).default(30000)
      })
      .strict()
  },
  'run.cancel': {
    effect: 'write',
    description:
      '请求取消当前打开项目上的在途任务；取消请求与取消确认分开，最终状态以 run.get 为准',
    input: project.extend({ taskId: z.string().regex(/^[a-zA-Z0-9_:-]{1,160}$/) }).strict()
  },
  'output.get': {
    effect: 'read',
    description:
      '读取节点最近一次正式输出投影（确定性文本/JSON/processor/媒体引用等已登记类型）；运行事实来自真实运行记录，不可伪造',
    input: project.extend({ nodeId }).strict()
  },
  'media.import': {
    effect: 'write',
    description:
      '把本机文件登记为项目受控媒体（复制入库、去敏索引）；返回受控 mediaId 供节点引用，不接收二进制报文',
    input: project
      .extend({
        filePath: z.string().min(2).max(1000),
        name: z.string().trim().min(1).max(120).optional()
      })
      .strict()
  },
  'media.list': {
    effect: 'read',
    description: '分页读取项目受控媒体摘要（kind/mime/尺寸/相对引用路径），不返回绝对路径或文件正文',
    input: project
      .extend({
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(200).default(50)
      })
      .strict()
  },
  'media.delete': {
    effect: 'delete',
    description:
      '删除项目受控媒体（磁盘文件+索引）；mediaId 必须属于指定项目；回执含保存图中引用计数，不校验引用为空（与 GUI 面板删除同一规则）',
    input: project.extend({ mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/) }).strict()
  },
  'chat.read': {
    effect: 'read',
    description:
      '读取对话节点的会话目录（含活动会话标记与模型配置摘要）；消息正文经 chat.messages 显式读取',
    input: project.extend({ nodeId }).strict()
  },
  'chat.messages': {
    effect: 'read',
    description:
      '分页读取指定会话的消息正文（role/content/意图/附件引用）；助手回复是模型真实输出，不可伪造',
    input: project
      .extend({ nodeId, sessionId: z.string().min(1).max(80).optional(), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(200).default(50) })
      .strict()
  },
  'model.list': {
    effect: 'read',
    description: '分页读取本地模型ID、启用状态与能力验证状态；不联网探测，不返回凭据、地址或配置',
    input: page
  },
  'library.search': {
    effect: 'read',
    description: '分页检索资源库摘要；不返回组件正文、媒体路径或资源包',
    input: z
      .object({
        query: z.string().max(300).optional(),
        cursor: z
          .string()
          .regex(/^\d{1,6}$/)
          .optional(),
        limit: z.number().int().min(1).max(100).default(40),
        includeArchived: z.boolean().default(false)
      })
      .strict()
  },
  'library.create_resource': {
    effect: 'write',
    description:
      '创建单图图片资源（一张图片+名称）；图片取自本机已存在的文件路径，不接收网络地址、二进制报文或额外组件',
    input: z
      .object({
        title: z.string().trim().min(1).max(180),
        imagePath: z.string().min(2).max(500),
        description: z.string().max(2000).optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(20).optional()
      })
      .strict()
  },
  'run.get': {
    effect: 'read',
    description:
      '按项目和taskId读取持久化内部Agent任务基础状态；不含命令、模型媒体任务、正文或控制操作',
    input: project.extend({ taskId: z.string().regex(/^[a-zA-Z0-9_:-]{1,160}$/) }).strict()
  },
  'diagnostics.summary': {
    effect: 'read',
    description: '读取诊断存储健康计数；不返回事件正文或诊断包，不代表任务执行成功',
    input: empty
  },
  'app.status': { effect: 'read', description: '读取本地应用版本与实例身份', input: empty },
  'capability.list': {
    effect: 'read',
    description: '读取当前已开放操作及其输入契约',
    input: empty
  },
  'node.type.list': {
    effect: 'read',
    description: '读取节点接入状态；本包不开放节点操作',
    input: empty
  },
  'project.list': {
    effect: 'read',
    description: '分页读取项目摘要',
    input: z
      .object({
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(100).default(50)
      })
      .strict()
  },
  'project.get': {
    effect: 'read',
    description: '读取已保存项目摘要与内容数量，不返回原始快照',
    input: project
  },
  'project.create': {
    effect: 'write',
    description: '幂等新建空项目',
    input: z.object({ name: z.string().trim().min(1).max(200) }).strict()
  },
  'project.open': {
    effect: 'write',
    description: '保存当前画布后在桌面打开项目；等待画布就绪',
    input: project
  },
  'project.update': {
    effect: 'write',
    description: '按版本修改项目名称；活动画布先保存并同步版本',
    input: revision.extend({ name: z.string().trim().min(1).max(200) }).strict()
  },
  'project.rename': {
    effect: 'write',
    description: '按已保存版本修改项目名称；活动画布经保存握手同步',
    input: revision.extend({ name: z.string().trim().min(1).max(200) }).strict()
  },
  'project.save': {
    effect: 'write',
    description: '保存当前权威内容；活动画布等待最新编辑落盘，不接收客户端快照',
    input: revision
  },
  'project.clone': {
    effect: 'write',
    description: '固定源版本复制项目（媒体ID/引用重映射）；活动源画布先保存，克隆不继承运行任务',
    input: revision.extend({ name: z.string().trim().min(1).max(120) }).strict()
  },
  'project.delete.precheck': {
    effect: 'read',
    description: '读取删除影响摘要与占用阻塞项，无阻塞时签发短期确认令牌',
    input: project
  },
  'project.delete': {
    effect: 'delete',
    description: '凭预检令牌硬删除项目；拒绝活动画布、运行/未知占用，令牌过期或事实漂移需重新预检',
    input: z
      .object({
        projectId: identifier,
        impactToken: z.string().min(1).max(1024).optional()
      })
      .strict()
  },
  'project.export': {
    effect: 'export',
    description: '活动画布先保存最新编辑，再导出完整项目到受控目录，不覆盖文件',
    input: revision
      .extend({ fileName: z.string().regex(/^[a-zA-Z0-9_-]{1,100}\.canvasbundle$/) })
      .strict()
  },
  // 以下按业务族拆分到 ./ops/*，各族维护自己的操作与输出 Schema；
  // 对外的 operationDirectory/契约快照必须与拆分前等价。
  ...LIBRARY_OPERATIONS,
  ...NODE_LIBRARY_OPERATIONS,
  ...HISTORY_OPERATIONS,
  ...TRANSFER_OPERATIONS,
  ...FLOW_AGENTS_OPERATIONS,
  ...FLOW_COMMANDS_OPERATIONS,
  ...FLOW_ASSETS_OPERATIONS,
  ...SETTINGS_OPERATIONS,
  ...DIAGNOSTICS_OPERATIONS,
  ...PROJECT_SETTINGS_OPERATIONS,
  ...NODE_CATALOG_OPERATIONS,
  ...MODEL_ADMIN_OPERATIONS,
  ...MEDIA_ASSET_OPERATIONS,
  ...LIBRARY_CAPTURE_OPERATIONS,
  ...CANVAS_HISTORY_OPERATIONS,
  ...PROVIDER_OPERATIONS,
  ...PROVIDER_NETWORK_OPERATIONS,
  ...KEY_PACKAGE_OPERATIONS,
  ...PUBLISH_OPERATIONS
} as const
export type AccessOperationId = keyof typeof ACCESS_OPERATIONS

// 包传输类导入按明确能力范围判定，不用名称子串一票否决（一致性计划 F1 要求）。
// 2026-11-08 F7 独立验收后，完整项目包/结构包/资源包导入与资源包导出已解除阻断：
// 它们复用 GUI 同一 store 服务，并且外部入口只接受受控导出目录内的包文件
// （暂存、媒体 ID/相对路径全量重映射、凭据剥离、失败清理、sha256/字节回执）。
// 仍阻断的两项不在本包范围，需要单独的安全设计与验收：
// - keys.importProviders：供应商凭据包导入会越过密钥库/设备授权边界，涉及明文解密与
//   设备绑定，必须按 F9「受控凭据配置」独立设计，不能借项目/资源包通道旁路。
// - workspace.import：工作区导入涉及跨项目合并、冲突裁决与运行/审核事实边界，
//   尚无与 GUI 同源的合并服务，须在 F8/F9 单独验收后再开放。
const PACKAGE_IMPORT_BLOCKLIST: ReadonlySet<string> = new Set([
  'keys.importProviders',
  'workspace.import'
])

export const AccessRequestSchema = z
  .object({
    apiVersion: z.literal(ACCESS_API_VERSION),
    operationVersion: z.literal(1),
    operationId: z.string().min(1).max(80),
    requestId: identifier,
    expectedDataStoreId: z.string().uuid(),
    idempotencyKey: z
      .string()
      .regex(/^\d{13}:[a-f0-9-]{36}$/)
      .optional(),
    input: z.unknown()
  })
  .strict()
export type AccessRequest = z.infer<typeof AccessRequestSchema>
export interface AccessResponse {
  apiVersion: 1
  requestId: string
  operationId: string
  traceId: string
  status: 'completed' | 'failed' | 'unknown'
  idempotencyKey?: string
  data?: unknown
  error?: { code: string; phase: string; retryable: boolean; detail?: string }
}

export const AccessResponseSchema = z
  .object({
    apiVersion: z.literal(1),
    requestId: z.string(),
    operationId: z.string(),
    traceId: z.string(),
    status: z.enum(['completed', 'failed', 'unknown']),
    idempotencyKey: z.string().optional(),
    data: z.json().optional(),
    error: z
      .object({
        code: z.string(),
        phase: z.string(),
        retryable: z.boolean(),
        detail: z.string().max(300).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export const ACCESS_OUTPUTS = {
  'skill.list': z
    .object({ items: z.array(skillSummary).max(100), total: z.number().int().nonnegative() })
    .strict(),
  'skill.install': skillSummary,
  'chat.skill.list': z
    .object({
      graphVersion: z.number().int().nonnegative(),
      nodes: z.array(z.object({ nodeId, title: z.string(), skills: bindings }).strict()).max(100),
      total: z.number().int().nonnegative()
    })
    .strict(),
  'chat.skill.bind': z
    .object({
      projectId: identifier,
      nodeId,
      graphVersion: z.number().int().nonnegative(),
      saved: z.literal(true),
      skills: bindings
    })
    .strict(),
  'node.library.save': templateSummary,
  'node.library.list': z
    .object({ items: z.array(templateSummary).max(100), total: z.number().int().nonnegative() })
    .strict(),
  'model.list': z
    .object({
      models: z
        .array(
          z
            .object({
              id: z.string().max(200),
              connectionId: z.string().max(200),
              modelId: z.string().max(300),
              enabled: z.boolean(),
              connectionEnabled: z.boolean(),
              capabilitiesTruncated: z.boolean(),
              capabilities: z
                .array(
                  z
                    .object({
                      operation: z.string().max(80),
                      validation: z.enum([
                        'unverified',
                        'validating',
                        'verified',
                        'failed',
                        'unsupported'
                      ])
                    })
                    .strict()
                )
                .max(32)
            })
            .strict()
        )
        .max(100),
      total: z.number().int().nonnegative(),
      reachability: z.literal('not-probed')
    })
    .strict(),
  'library.search': z
    .object({
      items: z
        .array(
          z
            .object({
              id: identifier,
              title: z.string().max(200),
              formPreset: z.enum(['image', 'prompt', 'character', 'scene', 'style', 'custom']),
              latestRevisionId: identifier,
              revisionNumber: z.number().int().positive(),
              componentCount: z.number().int().nonnegative(),
              updatedAt: z.number(),
              archived: z.boolean()
            })
            .strict()
        )
        .max(100),
      nextCursor: z.string().nullable()
    })
    .strict(),
  'library.create_resource': z
    .object({
      resourceId: identifier,
      revisionId: identifier,
      revisionNumber: z.number().int().positive(),
      title: z.string().max(200),
      imageSha256: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict(),
  'run.get': z.discriminatedUnion('source', [
    // flow-agent-task 分支保持既有字段不变（旧客户端兼容）。
    z
      .object({
        projectId: identifier,
        taskId: z.string().max(160),
        source: z.literal('flow-agent-task'),
        state: z.enum(['ready', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled']),
        waitRevision: z.number().int().nonnegative(),
        waitKind: z.enum(['human', 'reconcile']).nullable(),
        reconcileRequired: z.boolean(),
        stateReason: z
          .enum(['HUMAN_REQUIRED', 'RECONCILE_REQUIRED', 'TASK_BLOCKED', 'TASK_FAILED'])
          .nullable(),
        allowedActions: z.array(z.never()).max(0)
      })
      .strict(),
    nodeRunTaskDto
  ]),
  'diagnostics.summary': z
    .object({
      available: z.boolean(),
      degraded: z.boolean(),
      received: z.number().int().nonnegative(),
      written: z.number().int().nonnegative(),
      queueDepth: z.number().int().nonnegative(),
      droppedTotal: z.number().int().nonnegative(),
      writeFailures: z.number().int().nonnegative(),
      badLines: z.number().int().nonnegative()
    })
    .strict(),
  'app.status': z
    .object({
      instanceId: z.string().uuid(),
      dataStoreId: z.string().uuid(),
      appVersion: z.string(),
      apiVersion: z.literal(1),
      nextIdempotencyKey: z.string()
    })
    .strict(),
  'capability.list': z
    .object({ operations: z.array(z.json()), limitations: z.array(z.string()) })
    .strict(),
  'graph.get': z
    .object({
      projectId: identifier,
      view: z.enum(['persisted', 'latest']),
      graphVersion: z.number().int().nonnegative(),
      /** latest 视图为 true 时表示权威宿主尚有未保存编辑，磁盘版本可能落后。 */
      unsaved: z.boolean(),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      nodes: z.array(graphNodeDto).max(GRAPH_VIEW_MAX_NODES),
      edges: z.array(graphEdgeDto).max(GRAPH_VIEW_MAX_EDGES),
      groups: z.array(graphGroupDto).max(GRAPH_VIEW_MAX_NODES)
    })
    .strict(),
  'node.get': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      node: graphNodeDto.extend({
        text: z.string(),
        config: z.json().nullable(),
        mediaId: z.string().optional(),
        mediaPath: z.string().optional(),
        mediaMime: z.string().optional(),
        exec: z.string().max(40),
        edgesIn: z.array(graphEdgeDto).max(GRAPH_VIEW_MAX_EDGES),
        edgesOut: z.array(graphEdgeDto).max(GRAPH_VIEW_MAX_EDGES)
      })
    })
    .strict(),
  'graph.patch': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      saved: z.literal(true),
      created: z
        .array(z.object({ ref: accessClientRef.optional(), nodeId: z.string().max(180) }).strict())
        .max(GRAPH_PATCH_MAX_OPS),
      applied: z
        .object({
          nodeCreated: z.number().int().nonnegative(),
          nodeUpdated: z.number().int().nonnegative(),
          nodeDeleted: z.number().int().nonnegative(),
          edgeCreated: z.number().int().nonnegative(),
          edgeDeleted: z.number().int().nonnegative()
        })
        .strict()
    })
    .strict(),
  'node.execute': z
    .object({
      projectId: identifier,
      taskId: z.string().max(160),
      accepted: z.literal(true),
      mode: z.enum(['single', 'subgraph']),
      nodeIds: z.array(z.string()).max(NODE_EXECUTE_MAX_NODES),
      state: z.enum(['accepted', 'running'])
    })
    .strict(),
  'run.wait': nodeRunTaskDto,
  'run.cancel': z
    .object({
      projectId: identifier,
      taskId: z.string().max(160),
      state: z.enum(['cancel-requested', 'cancelled', 'completed', 'failed']),
      /** false：任务已是终态，取消为无操作；true：已登记取消请求并通知宿主。 */
      cancelRequested: z.boolean()
    })
    .strict(),
  'output.get': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      nodeId,
      nodeType: z.string().max(60),
      outputSource: z.enum(['document', 'run', 'manual-publish', 'display-only', 'unknown']),
      outputs: z.array(outputValueDto).max(32),
      projection: z.string().max(60)
    })
    .strict(),
  'media.import': z
    .object({
      projectId: identifier,
      mediaId: z.string().max(40),
      kind: z.enum(['image', 'video', 'audio', 'file']),
      mime: z.string().max(120),
      path: z.string().max(300),
      sizeBytes: z.number().int().nonnegative(),
      name: z.string().max(200),
      textContent: z.string().max(20000).optional()
    })
    .strict(),
  'chat.read': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      nodeId,
      modelKey: z.string().max(200),
      system: z.string().max(2000),
      activeConversationId: z.string().max(80).nullable(),
      conversations: z.array(
        z.object({
          id: z.string().max(80),
          title: z.string().max(120),
          messageCount: z.number().int().nonnegative(),
          createdAt: z.number(),
          updatedAt: z.number(),
          active: z.boolean()
        }).strict()
      ).max(50)
    })
    .strict(),
  'chat.messages': z
    .object({
      projectId: identifier,
      nodeId,
      sessionId: z.string().max(80),
      total: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      messages: z
        .array(
          z
            .object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string(),
              reasoning: z.string().optional(),
              intent: z.string().max(40).optional(),
              images: z
                .array(
                  z
                    .object({
                      mediaId: z.string().max(160),
                      mediaPath: z.string().max(300),
                      name: z.string().max(200),
                      mime: z.string().max(120)
                    })
                    .strict()
                )
                .max(8)
                .optional()
            })
            .strict()
        )
        .max(200)
    })
    .strict(),
  'media.delete': z
    .object({
      projectId: identifier,
      deleted: z.literal(true),
      mediaId: z.string().max(40),
      referencedBySavedNodes: z.number().int().nonnegative()
    })
    .strict(),
  'media.list': z
    .object({
      projectId: identifier,
      total: z.number().int().nonnegative(),
      items: z
        .array(
          z
            .object({
              mediaId: z.string().max(40),
              kind: z.enum(['image', 'video', 'audio', 'file']),
              mime: z.string().max(120),
              path: z.string().max(300),
              sizeBytes: z.number().int().nonnegative(),
              name: z.string().max(200)
            })
            .strict()
        )
        .max(200)
    })
    .strict(),
  'node.type.list': z
    .object({
      nodes: z.array(
        z
          .object({
            typeId: z.enum(ACTIVE_NODE_TYPE_IDS),
            contractVersion: z.number().int().nonnegative().optional(),
            actions: z.array(
              z
                .object({
                  actionId: z.enum(NODE_ACTION_IDS),
                  label: z.string().max(120),
                  status: z.enum(NODE_ACTION_STATUSES),
                  evidence: z.string().min(4).max(300)
                })
                .strict()
            ),
            summary: z
              .object({
                desktopTested: z.number().int().nonnegative(),
                contractTested: z.number().int().nonnegative(),
                planned: z.number().int().nonnegative(),
                notApplicable: z.number().int().nonnegative()
              })
              .strict()
          })
          .strict()
      ),
      summary: z
        .object({
          nodes: z.number().int().nonnegative(),
          actions: z.number().int().nonnegative(),
          byStatus: z
            .object({
              'desktop-tested': z.number().int().nonnegative(),
              'contract-tested': z.number().int().nonnegative(),
              implemented: z.number().int().nonnegative(),
              planned: z.number().int().nonnegative(),
              'not-applicable': z.number().int().nonnegative()
            })
            .strict()
        })
        .strict()
    })
    .strict(),
  'project.list': z
    .object({ projects: z.array(metadata), total: z.number().int().nonnegative() })
    .strict(),
  'project.get': z
    .object({
      meta: metadata,
      nodeCount: z.number().int().nonnegative(),
      edgeCount: z.number().int().nonnegative(),
      groupCount: z.number().int().nonnegative(),
      saved: z.literal(true)
    })
    .strict(),
  'project.create': savedMetadata,
  'project.open': z.object({ meta: metadata, opened: z.literal(true) }).strict(),
  'project.update': savedMetadata,
  'project.rename': savedMetadata,
  'project.save': z
    .object({ graphVersion: z.number().int().nonnegative(), saved: z.literal(true) })
    .strict(),
  'project.clone': savedMetadata,
  'project.delete.precheck': z
    .object({
      projectId: identifier,
      graphVersion: z.number().int().nonnegative(),
      impact: z
        .object({
          nodeCount: z.number().int().nonnegative(),
          edgeCount: z.number().int().nonnegative(),
          groupCount: z.number().int().nonnegative(),
          mediaCount: z.number().int().nonnegative(),
          mediaBytes: z.number().int().nonnegative(),
          libraryUsageCount: z.number().int().nonnegative()
        })
        .strict(),
      blockers: z.array(z.enum(['ACTIVE_PROJECT', 'RECOVERY_COPY', 'TASK_OCCUPANCY'])),
      impactToken: z.string().min(1).max(1024).optional(),
      expiresAt: z.number().int().positive().optional()
    })
    .strict(),
  'project.delete': z
    .object({
      deleted: z.literal(true),
      projectId: identifier,
      graphVersion: z.number().int().nonnegative()
    })
    .strict(),
  'project.export': z
    .object({
      path: z.string(),
      sourceGraphVersion: z.number().int().nonnegative(),
      byteSize: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      missingMediaCount: z.literal(0)
    })
    .strict(),
  ...LIBRARY_OUTPUTS,
  ...NODE_LIBRARY_OUTPUTS,
  ...HISTORY_OUTPUTS,
  ...TRANSFER_OUTPUTS,
  ...FLOW_AGENTS_OUTPUTS,
  ...FLOW_COMMANDS_OUTPUTS,
  ...FLOW_ASSETS_OUTPUTS,
  ...SETTINGS_OUTPUTS,
  ...DIAGNOSTICS_OUTPUTS,
  ...PROJECT_SETTINGS_OUTPUTS,
  ...NODE_CATALOG_OUTPUTS,
  ...MODEL_ADMIN_OUTPUTS,
  ...MEDIA_ASSET_OUTPUTS,
  ...LIBRARY_CAPTURE_OUTPUTS,
  ...CANVAS_HISTORY_OUTPUTS,
  ...PROVIDER_OUTPUTS,
  ...PROVIDER_NETWORK_OUTPUTS,
  ...KEY_PACKAGE_OUTPUTS,
  ...PUBLISH_OUTPUTS
} satisfies Record<AccessOperationId, z.ZodType>
export type AccessOutput<K extends AccessOperationId> = z.infer<(typeof ACCESS_OUTPUTS)[K]>

export function operationResponseSchema(id: AccessOperationId): z.ZodObject {
  return AccessResponseSchema.extend({
    operationId: z.literal(id),
    data: ACCESS_OUTPUTS[id].optional()
  }).strict()
}

export function toolInputSchema(operationId: AccessOperationId): z.ZodObject {
  const spec = ACCESS_OPERATIONS[operationId]
  return z
    .object({
      input: spec.input,
      requestId: identifier.optional(),
      idempotencyKey:
        spec.effect === 'read' ? z.string().optional() : z.string().regex(/^\d{13}:[a-f0-9-]{36}$/)
    })
    .strict()
}

// Explicit declarations: adding an Active type without deciding its access boundary fails the gate.
export const NODE_ACCESS_DECLARATIONS = [
  'text',
  'image',
  'image-crop',
  'image-split',
  'image-gen',
  'image-edit',
  'website',
  'video',
  'video-asset',
  'video-frame',
  'video-clip',
  'video-depth',
  'video-clay',
  'timeline',
  'audio',
  'sound-adjust',
  'file',
  'speech',
  'tts',
  'voice-design',
  'chat',
  'processor',
  'code',
  'json',
  'structured',
  'storyboard',
  'ai-process',
  'iterate',
  'director',
  'agent',
  'state-machine',
  'ai-review'
] as const

export function nodeAccessDirectorySummary(): ReturnType<typeof nodeActionSummary> {
  return nodeActionSummary()
}
export function operationDirectory(): unknown[] {
  return Object.entries(ACCESS_OPERATIONS).map(([operationId, spec]) => ({
    operationId,
    operationVersion: 1,
    effect: spec.effect,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.input),
    outputSchema: z.toJSONSchema(operationResponseSchema(operationId as AccessOperationId)),
    transports: ['cli', 'mcp-stdio']
  }))
}
export function validateAccessRegistry(
  activeTypes: readonly string[] = ACTIVE_NODE_TYPE_IDS,
  declarations: readonly string[] = NODE_ACCESS_DECLARATIONS
): string[] {
  const active = new Set<string>(activeTypes)
  const declared = new Set<string>(declarations)
  const errors = [...active].filter((id) => !declared.has(id)).map((id) => `UNDECLARED_NODE:${id}`)
  for (const id of declared) if (!active.has(id)) errors.push(`INACTIVE_NODE:${id}`)
  if (declared.size !== declarations.length) errors.push('DUPLICATE_NODE')
  for (const [id, spec] of Object.entries(ACCESS_OPERATIONS)) {
    if (
      !spec.input ||
      !spec.description ||
      !['read', 'write', 'export', 'delete', 'execute'].includes(spec.effect)
    )
      errors.push(`INVALID_OPERATION:${id}`)
    if (PACKAGE_IMPORT_BLOCKLIST.has(id)) errors.push(`EXCLUDED_OPERATION:${id}`)
  }
  // 逐节点动作矩阵必须自洽：缺类型/缺动作/非法状态/无证据都会让门禁失败。
  errors.push(...validateNodeActionMatrix())
  // 节点契约快照必须覆盖全部 Active 节点（漏节点/坏端口都阻断）。
  errors.push(...validateNodeContractSnapshot())
  return errors
}
