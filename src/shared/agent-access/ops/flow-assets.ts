import { z } from 'zod'
import { identifier, nodeId, project } from './common'

/**
 * 内部 Agent Flow 的**固定资产**操作（F8，flowAssets 族）。
 *
 * 固定资产是下游命令的输入来源：外部只能按台账提交新版本与读取既有版本，
 * 不能改写已提交版本的取值、不能伪造审核结论、也不能绕过命令占用（`ASSET_SOURCE_OCCUPIED`）。
 * 业务实现只有一份：`src/main/agent-flow/asset-store.ts` 的 `FlowAssetStore`
 * （与 GUI 资产面板、命令账本、审核宿主同一服务），外部入口只做项目作用域预检、
 * 活动画布 flush 握手（提交前把作者未保存编辑落盘，与 GUI `ensureCanvasSaved` 同一语义）
 * 与响应规模限制。
 *
 * 未登记：无。本族 3 个 GUI 动作全部开放（提交/列表/读取）。
 *
 * 新增操作的方法：在本文件的 `FLOW_ASSETS_OPERATIONS` 里登记
 * { effect, description, input }，并在 `FLOW_ASSETS_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/flow-assets-ops.ts 给实现。
 * 共享字段请从 ./common 引入；不要用 .refine()。
 */
const flowId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
const portId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/)
const flowAssetRef = z
  .object({
    assetId: flowId,
    versionId: flowId,
    sourceNodeId: flowId,
    sourcePortId: flowId
  })
  .strict()
const flowAssetSummary = z
  .object({
    ref: flowAssetRef,
    projectId: identifier,
    ordinal: z.number().int().positive(),
    graphVersion: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const FLOW_ASSETS_OPERATIONS = {
  'flowAsset.submit': {
    effect: 'write',
    description:
      '把项目已保存画布上某节点端口的结果固化为固定资产版本（幂等 submissionId）；活动画布先经桌面保存屏障，节点有未核对命令时拒绝，不接收外部提供的取值',
    input: project
      .extend({
        nodeId,
        portId,
        expectedGraphVersion: z.number().int().nonnegative()
      })
      .strict()
  },
  'flowAsset.list': {
    effect: 'read',
    description: '按节点端口列出固定资产版本摘要（序号/画布版本/摘要值），不返回取值正文；最多 100 条',
    input: project.extend({ nodeId, portId }).strict()
  },
  'flowAsset.read': {
    effect: 'read',
    description:
      '读取固定资产版本摘要与固定取值（文本/JSON 上限 20k 字符或 100k 编码字符，超出如实拒绝）；媒体只返回受控 mediaId 与相对引用，不返回绝对路径或字节',
    input: project.extend({ versionId: flowId }).strict()
  }
} as const

export const FLOW_ASSETS_OUTPUTS = {
  'flowAsset.submit': z
    .object({
      projectId: identifier,
      ref: flowAssetRef,
      ordinal: z.number().int().positive(),
      graphVersion: z.number().int().nonnegative(),
      createdAt: z.number().int().nonnegative(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      valueKind: z.enum(['text', 'markdown', 'json', 'image', 'audio', 'video'])
    })
    .strict(),
  'flowAsset.list': z
    .object({
      projectId: identifier,
      nodeId,
      portId,
      total: z.number().int().nonnegative(),
      items: z.array(flowAssetSummary).max(100)
    })
    .strict(),
  'flowAsset.read': z
    .object({
      projectId: identifier,
      ref: flowAssetRef,
      ordinal: z.number().int().positive(),
      graphVersion: z.number().int().nonnegative(),
      createdAt: z.number().int().nonnegative(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      valueKind: z.enum(['text', 'markdown', 'json', 'image', 'audio', 'video']),
      value: z
        .object({
          kind: z.enum(['text', 'markdown', 'json', 'image', 'audio', 'video']),
          text: z.string().max(20000).optional(),
          json: z.json().optional(),
          mediaId: z.string().max(160).optional(),
          mediaPath: z.string().max(300).optional(),
          mime: z.string().max(120).optional(),
          contentSha256: sha256.optional()
        })
        .strict()
    })
    .strict()
} as const
