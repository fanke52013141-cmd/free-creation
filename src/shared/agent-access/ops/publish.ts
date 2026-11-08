import { z } from 'zod'
import {
  PublishModeSchema,
  PublishStatusSchema,
  publishRequestIdSchema
} from '../publish'
import { nodeId, project, revision } from './common'

/**
 * 外部发布授权（F6 收尾）：导演台 manual-publish 的等待/继续协议。
 *
 * 导演台发布必须由人类在 GUI 授权（prepare 只生成待授权请求），
 * 外部不得用 node.execute 偷渡发布——node.execute 对 director 仍返回
 * "尚未发布/发布已过期"的 skipped 事实。
 *
 * 新增操作的方法：在本文件的 `PUBLISH_OPERATIONS` 里登记
 * { effect, description, input }，并在 `PUBLISH_OUTPUTS` 里给出输出 Schema
 * （registry.ts 用 satisfies Record<AccessOperationId, z.ZodType> 强制成对），
 * 再到 src/main/agent-access/service.ts 的 dispatch 给实现。
 */
const publishRequestInput = project
  .extend({
    publishRequestId: publishRequestIdSchema,
    expectedGraphVersion: z.number().int().nonnegative()
  })
  .strict()

export const PUBLISH_OPERATIONS = {
  'director.publish.prepare': {
    effect: 'write',
    description:
      '在当前打开的导演台节点上申请发布（frame=静帧 PNG，video=WebM 预演）；只创建待人工授权的请求，不渲染、不改变画布，授权与拒绝由 GUI 中的人决定',
    input: revision
      .extend({
        nodeId,
        mode: PublishModeSchema.default('frame'),
        shotId: z.string().min(1).max(80).optional()
      })
      .strict()
  },
  'director.publish.status': {
    effect: 'read',
    description:
      '读取一次发布申请的授权与执行状态（待授权/已授权/已拒绝/已过期/执行中/已完成/失败）；完成态返回正式产物媒体引用',
    input: project.extend({ publishRequestId: publishRequestIdSchema }).strict()
  },
  'director.publish.continue': {
    effect: 'write',
    description:
      '人工授权后执行发布：用与 GUI 相同的发布服务渲染并写入节点正式结果；未授权、已拒绝或已过期一律拒绝，不重放、不重复发布',
    input: publishRequestInput
  }
} as const

export const PUBLISH_OUTPUTS = {
  'director.publish.prepare': z
    .object({
      projectId: z.string(),
      publishRequestId: publishRequestIdSchema,
      nodeId,
      mode: PublishModeSchema,
      shotId: z.string().min(1).max(80),
      status: PublishStatusSchema,
      authorizationRequired: z.literal(true),
      expiresAt: z.number().int().nonnegative(),
      graphVersion: z.number().int().nonnegative()
    })
    .strict(),
  'director.publish.status': z
    .object({
      projectId: z.string(),
      publishRequestId: publishRequestIdSchema,
      nodeId,
      mode: PublishModeSchema,
      shotId: z.string().min(1).max(80),
      status: PublishStatusSchema,
      authorizationRequired: z.boolean(),
      expiresAt: z.number().int().nonnegative(),
      graphVersion: z.number().int().nonnegative(),
      artifact: z
        .object({
          mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
          mediaPath: z.string().min(1).max(400),
          mime: z.enum(['image/png', 'video/webm'])
        })
        .strict()
        .optional(),
      error: z.string().max(120).optional()
    })
    .strict(),
  'director.publish.continue': z
    .object({
      projectId: z.string(),
      publishRequestId: publishRequestIdSchema,
      nodeId,
      mode: PublishModeSchema,
      shotId: z.string().min(1).max(80),
      status: z.literal('completed'),
      graphVersion: z.number().int().nonnegative(),
      saved: z.literal(true),
      artifact: z
        .object({
          mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
          mediaPath: z.string().min(1).max(400),
          mime: z.enum(['image/png', 'video/webm'])
        })
        .strict()
    })
    .strict()
} as const
