// 导演台：独立全屏的预演工作区。它不绕过节点契约；同步输入和发布输出都只通过
// 明确的 portId 完成。当前版本提供构图/机位/镜头/角色/时间轴和 PNG/WebM 发布，
// 后续可在同一数据协议上替换为 Three.js 白模视口。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { gatherUpstreamJson, gatherUpstreamMediaList } from './graph'
import { markUndoPoint } from './history'
import { Icon } from '../components/Icon'
import {
  createDirectorId,
  createDirectorPublishRecord,
  createDirectorShot,
  evaluateDirectorShot,
  isDirectorPublishCurrent,
  moveDirectorShot,
  nextDirectorProjectRevision,
  parseDirectorProject,
  parseDirectorPublishRecord,
  removeDirectorShot,
  recordDirectorActorKeyframe,
  recordDirectorCameraKeyframe,
  type DirectorCamera,
  type DirectorProjectData,
  type DirectorPublishRecord,
  type DirectorShot
} from '../nodes/director-data'
import { validateNodeSchema } from '@shared/node-schemas'
import { getNodePorts, getNodeType, mediaUrl } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { readNodeConfig } from './node-persistence'
import { toast } from '../stores/toast'
import { Director3DViewport, type Director3DViewportHandle } from './Director3DViewport'

type MediaBridge = Pick<typeof window.api, 'importMediaBuffer'>

function getMediaBridge(): MediaBridge {
  // Vite 的独立渲染页可用于界面预览；只有 Electron preload 才可导入本地媒体。
  const bridge = (window as unknown as { api?: MediaBridge }).api
  if (!bridge?.importMediaBuffer) {
    throw new Error('预演发布仅支持桌面应用，请在 Canvas Studio 中打开此项目')
  }
  return bridge
}

interface DirectorStudioPanelProps {
  editor: Editor
  projectId: string
  shapeId: TLShapeId
  onClose: () => void
}

function activeShot(project: DirectorProjectData): DirectorShot {
  return project.shots.find((shot) => shot.id === project.activeShotId) ?? project.shots[0]
}

function shotAspect(camera: DirectorCamera): { w: number; h: number } {
  return camera.aspectRatio === '9:16' || camera.aspectRatio === '3:4'
    ? { w: 720, h: 960 }
    : camera.aspectRatio === '4:3'
      ? { w: 960, h: 720 }
      : { w: 1280, h: 720 }
}

function drawShotFrame(canvas: HTMLCanvasElement, shot: DirectorShot, progress = 0): void {
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
  ctx.fillText(
    `${shot.camera.focalLengthMm}mm · ${shot.camera.aspectRatio} · ${shot.camera.fps}fps`,
    w - 245,
    27
  )
  if (shot.scene.trim()) {
    ctx.font = '15px sans-serif'
    ctx.fillStyle = 'rgba(248,250,252,.88)'
    ctx.fillText(shot.scene.slice(0, 80), 18, h - 24)
  }
}

function DirectorShotThumbnail({ shot }: { shot: DirectorShot }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawShotFrame(ref.current, shot)
  }, [shot])
  return <canvas ref={ref} aria-label={`${shot.name} 缩略图`} />
}

async function canvasBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime))
  if (!blob) throw new Error('无法生成预演图像')
  return blob
}

async function recordShotPreview(shot: DirectorShot): Promise<Blob> {
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
  const durationMs = Math.max(1000, Math.min(10_000, shot.camera.durationSec * 1000))
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

export function DirectorStudioPanel({
  editor,
  projectId,
  shapeId,
  onClose
}: DirectorStudioPanelProps): React.JSX.Element | null {
  const shape = editor.getShape<NodeCardShape>(shapeId)
  const initial = shape?.type === 'node-card' ? parseDirectorProject(readNodeConfig(shape)) : null
  const [project, setProject] = useState<DirectorProjectData | null>(initial)
  const [timeline, setTimeline] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'shots' | 'inspector' | null>(null)
  const [viewportMode, setViewportMode] = useState<'2d' | '3d'>('2d')
  const [publishing, setPublishing] = useState<'frame' | 'video' | null>(null)
  const [videoProgress, setVideoProgress] = useState<number | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const director3dRef = useRef<Director3DViewportHandle>(null)
  const playbackStartedAtRef = useRef<number | null>(null)
  const videoAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shot = useMemo(() => (project ? activeShot(project) : null), [project])
  const previewShot = useMemo(
    () => (shot ? evaluateDirectorShot(shot, timeline) : null),
    [shot, timeline]
  )
  useEffect(() => {
    if (previewShot && previewRef.current) {
      drawShotFrame(previewRef.current, previewShot, timeline / previewShot.camera.durationSec)
    }
  }, [previewShot, timeline])
  useEffect(() => {
    if (!isPlaying || !shot) return
    const startedAt = playbackStartedAtRef.current ?? performance.now()
    let frame = 0
    const tick = (now: number): void => {
      const next = Math.min(shot.camera.durationSec, (now - startedAt) / 1000)
      setTimeline(next)
      if (next >= shot.camera.durationSec) setIsPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [isPlaying, shot])

  if (!shape || shape.type !== 'node-card' || !project || !shot || !previewShot) return null

  let published: DirectorPublishRecord | null = null
  try {
    published = parseDirectorPublishRecord(
      typeof shape.meta?.nodeResult === 'string' ? JSON.parse(shape.meta.nodeResult) : null
    )
  } catch {
    // 损坏记录按未发布处理。
  }
  const activeShotPublished =
    isDirectorPublishCurrent(project, published) && published.shotId === shot.id

  const save = (next: Omit<DirectorProjectData, 'revision'>, affectsPublish = true): void => {
    const revised = nextDirectorProjectRevision(project, next, affectsPublish)
    setProject(revised)
    editor.updateShape({
      id: shapeId,
      type: 'node-card',
      props: { config: JSON.stringify(revised) }
    })
  }
  const patchShot = (patch: Partial<DirectorShot>): void => {
    const next = {
      ...project,
      shots: project.shots.map((item) => (item.id === shot.id ? { ...item, ...patch } : item))
    }
    save(next)
  }
  const patchCamera = (patch: Partial<DirectorCamera>): void =>
    patchShot({ camera: { ...shot.camera, ...patch } })
  const patchActor = (actorId: string, patch: Partial<DirectorShot['actors'][number]>): void =>
    patchShot({
      actors: shot.actors.map((item) => (item.id === actorId ? { ...item, ...patch } : item))
    })
  const removeActor = (actorId: string): void => {
    if (shot.actors.length <= 1) return toast('每个镜头至少保留一个角色')
    patchShot({ actors: shot.actors.filter((actor) => actor.id !== actorId) })
  }

  const syncInputs = (): void => {
    const story = gatherUpstreamJson(editor, shapeId, 'in-storyboard') as { shots?: unknown } | null
    const references = gatherUpstreamMediaList(editor, shapeId, 'in-reference-images', 'image')
    const preset = gatherUpstreamJson(
      editor,
      shapeId,
      'in-camera-preset'
    ) as Partial<DirectorCamera> | null
    const spec = getNodeType(shape.props.nodeType)
    const ports = spec ? getNodePorts(spec, shape).in : []
    const validateInput = (portId: string, value: unknown): string[] => {
      if (value === null || value === undefined) return []
      const port = ports.find((item) => item.id === portId)
      if (!port?.schema) return []
      const validation = validateNodeSchema(port.schema, value)
      return validation.ok ? [] : validation.errors.map((error) => `${port.name}：${error}`)
    }
    const errors = [
      ...validateInput('in-storyboard', story),
      ...validateInput('in-camera-preset', preset)
    ]
    if (errors.length > 0) {
      toast(`无法同步：${errors.join('；')}`)
      return
    }
    let shots = project.shots
    if (Array.isArray(story?.shots) && story.shots.length > 0) {
      shots = story.shots.map((raw, index) => {
        const source = raw as Record<string, unknown>
        const next = createDirectorShot(
          typeof source.id === 'string' || typeof source.scene === 'string'
            ? `镜头 ${String(index + 1).padStart(2, '0')}`
            : `镜头 ${index + 1}`
        )
        return {
          ...next,
          id: typeof source.id === 'string' ? source.id : next.id,
          scene: typeof source.scene === 'string' ? source.scene : '',
          dialogue: typeof source.dialogue === 'string' ? source.dialogue : '',
          camera:
            preset && typeof preset.focalLengthMm === 'number'
              ? { ...next.camera, ...preset }
              : next.camera,
          referenceMediaIds: references.map((item) => item.mediaId),
          referenceMediaPaths: references.map((item) => item.mediaPath)
        }
      })
    } else if (references.length > 0) {
      shots = project.shots.map((item) => ({
        ...item,
        referenceMediaIds: references.map((value) => value.mediaId),
        referenceMediaPaths: references.map((value) => value.mediaPath),
        camera:
          preset && typeof preset.focalLengthMm === 'number'
            ? { ...item.camera, ...preset }
            : item.camera
      }))
    }
    const activeShotId = shots.some((item) => item.id === project.activeShotId)
      ? project.activeShotId
      : shots[0].id
    save({ version: 1, activeShotId, shots })
    markUndoPoint(editor, 'director-sync-inputs')
    toast(
      `已同步 ${Array.isArray(story?.shots) ? story.shots.length : 0} 个分镜与 ${references.length} 张参考图`
    )
  }

  const writePublish = (
    patch: Pick<DirectorPublishRecord, 'frame' | 'video'>,
    publishedShot = shot
  ): void => {
    let previous: DirectorPublishRecord | null = null
    try {
      previous = parseDirectorPublishRecord(
        typeof shape.meta?.nodeResult === 'string' ? JSON.parse(shape.meta.nodeResult) : null
      )
    } catch {
      // 新发布结果覆盖损坏记录。
    }
    const result = createDirectorPublishRecord(project, publishedShot, previous, patch)
    editor.updateShape({
      id: shapeId,
      type: 'node-card',
      props: { exec: 'success' },
      meta: { ...(shape.meta ?? {}), nodeResult: JSON.stringify(result) }
    })
    markUndoPoint(editor, 'director-publish')
  }

  const publishFrame = async (): Promise<void> => {
    setPublishing('frame')
    try {
      const blob =
        viewportMode === '3d'
          ? await director3dRef.current?.captureDirectorFrame()
          : await (() => {
              const canvas = document.createElement('canvas')
              drawShotFrame(canvas, previewShot, timeline / previewShot.camera.durationSec)
              return canvasBlob(canvas, 'image/png')
            })()
      if (!blob) throw new Error('3D 预演尚未就绪，请稍后重试')
      const result = await getMediaBridge().importMediaBuffer({
        projectId,
        mime: 'image/png',
        name: `${shot.name}-${viewportMode === '3d' ? '3D白模帧' : '2D预演帧'}`,
        data: new Uint8Array(await blob.arrayBuffer())
      })
      if (!result.ok) throw new Error(result.error.message)
      writePublish(
        { frame: { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime } },
        previewShot
      )
      toast(`${viewportMode === '3d' ? '3D 白模帧' : '2D 预演帧'}已发布，可连接给下游节点`)
    } catch (error) {
      toast(`发布失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setPublishing(null)
    }
  }

  const publishVideo = async (): Promise<void> => {
    setPublishing('video')
    setVideoProgress(0)
    const controller = new AbortController()
    videoAbortRef.current = controller
    try {
      const blob =
        viewportMode === '3d'
          ? await director3dRef.current?.recordDirectorVideo(
              shot,
              (progress) => setVideoProgress(progress),
              controller.signal
            )
          : await recordShotPreview(shot)
      if (!blob) throw new Error('3D 预演尚未就绪，请稍后重试')
      const result = await getMediaBridge().importMediaBuffer({
        projectId,
        mime: 'video/webm',
        name: `${shot.name}-${viewportMode === '3d' ? '3D白模预演' : '2D预演'}`,
        data: new Uint8Array(await blob.arrayBuffer())
      })
      if (!result.ok) throw new Error(result.error.message)
      writePublish({
        video: { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime }
      })
      toast(`${viewportMode === '3d' ? '3D 白模' : '2D'}预演视频已发布，可连接给下游视频节点`)
    } catch (error) {
      toast(`视频导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setPublishing(null)
      setVideoProgress(null)
      videoAbortRef.current = null
    }
  }

  const addShot = (): void => {
    const nextShot = createDirectorShot(`镜头 ${String(project.shots.length + 1).padStart(2, '0')}`)
    save({ ...project, activeShotId: nextShot.id, shots: [...project.shots, nextShot] })
    markUndoPoint(editor, 'director-add-shot')
  }

  const duplicateShot = (): void => {
    const copy = JSON.parse(JSON.stringify(shot)) as DirectorShot
    copy.id = createDirectorId('shot')
    copy.name = `${shot.name} 副本`
    copy.actors = copy.actors.map((actor) => ({ ...actor, id: createDirectorId('actor') }))
    save({ ...project, activeShotId: copy.id, shots: [...project.shots, copy] })
    markUndoPoint(editor, 'director-duplicate-shot')
  }

  const moveShot = (offset: -1 | 1): void => {
    const shots = moveDirectorShot(project.shots, shot.id, offset)
    if (shots === project.shots) return
    save({ version: 1, activeShotId: project.activeShotId, shots })
    markUndoPoint(editor, 'director-move-shot')
  }

  const deleteShot = (): void => {
    const next = removeDirectorShot(project, shot.id)
    if (!next) return toast('导演工程至少保留一个镜头')
    save(next)
    markUndoPoint(editor, 'director-delete-shot')
  }

  return (
    <div className="director-studio-mask" role="dialog" aria-modal="true" aria-label="导演台">
      <section className="director-studio">
        <header className="director-topbar">
          <div className="director-brand">
            <Icon name="director" size={18} /> 导演台 <small>PREVIS</small>
          </div>
          <div className="director-project-title">
            {shape.props.title} · {shot.name}
            <small
              className={
                activeShotPublished ? 'director-publish-state published' : 'director-publish-state'
              }
            >
              {activeShotPublished ? '当前镜头已发布' : published ? '当前镜头尚未发布' : '尚未发布'}
            </small>
          </div>
          <div className="director-top-actions">
            <button onClick={syncInputs} title="同步连线输入">
              <Icon name="reset" size={14} /> 同步连线输入
            </button>
            <button
              onClick={() => void publishFrame()}
              disabled={publishing !== null}
              title="发布当前预演帧"
            >
              <Icon name="image" size={14} />{' '}
              {publishing === 'frame'
                ? '发布中…'
                : viewportMode === '3d'
                  ? '发布 3D 帧'
                  : '发布 2D 帧'}
            </button>
            <button
              onClick={() => void publishVideo()}
              disabled={publishing !== null}
              title="导出当前镜头 WebM"
            >
              <Icon name="video" size={14} />{' '}
              {publishing === 'video'
                ? `导出 ${Math.round((videoProgress ?? 0) * 100)}%`
                : viewportMode === '3d'
                  ? '导出 3D WebM'
                  : '导出 WebM'}
            </button>
            {publishing === 'video' && viewportMode === '3d' && (
              <button onClick={() => videoAbortRef.current?.abort()} title="取消 3D 视频导出">
                取消
              </button>
            )}
            <button
              className="director-mobile-panel-toggle"
              aria-label="切换镜头列表"
              aria-pressed={mobilePanel === 'shots'}
              onClick={() => setMobilePanel((panel) => (panel === 'shots' ? null : 'shots'))}
              title="镜头列表"
            >
              <Icon name="minimap" size={15} /> 镜头
            </button>
            <button
              className="director-mobile-panel-toggle"
              aria-label="切换镜头属性"
              aria-pressed={mobilePanel === 'inspector'}
              onClick={() =>
                setMobilePanel((panel) => (panel === 'inspector' ? null : 'inspector'))
              }
              title="镜头属性"
            >
              <Icon name="settings" size={15} /> 属性
            </button>
            <button className="director-close" onClick={onClose} title="关闭导演台">
              <Icon name="close" size={17} />
            </button>
          </div>
        </header>
        <div className={`director-main ${mobilePanel ? `mobile-panel-${mobilePanel}` : ''}`}>
          <aside className="director-left-panel">
            <div className="director-panel-head">
              <strong>镜头</strong>
              <button onClick={addShot} title="新增镜头">
                <Icon name="add" size={15} />
              </button>
            </div>
            <div className="director-shot-list">
              {project.shots.map((item, index) => (
                <div
                  className={`director-shot-row ${item.id === shot.id ? 'active' : ''}`}
                  key={item.id}
                >
                  <button
                    className="director-shot-card"
                    onClick={() => {
                      save({ ...project, activeShotId: item.id }, false)
                      setMobilePanel(null)
                    }}
                  >
                    <span className="director-shot-thumb">
                      <DirectorShotThumbnail shot={item} />
                      <i>{String(index + 1).padStart(2, '0')}</i>
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.camera.durationSec}s · {item.camera.aspectRatio}
                      </small>
                    </span>
                  </button>
                  {item.id === shot.id && (
                    <div className="director-shot-actions">
                      <button disabled={index === 0} onClick={() => moveShot(-1)} title="上移镜头">
                        上移
                      </button>
                      <button
                        disabled={index === project.shots.length - 1}
                        onClick={() => moveShot(1)}
                        title="下移镜头"
                      >
                        下移
                      </button>
                      <button onClick={deleteShot} title="删除当前镜头">
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="director-resource-note">
              <Icon name="attach" size={13} /> {shot.referenceMediaIds.length} 张真实连线参考图
            </div>
          </aside>
          <main className="director-viewport">
            <div className="director-viewport-tools">
              <span>{viewportMode === '3d' ? '3D 白模预演' : '2D 构图预演'}</span>
              <span className="director-viewport-mode">
                <button
                  className={viewportMode === '2d' ? 'active' : ''}
                  onClick={() => setViewportMode('2d')}
                >
                  2D
                </button>
                <button
                  className={viewportMode === '3d' ? 'active' : ''}
                  onClick={() => setViewportMode('3d')}
                >
                  3D
                </button>
              </span>
            </div>
            {viewportMode === '3d' ? (
              <Director3DViewport ref={director3dRef} shot={previewShot} />
            ) : (
              <div
                className={`director-camera-monitor aspect-${shot.camera.aspectRatio.replace(':', '-')}`}
              >
                <canvas ref={previewRef} />
                {shot.referenceMediaPaths[0] && (
                  <div
                    className="director-reference-overlay"
                    style={{ opacity: shot.referenceOpacity }}
                  >
                    <img src={mediaUrl(shot.referenceMediaPaths[0])} alt="构图参考图" />
                  </div>
                )}
                <div className="director-monitor-label">
                  CAM 01 · {shot.camera.focalLengthMm}mm · {shot.camera.aspectRatio}
                </div>
              </div>
            )}
            <div className="director-scene-summary">
              {shot.scene || '填写画面描述，建立本镜头的预演意图。'}
            </div>
          </main>
          <aside className="director-inspector">
            <div className="director-panel-head">
              <strong>属性</strong>
              <button onClick={duplicateShot} title="复制当前镜头">
                <Icon name="copy" size={14} />
              </button>
            </div>
            <label>
              镜头名称
              <input
                value={shot.name}
                onChange={(event) => patchShot({ name: event.target.value || '未命名镜头' })}
              />
            </label>
            <label>
              画面描述
              <textarea
                value={shot.scene}
                onChange={(event) => patchShot({ scene: event.target.value })}
                placeholder="例如：低机位，两人站在雨夜街口"
              />
            </label>
            <label>
              台词
              <input
                value={shot.dialogue}
                onChange={(event) => patchShot({ dialogue: event.target.value })}
                placeholder="可选"
              />
            </label>
            <div className="director-inspector-group">
              <strong>摄像机</strong>
              <button
                className="director-record-keyframe"
                onClick={() =>
                  patchShot({ timeline: recordDirectorCameraKeyframe(shot, timeline).timeline })
                }
              >
                在 {timeline.toFixed(2)} 秒记录机位
              </button>
              <div className="director-camera-transform">
                {(
                  [
                    ['X', 'x', -50, 50, 0.1],
                    ['Y', 'y', -10, 30, 0.1],
                    ['Z', 'z', -50, 50, 0.1],
                    ['方位', 'heading', -360, 360, 1],
                    ['俯仰', 'pitch', -89, 89, 1]
                  ] as const
                ).map(([label, key, min, max, step]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min={min}
                      max={max}
                      step={step}
                      value={shot.camera[key]}
                      onChange={(event) =>
                        patchCamera({
                          [key]: Math.max(min, Math.min(max, Number(event.target.value) || 0))
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <label>
                焦距
                <input
                  type="number"
                  min="12"
                  max="200"
                  value={shot.camera.focalLengthMm}
                  onChange={(event) =>
                    patchCamera({ focalLengthMm: Number(event.target.value) || 35 })
                  }
                />
              </label>
              <label>
                画幅
                <select
                  value={shot.camera.aspectRatio}
                  onChange={(event) =>
                    patchCamera({
                      aspectRatio: event.target.value as DirectorCamera['aspectRatio']
                    })
                  }
                >
                  <option>16:9</option>
                  <option>9:16</option>
                  <option>4:3</option>
                  <option>3:4</option>
                </select>
              </label>
              <label>
                时长（秒）
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={shot.camera.durationSec}
                  onChange={(event) =>
                    patchCamera({
                      durationSec: Math.max(1, Math.min(10, Number(event.target.value) || 5))
                    })
                  }
                />
              </label>
              <label>
                帧率
                <select
                  value={shot.camera.fps}
                  onChange={(event) =>
                    patchCamera({ fps: Number(event.target.value) as DirectorCamera['fps'] })
                  }
                >
                  <option value="24">24 fps</option>
                  <option value="25">25 fps</option>
                  <option value="30">30 fps</option>
                </select>
              </label>
            </div>
            <div className="director-inspector-group">
              <strong>构图与参考</strong>
              <div className="director-guide-toggles">
                {(
                  [
                    ['thirds', '三分线'],
                    ['safeFrame', '安全框'],
                    ['eyeline', '视线高度']
                  ] as const
                ).map(([key, label]) => (
                  <button
                    className={shot.guides[key] ? 'active' : ''}
                    key={key}
                    onClick={() =>
                      patchShot({ guides: { ...shot.guides, [key]: !shot.guides[key] } })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label>
                参考图透明度
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  disabled={shot.referenceMediaPaths.length === 0}
                  value={shot.referenceOpacity}
                  onChange={(event) => patchShot({ referenceOpacity: Number(event.target.value) })}
                />
              </label>
              <small className="director-reference-hint">
                参考图仅供构图对照，不会写入发布的 PNG 或 WebM。
              </small>
            </div>
            <div className="director-inspector-group">
              <strong>角色 ({shot.actors.length})</strong>
              {shot.actors.map((actor) => (
                <div className="director-actor" key={actor.id}>
                  <div className="director-actor-row">
                    <input
                      value={actor.name}
                      aria-label="角色名称"
                      onChange={(event) =>
                        patchActor(actor.id, { name: event.target.value || '角色' })
                      }
                    />
                    <select
                      value={actor.pose}
                      aria-label={`${actor.name} 姿态`}
                      onChange={(event) =>
                        patchActor(actor.id, { pose: event.target.value as typeof actor.pose })
                      }
                    >
                      <option>站立</option>
                      <option>行走</option>
                      <option>坐姿</option>
                      <option>招手</option>
                      <option>奔跑</option>
                    </select>
                  </div>
                  <div className="director-actor-transform">
                    <label>
                      画布 X
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={actor.x}
                        onChange={(event) =>
                          patchActor(actor.id, {
                            x: Math.max(0, Math.min(100, Number(event.target.value) || 0))
                          })
                        }
                      />
                    </label>
                    <label>
                      画布 Y
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={actor.y}
                        onChange={(event) =>
                          patchActor(actor.id, {
                            y: Math.max(0, Math.min(100, Number(event.target.value) || 0))
                          })
                        }
                      />
                    </label>
                    <label>
                      景深 Z
                      <input
                        type="number"
                        min="-20"
                        max="20"
                        step="0.5"
                        value={actor.z}
                        onChange={(event) =>
                          patchActor(actor.id, {
                            z: Math.max(-20, Math.min(20, Number(event.target.value) || 0))
                          })
                        }
                      />
                    </label>
                    <label>
                      缩放
                      <input
                        type="number"
                        min="0.35"
                        max="2.5"
                        step="0.05"
                        value={actor.scale}
                        onChange={(event) =>
                          patchActor(actor.id, {
                            scale: Math.max(0.35, Math.min(2.5, Number(event.target.value) || 1))
                          })
                        }
                      />
                    </label>
                    <label>
                      颜色
                      <input
                        type="color"
                        value={actor.color}
                        onChange={(event) => patchActor(actor.id, { color: event.target.value })}
                      />
                    </label>
                    <button
                      className="director-remove-actor"
                      onClick={() => removeActor(actor.id)}
                      title="移除角色"
                    >
                      移除
                    </button>
                  </div>
                  <button
                    className="director-record-keyframe"
                    onClick={() =>
                      patchShot({
                        timeline: recordDirectorActorKeyframe(shot, actor.id, timeline).timeline
                      })
                    }
                  >
                    在 {timeline.toFixed(2)} 秒记录角色
                  </button>
                </div>
              ))}
              <button
                className="director-add-actor"
                onClick={() =>
                  patchShot({
                    actors: [
                      ...shot.actors,
                      {
                        id: createDirectorId('actor'),
                        name: `角色 ${String(shot.actors.length + 1).padStart(2, '0')}`,
                        pose: '站立',
                        x: 30 + shot.actors.length * 18,
                        y: 62,
                        z: 0,
                        scale: 1,
                        color: '#c4a7ff'
                      }
                    ]
                  })
                }
              >
                <Icon name="add" size={13} /> 添加角色
              </button>
            </div>
          </aside>
        </div>
        <footer className="director-timeline">
          <button
            onClick={() => {
              if (isPlaying) {
                setIsPlaying(false)
                return
              }
              const startTime = timeline >= shot.camera.durationSec ? 0 : timeline
              if (startTime === 0) setTimeline(0)
              playbackStartedAtRef.current = performance.now() - startTime * 1000
              setIsPlaying(true)
            }}
            title={isPlaying ? '暂停预演' : '播放预演'}
          >
            <Icon name="play" size={14} />
          </button>
          <span>00:{timeline.toFixed(2).padStart(5, '0')}</span>
          <input
            type="range"
            min="0"
            max={shot.camera.durationSec}
            step="0.01"
            value={timeline}
            onChange={(event) => {
              setIsPlaying(false)
              setTimeline(Number(event.target.value))
            }}
          />
          <span>00:{String(shot.camera.durationSec).padStart(2, '0')}</span>
          <div className="director-keyframes">
            <span>CAM · {shot.timeline.camera.length} 个关键帧</span>
            <span>
              {shot.actors.length} 个角色 · {viewportMode === '3d' ? '3D 白模预演' : '2D 构图预演'}
            </span>
            <span>
              {Object.values(shot.timeline.actors).reduce(
                (count, frames) => count + frames.length,
                0
              )}{' '}
              个角色关键帧
            </span>
          </div>
        </footer>
      </section>
    </div>
  )
}
