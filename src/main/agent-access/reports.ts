import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { ACCESS_TASK_REPORT, GUI_LOCAL_RUN_TASK_PREFIX } from '../../shared/agent-access/desktop'
import { reportExternalRun } from './runs'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { clearGuiRunBusy, setGuiRunBusy } from './gui-busy'
import { externalRunErrorCode } from './run-errors'

// 外部执行任务的宿主报告通道（F3）。renderer 引擎在任务开始/到达终态时上报；
// main 校验任务存在与状态迁移合法性。只接受状态码与稳定摘要，不接收正文。
const TaskReportSchema = z
  .object({
    taskId: z.string().min(1).max(160),
    projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    error: z.string().max(500).optional()
  })
  .strict()

export function registerLocalAgentTaskReports(getWindow: () => BrowserWindow | null): void {
  const initialWindow = getWindow()
  if (initialWindow) {
    const clear = (): void => clearGuiRunBusy()
    initialWindow.webContents.once('destroyed', clear)
    initialWindow.webContents.once('render-process-gone', clear)
  }
  ipcMain.on(ACCESS_TASK_REPORT, (event, raw: unknown) => {
    const window = getWindow()
    if (!window || event.sender !== window.webContents) return
    const parsed = TaskReportSchema.safeParse(raw)
    if (!parsed.success) return
    if (parsed.data.taskId.startsWith(GUI_LOCAL_RUN_TASK_PREFIX)) {
      setGuiRunBusy(parsed.data.projectId, parsed.data.status === 'running')
      return
    }
    const row = reportExternalRun(parsed.data.taskId, parsed.data.status, {
      error:
        parsed.data.status === 'failed'
          ? externalRunErrorCode(parsed.data.error)
          : undefined
    })
    if (!row || row.project_id !== parsed.data.projectId) return
    emitGatewayEvent(
      `agent.access.task_${parsed.data.status}`,
      '外部执行任务状态',
      undefined,
      {
        upstreamTaskId: parsed.data.taskId,
        ...(parsed.data.status === 'running'
          ? {}
          : { status: parsed.data.status === 'completed' ? ('success' as const) : (parsed.data.status as 'failed' | 'cancelled') }),
        attributes: { operation: 'node.execute', phase: parsed.data.status }
      }
    )
  })
}
