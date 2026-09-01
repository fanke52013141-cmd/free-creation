// ComfyUI 桥：本地 ComfyUI 服务的最小 HTTP 客户端。
// 端点契约（与用户本地 ComfyUI server.py 逐一对齐）：
//   GET  /system_stats          探活 + 版本号
//   GET  /object_info/{class}   查询自定义节点是否已安装
//   POST /upload/image          上传参考音频到 input 目录（该端点无扩展名白名单）
//   POST /prompt                排队执行工作流（API JSON 格式）
//   GET  /history/{prompt_id}   轮询执行结果
//   GET  /view                  下载 output 目录中的产物
export class ComfyuiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ComfyuiError'
    this.code = code
  }
}

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${trimBase(baseUrl)}${path}`, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ComfyuiError('NETWORK_ERROR', `无法连接 ComfyUI（${baseUrl}）：${reason}`)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } | string }
      const raw = typeof body.error === 'string' ? body.error : body.error?.message
      detail = raw ? `：${raw.slice(0, 200)}` : ''
    } catch {
      /* 错误响应可能不是 JSON，忽略 */
    }
    throw new ComfyuiError('HTTP_ERROR', `ComfyUI ${path} 返回 HTTP ${res.status}${detail}`)
  }
  return (await res.json()) as T
}

export interface ComfyuiSystemStats {
  online: boolean
  version?: string
}

export async function comfyuiSystemStats(baseUrl: string): Promise<ComfyuiSystemStats> {
  const data = await requestJson<{ system?: { comfyui_version?: string } }>(
    baseUrl,
    '/system_stats'
  )
  return {
    online: true,
    version: data.system?.comfyui_version
  }
}

/** 查询节点类是否已注册（用于检测 BSAI_IndexTTS2.5 自定义节点）。 */
export async function comfyuiHasNodeClass(baseUrl: string, nodeClass: string): Promise<boolean> {
  const data = await requestJson<Record<string, unknown>>(baseUrl, `/object_info/${nodeClass}`)
  return Boolean(data[nodeClass])
}

export interface ComfyuiUploadedFile {
  name: string
  subfolder: string
}

/** 把参考音频上传到 ComfyUI input 目录；返回写入后的实际文件名。 */
export async function comfyuiUploadFile(
  baseUrl: string,
  fileName: string,
  buf: Buffer,
  mime: string
): Promise<ComfyuiUploadedFile> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(buf)], { type: mime }), fileName)
  form.append('overwrite', 'true')
  return requestJson<ComfyuiUploadedFile>(baseUrl, '/upload/image', {
    method: 'POST',
    body: form
  })
}

/** 提交工作流（API JSON），返回 prompt_id。 */
export async function comfyuiQueuePrompt(
  baseUrl: string,
  workflow: Record<string, unknown>
): Promise<string> {
  const data = await requestJson<{ prompt_id: string }>(baseUrl, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'canvas-studio' })
  })
  if (!data.prompt_id) throw new ComfyuiError('NO_PROMPT_ID', 'ComfyUI 未返回任务 ID')
  return data.prompt_id
}

export interface ComfyuiOutputFile {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyuiHistoryEntry {
  outputs: Record<string, Record<string, unknown>>
  status: { status_str?: string; completed?: boolean; messages?: unknown[] }
}

/** 查询任务历史；任务尚未进入历史时返回 null。 */
export async function comfyuiFetchHistory(
  baseUrl: string,
  promptId: string
): Promise<ComfyuiHistoryEntry | null> {
  const data = await requestJson<Record<string, ComfyuiHistoryEntry>>(
    baseUrl,
    `/history/${promptId}`
  )
  return data[promptId] ?? null
}

/** 从 output / temp 目录下载产物文件。 */
export async function comfyuiFetchView(baseUrl: string, file: ComfyuiOutputFile): Promise<Buffer> {
  const query = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? '',
    type: file.type ?? 'output'
  })
  let res: Response
  try {
    res = await fetch(`${trimBase(baseUrl)}/view?${query.toString()}`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ComfyuiError('NETWORK_ERROR', `下载合成结果失败：${reason}`)
  }
  if (!res.ok) {
    throw new ComfyuiError('VIEW_ERROR', `ComfyUI /view 返回 HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new ComfyuiError('EMPTY_RESULT', '合成结果为空')
  return buf
}
