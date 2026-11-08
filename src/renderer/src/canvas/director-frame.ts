// 导演台 2D 预演的画面与发布实现，从 DirectorStudioPanel 抽出为共享模块。
//
// 抽出原因（F6 收尾）：外部发布授权通过权威宿主执行，宿主必须调用**与 GUI 完全相同**
// 的发布实现（画帧 → 导入受控媒体 → 写正式发布记录），不能另写一份渲染/落盘逻辑。
// 3D 白模需要已挂载的 WebGL 视口，宿主侧无法凭空渲染，因此如实返回失败而不是伪造文件。
import type { Editor, TLShapeId } from 'tldraw'
import {
  createDirectorPublishRecord,
  DIRECTOR_DURATION_RANGE_SEC,
  evaluateDirectorShot,
  parseDirectorPublishRecord,
  type DirectorCamera,
  type DirectorProjectData,
  type DirectorPublishRecord,
  type DirectorShot
} from '../nodes/director-data'
import { markUndoPoint } from './history'

interface MediaBridge {
  importMediaBuffer(input: {
    projectId: string
    mime: string
    name: string
    data: Uint8Array
  }): Promise<{ ok: boolean; data?: { id: string; path: string; mime: string }; error?: { message: string } }>
}

function getMediaBridge(): MediaBridge {
  // Vite 的独立渲染页可用于界面预览；只有 Electron preload 才可导入本地媒体。
  const bridge = (window as unknown as { api?: MediaBridge }).api
  if (!bridge?.importMediaBuffer) {
    throw new Error('预演发布仅支持桌面应用，请在 Canvas Studio 中打开此项目')
  }
  return bridge
}

export function shotAspect(camera: DirectorCamera): { w: number; h: number } {
  return camera.aspectRatio === '9:16' || camera.aspectRatio === '3:4'
    ? { w: 720, h: 960 }
    : camera.aspectRatio === '4:3'
      ? { w: 960, h: 720 }
      : { w: 1280, h: 720 }
}

export function drawShotFrame(canvas: HTMLCanvasElement, shot: DirectorShot, progress = 0): void {
  const { w, h } = shotAspect(shot.camera)
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const horizon = h * 0.53
  const sky = ctx.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, '#172638')
  sky.addColorStop(0.56, '#324a5f')
  sky.addColorStop(0.561, '#1e2730')
  sky.addColorStop(1, '#0e1319')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(255,255,255,.11)'
  ctx.lineWidth = 1
  for (let i = 1; i < 10; i += 1) {
    const y = horizon + ((h - horizon) * i) / 10
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  for (let i = -10; i <= 10; i += 1) {
    ctx.beginPath()
    ctx.moveTo(w / 2, horizon)
    ctx.lineTo(w / 2 + (i * w) / 8, h)
    ctx.stroke()
  }
  // 构图线只用于预演，不代表真实三维模型或正式制作标注。
  ctx.setLineDash([8, 8])
  ctx.strokeStyle = 'rgba(245,158,11,.26)'
  if (shot.guides.thirds) {
    for (const x of [w / 3, (w * 2) / 3]) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    for (const y of [h / 3, (h * 2) / 3]) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
  }
  if (shot.guides.safeFrame) {
    ctx.strokeStyle = 'rgba(96,165,250,.35)'
    ctx.strokeRect(w * 0.06, h * 0.06, w * 0.88, h * 0.88)
  }
  if (shot.guides.eyeline) {
    ctx.strokeStyle = 'rgba(125,211,252,.34)'
    ctx.beginPath()
    ctx.moveTo(w * 0.08, h * 0.42)
    ctx.lineTo(w * 0.92, h * 0.42)
    ctx.stroke()
  }
  ctx.setLineDash([])
  for (const actor of shot.actors) {
    const x = (actor.x / 100) * w
    const y = (actor.y / 100) * h
    const scale = Math.max(0.35, Math.min(2.5, actor.scale)) * (h / 720)
    const bounce =
      actor.pose === '行走' || actor.pose === '奔跑' ? Math.sin(progress * Math.PI * 8) * 5 : 0
    ctx.fillStyle = actor.color
    ctx.beginPath()
    ctx.arc(x, y - 70 * scale + bounce, 19 * scale, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(x - 17 * scale, y - 50 * scale + bounce, 34 * scale, 58 * scale)
    ctx.lineWidth = 7 * scale
    ctx.lineCap = 'round'
    ctx.strokeStyle = actor.color
    ctx.beginPath()
    ctx.moveTo(x - 9 * scale, y + 8 * scale + bounce)
    ctx.lineTo(x - 16 * scale, y + 42 * scale + bounce)
    ctx.moveTo(x + 9 * scale, y + 8 * scale + bounce)
    ctx.lineTo(x + 16 * scale, y + 42 * scale + bounce)
    ctx.stroke()
    ctx.font = `${Math.max(12, 14 * scale)}px sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,.94)'
    ctx.fillText(actor.name, x + 24 * scale, y - 66 * scale + bounce)
  }
  ctx.fillStyle = 'rgba(0,0,0,.48)'
  ctx.fillRect(0, 0, w, 42)
  ctx.fillStyle = '#f8fafc'
  ctx.font = '600 18px sans-serif'
  ctx.fillText(shot.name, 18, 27)
  ctx.font = '13px sans-serif'
  ctx.fillStyle = 'rgba(248,250,252,.78)'
  ctx.fillText(`${shot.camera.focalLengthMm}mm · ${shot.camera.aspectRatio} · ${shot.camera.fps}fps`, w - 245, 27)
  if (shot.scene.trim()) {
    ctx.font = '15px sans-serif'
    ctx.fillStyle = 'rgba(248,250,252,.88)'
    ctx.fillText(shot.scene.slice(0, 80), 18, h - 24)
  }
}

export async function canvasBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime))
  if (!blob) throw new Error('无法生成预演图像')
  return blob
}

export async function recordShotPreview(shot: DirectorShot): Promise<Blob> {
  if (!('MediaRecorder' in window)) throw new Error('当前环境不支持 WebM 预演导出')
  const canvas = document.createElement('canvas')
  // 必须先设定画布尺寸再创建轨道，否则部分 Chromium 版本会把预览固定为默认的 300×150。
  drawShotFrame(canvas, shot)
  const stream = canvas.captureStream(shot.camera.fps)
  const options = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? { mimeType: 'video/webm;codecs=vp9' }
    : { mimeType: 'video/webm' }
  const recorder = new MediaRecorder(stream, options)
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  // 导出时长与镜头时长用同一份上限：此前这里写死 10 秒，长镜头的 WebM 会被静默截断，
  // 而界面告警却在说 12 秒。
  const durationMs = Math.max(
    1000,
    Math.min(DIRECTOR_DURATION_RANGE_SEC[1] * 1000, shot.camera.durationSec * 1000)
  )
  const startedAt = performance.now()
  return await new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('预演视频编码失败'))
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))
    const tick = (now: number): void => {
      const elapsed = now - startedAt
      const timeSec = Math.min(shot.camera.durationSec, elapsed / 1000)
      drawShotFrame(canvas, evaluateDirectorShot(shot, timeSec), Math.min(1, elapsed / durationMs))
      if (elapsed < durationMs && recorder.state === 'recording') requestAnimationFrame(tick)
      else if (recorder.state === 'recording') recorder.stop()
    }
    recorder.start(200)
    requestAnimationFrame(tick)
  })
}

export interface PublishedMedia {
  mediaId: string
  mediaPath: string
  mime: string
}

/**
 * 把一次预演结果写进节点正式发布记录（GUI 与外部授权发布共用）。
 * 只接受受控媒体事实；不在这里做保存，保存屏障由调用方（面板自动保存/宿主）负责。
 */
export function writeDirectorPublishRecord(input: {
  editor: Editor
  shapeId: TLShapeId
  project: DirectorProjectData
  shot: DirectorShot
  patch: Pick<DirectorPublishRecord, 'frame' | 'video'>
}): void {
  const shape = input.editor.getShape(input.shapeId) as
    | { type: string; meta?: Record<string, unknown> }
    | undefined
  if (!shape) throw new Error('导演台节点已不存在')
  let previous: DirectorPublishRecord | null = null
  try {
    previous = parseDirectorPublishRecord(
      typeof shape.meta?.nodeResult === 'string' ? JSON.parse(shape.meta.nodeResult) : null
    )
  } catch {
    // 新发布结果覆盖损坏记录。
  }
  const result = createDirectorPublishRecord(input.project, input.shot, previous, input.patch)
  input.editor.updateShape({
    id: input.shapeId,
    type: 'node-card',
    props: { exec: 'success' },
    meta: { ...(shape.meta ?? {}), nodeResult: JSON.stringify(result) }
  })
  markUndoPoint(input.editor, 'director-publish')
}

/**
 * 发布一帧/一段预演并返回受控媒体事实。
 *
 * 仅 2D 预演可在任意宿主中渲染；3D 白模需要用户已打开的 WebGL 视口，
 * 缺视口时抛 PUBLISH_VIEWPORT_UNAVAILABLE（如实失败，不伪造文件）。
 */
export async function publishDirectorOutput(input: {
  editor: Editor
  shapeId: TLShapeId
  projectId: string
  project: DirectorProjectData
  shot: DirectorShot
  mode: 'frame' | 'video'
  viewport: '2d' | '3d'
}): Promise<PublishedMedia> {
  if (input.viewport === '3d') {
    // 3D 渲染依赖挂载中的预演视口；宿主无法替用户打开工作区后静默渲染。
    throw new Error('PUBLISH_VIEWPORT_UNAVAILABLE')
  }
  let blob: Blob
  if (input.mode === 'frame') {
    const canvas = document.createElement('canvas')
    drawShotFrame(canvas, input.shot)
    blob = await canvasBlob(canvas, 'image/png')
  } else {
    blob = await recordShotPreview(input.shot)
  }
  const mime = input.mode === 'frame' ? 'image/png' : 'video/webm'
  const imported = await getMediaBridge().importMediaBuffer({
    projectId: input.projectId,
    mime,
    name: `${input.shot.name}-${input.mode === 'frame' ? '2D预演帧' : '2D预演'}`,
    data: new Uint8Array(await blob.arrayBuffer())
  })
  if (!imported.ok || !imported.data) throw new Error(imported.error?.message ?? 'MEDIA_IMPORT_FAILED')
  const asset = imported.data
  writeDirectorPublishRecord({
    editor: input.editor,
    shapeId: input.shapeId,
    project: input.project,
    shot: input.shot,
    patch:
      input.mode === 'frame'
        ? { frame: { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime } }
        : { video: { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime } }
  })
  return { mediaId: asset.id, mediaPath: asset.path, mime: asset.mime }
}
