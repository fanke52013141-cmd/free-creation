// F2：画布历史（撤销/重做）与关闭项目的外部实现。
//
// 两个操作都必须经权威宿主（renderer）执行：
// - 撤销/重做用 editor 自己的历史栈（与 GUI 历史坞同一份），main 不复制历史；
// - 关闭项目要先保存再回项目列表，否则会丢未保存编辑。
// main 侧只做准入（活动画布校验）、版本核对、回执与"关闭后清理 lastProjectId"。
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { DesktopAccessError, type AccessDesktop } from './desktop'

export const CANVAS_HISTORY_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'canvas.history',
  'project.close'
] as AccessOperationId[])

export interface CanvasHistoryContext {
  activeProjectId: () => string | null
  desktop?: AccessDesktop
  /** 关闭项目后清理"上次打开的项目"，避免下次启动又自动打开它。 */
  clearLastProject: () => void
}

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

export async function runCanvasHistoryOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: CanvasHistoryContext
): Promise<unknown> {
  const projectId = input.projectId as string
  const active = context.activeProjectId()
  // 两个操作都只作用于**当前打开**的画布：关闭一个没开的项目 / 撤销一个没打开的图
  // 都是"以为发生了其实没发生"的假成功，必须拒绝。
  if (active !== projectId)
    refuse('ACTIVE_PROJECT_REQUIRED', 'project.open the target canvas first')
  if (!context.desktop) refuse('DESKTOP_UNAVAILABLE', 'authoritative host is not running')

  if (operationId === 'canvas.history') {
    const direction = input.direction as 'undo' | 'redo'
    const expectedGraphVersion = input.expectedGraphVersion as number
    let reply: { graphVersion: number; result?: unknown }
    try {
      reply = await context.desktop.run(
        { action: 'history', projectId, direction, expectedGraphVersion },
        undefined,
        30000
      )
    } catch (error) {
      if (error instanceof DesktopAccessError) throw error
      refuse('HISTORY_FAILED', error instanceof Error ? error.message.slice(0, 120) : undefined)
    }
    if (!Number.isInteger(reply?.graphVersion))
      refuse('STORAGE_INCONSISTENT', 'host did not report graph version after history step')
    return { projectId, direction, graphVersion: reply.graphVersion, saved: true }
  }

  // project.close
  try {
    await context.desktop.run({ action: 'close-project', projectId }, undefined, 30000)
  } catch (error) {
    if (error instanceof DesktopAccessError) throw error
    refuse('CLOSE_FAILED', error instanceof Error ? error.message.slice(0, 120) : undefined)
  }
  context.clearLastProject()
  return { projectId, closed: true }
}
