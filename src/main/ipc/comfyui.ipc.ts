// ComfyUI 桥 IPC：连接状态检测 + 服务地址配置。
import { ipcMain } from 'electron'
import { IPC } from '../../shared/contracts'
import type { ComfyuiSettingsInput, ComfyuiStatus, IpcEnvelope } from '../../shared/contracts'
import { ComfyuiError, comfyuiHasNodeClass, comfyuiSystemStats } from '../comfyui/client'
import { getComfyuiBaseUrl, saveComfyuiBaseUrl } from '../comfyui/settings'

const NODE_SYNTHESIS = 'BSAI_IndexTTS2.5Synthesis'

function ok<T>(data: T): IpcEnvelope<T> {
  return { ok: true, data }
}

function err(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

/** 探测 ComfyUI 在线状态与 IndexTTS 节点可用性；离线时返回带 message 的离线态而不是报错。 */
export async function queryComfyuiStatus(): Promise<ComfyuiStatus> {
  const baseUrl = getComfyuiBaseUrl()
  const status: ComfyuiStatus = {
    online: false,
    baseUrl,
    ttsNodeReady: false,
    message: ''
  }
  try {
    const stats = await comfyuiSystemStats(baseUrl)
    status.online = stats.online
    status.version = stats.version
    if (!stats.online) {
      status.message = 'ComfyUI 服务未启动'
      return status
    }
  } catch (error) {
    status.message =
      error instanceof ComfyuiError || error instanceof Error ? error.message : '无法连接 ComfyUI'
    return status
  }
  try {
    status.ttsNodeReady = await comfyuiHasNodeClass(baseUrl, NODE_SYNTHESIS)
  } catch {
    status.ttsNodeReady = false
  }
  status.message = status.ttsNodeReady
    ? `已连接${status.version ? `（ComfyUI ${status.version}）` : ''}`
    : `已连接，但未安装 IndexTTS-2.5 自定义节点`
  return status
}

export function registerComfyuiIpc(): void {
  ipcMain.handle(IPC.comfyui.status, async (): Promise<IpcEnvelope<ComfyuiStatus>> => {
    return ok(await queryComfyuiStatus())
  })

  ipcMain.handle(
    IPC.comfyui.saveSettings,
    async (_e, input: ComfyuiSettingsInput): Promise<IpcEnvelope<{ baseUrl: string }>> => {
      if (!input || typeof input.baseUrl !== 'string') {
        return err('INVALID_INPUT', '参数不完整')
      }
      try {
        return ok({ baseUrl: saveComfyuiBaseUrl(input.baseUrl) })
      } catch (error) {
        return err('INVALID_URL', error instanceof Error ? error.message : 'ComfyUI 地址无法解析')
      }
    }
  )
}
