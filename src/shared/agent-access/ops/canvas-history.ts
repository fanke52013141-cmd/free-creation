import { z } from 'zod'
import { identifier } from './common'

/**
 * 画布历史与项目生命周期（F2）：撤销/重做、关闭当前画布。
 *
 * 为什么必须经权威宿主：历史栈在 tldraw editor 里（与 GUI 同一份），main 自己维护一份
 * 必然与 GUI 分叉；关闭画布也必须先保存，否则会丢掉用户未保存的编辑。
 * 因此这两个操作的执行体都在 renderer，main 只做准入、核对与回执。
 *
 * 边界：
 * - 撤销/重做**只回滚画布编辑**，不会撤销远端副作用（已发生的模型调用/发布不会被"撤销"）；
 * - 撤销/重做之后必须重新读图版本：历史操作会改变图内容，图版本随之推进；
 * - 关闭项目只在目标是当前打开画布时允许（GUARD：不能关一个没开的项目）。
 */
export const CANVAS_HISTORY_OPERATIONS = {
  'canvas.history': {
    effect: 'write',
    description:
      '在当前打开的画布上执行一步撤销或重做（与 GUI 历史坞同一 editor 历史栈）；只回滚画布编辑，不会撤销已发生的模型调用或发布副作用；expectedGraphVersion 为**建议值**（只拒绝超前版本；保存屏障会推进版本，严格相等会使调用永远失败）；执行后保存并返回新的图版本',
    input: z
      .object({
        projectId: identifier,
        expectedGraphVersion: z.number().int().nonnegative(),
        direction: z.enum(['undo', 'redo'])
      })
      .strict()
  },
  'project.close': {
    effect: 'write',
    description:
      '保存并关闭当前打开的项目画布，回到项目列表（与 GUI 项目菜单"返回"同一动作）；只能关闭当前打开的画布，未打开的项目不会被误关',
    input: z.object({ projectId: identifier }).strict()
  }
} as const

export const CANVAS_HISTORY_OUTPUTS = {
  'canvas.history': z
    .object({
      projectId: identifier,
      direction: z.enum(['undo', 'redo']),
      graphVersion: z.number().int().nonnegative(),
      saved: z.literal(true)
    })
    .strict(),
  'project.close': z
    .object({ projectId: identifier, closed: z.literal(true) })
    .strict()
} as const
