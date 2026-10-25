import { ipcMain, type BrowserWindow } from 'electron'
import { IPC, type IpcEnvelope } from '../../shared/contracts'
import { FlowSkillStore } from '../agent-flow/skill-store'
import { getDb } from '../store/db'
import { AgentRuntimeError, type FixedSkill } from '../../shared/agent-flow/runtime-contracts'
import { emitGatewayEvent } from '../diagnostics/gateway-events'
import { newTraceId, newSpanId } from '../../shared/observability'

export function registerSkillLibraryIpc(window: () => BrowserWindow | null): void {
  const store = new FlowSkillStore(getDb())
  for (const channel of [IPC.skillLibrary.list, IPC.skillLibrary.install]) {
    ipcMain.handle(channel, (event, raw: unknown): IpcEnvelope<FixedSkill[] | FixedSkill> => {
      const active = window()
      if (
        !active ||
        active.isDestroyed() ||
        event.sender !== active.webContents ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        emitGatewayEvent(
          'skill.library.failed',
          'Skill 库操作被拒绝',
          {
            traceId: newTraceId(),
            spanId: newSpanId()
          },
          { status: 'failed', attributes: { phase: 'authorize', code: 'SKILL_SENDER_REJECTED' } }
        )
        return {
          ok: false,
          error: { code: 'SKILL_SENDER_REJECTED', message: '此窗口无法操作技能库' }
        }
      }
      try {
        return {
          ok: true,
          data: channel === IPC.skillLibrary.list ? store.list() : store.import(raw)
        }
      } catch (error) {
        const code = error instanceof AgentRuntimeError ? error.code : 'SKILL_STORAGE_FAILED'
        return {
          ok: false,
          error: {
            code,
            message:
              code === 'SKILL_VERSION_IMMUTABLE'
                ? '该技能版本已存在且内容不同，请更新版本号后安装'
                : '技能读取或安装失败，请检查包格式和存储空间'
          }
        }
      }
    })
  }
}
