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
  createDirectorShot,
  parseDirectorProject,
  parseDirectorPublishRecord,
  type DirectorCamera,
  type DirectorProjectData,
  type DirectorPublishRecord,
  type DirectorShot
} from '../nodes/director-data'
import type { NodeCardShape } from './NodeCardShape'
import { toast } from '../stores/toast'

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
  // 三分构图参考线（仅预演输出，不代表真实三维模型）。
  ctx.setLineDash([8, 8])
  ctx.strokeStyle = 'rgba(245,158,11,.26)'
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
      drawShotFrame(canvas, shot, Math.min(1, elapsed / durationMs))
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
  const initial = shape?.type === 'node-card' ? parseDirectorProject(shape.props.text) : null
  const [project, setProject] = useState<DirectorProjectData | null>(initial)
  const [timeline, setTimeline] = useState(0)
  const [publishing, setPublishing] = useState<'frame' | 'video' | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shot = useMemo(() => (project ? activeShot(project) : null), [project])
  useEffect(() => {
    if (shot && previewRef.current) drawShotFrame(previewRef.current, shot, timeline)
  }, [shot, timeline])

  if (!shape || shape.type !== 'node-card' || !project || !shot) return null

  const save = (next: DirectorProjectData): void => {
    setProject(next)
    editor.updateShape({ id: shapeId, type: 'node-card', props: { text: JSON.stringify(next) } })
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

  const syncInputs = (): void => {
    const story = gatherUpstreamJson(editor, shapeId, 'in-storyboard') as { shots?: unknown } | null
    const references = gatherUpstreamMediaList(editor, shapeId, 'in-reference-images', 'image')
    const preset = gatherUpstreamJson(
      editor,
      shapeId,
      'in-camera-preset'
    ) as Partial<DirectorCamera> | null
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

  const writePublish = (patch: Pick<DirectorPublishRecord, 'frame' | 'video'>): void => {
    let previous: DirectorPublishRecord | null = null
    try {
      previous = parseDirectorPublishRecord(
        typeof shape.meta?.nodeResult === 'string' ? JSON.parse(shape.meta.nodeResult) : null
      )
    } catch {
      // 新发布结果覆盖损坏记录。
    }
    const result: DirectorPublishRecord = {
      kind: 'director-publish',
      version: 1,
      publishedAt: Date.now(),
      shotId: shot.id,
      ...(previous?.frame ? { frame: previous.frame } : {}),
      ...(previous?.video ? { video: previous.video } : {}),
      ...patch,
      camera: shot.camera
    }
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
      const canvas = document.createElement('canvas')
      drawShotFrame(canvas, shot, timeline)
      const blob = await canvasBlob(canvas, 'image/png')
      const result = await getMediaBridge().importMediaBuffer({
        projectId,
        mime: 'image/png',
        name: `${shot.name}-预演帧`,
        data: new Uint8Array(await blob.arrayBuffer())
      })
      if (!result.ok) throw new Error(result.error.message)
      writePublish({
        frame: { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime }
      })
      toast('预演帧已发布，可连接给下游节点')
    } catch (error) {
      toast(`发布失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setPublishing(null)
    }
  }

  const publishVideo = async (): Promise<void> => {
    setPublishing('video')
    try {
      const blob = await recordShotPreview(shot)
      const result = await getMediaBridge().importMediaBuffer({
        projectId,
        mime: 'video/webm',
        name: `${shot.name}-预演`,
        data: new Uint8Array(await blob.arrayBuffer())
      })
      if (!result.ok) throw new Error(result.error.message)
      writePublish({
        video: { mediaId: result.data.id, mediaPath: result.data.path, mime: result.data.mime }
      })
      toast('预演视频已发布，可连接给下游视频节点')
    } catch (error) {
      toast(`视频导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setPublishing(null)
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

  return (
    <div className="director-studio-mask" role="dialog" aria-modal="true" aria-label="导演台">
      <section className="director-studio">
        <header className="director-topbar">
          <div className="director-brand">
            <Icon name="director" size={18} /> 导演台 <small>PREVIS</small>
          </div>
          <div className="director-project-title">
            {shape.props.title} · {shot.name}
          </div>
          <div className="director-top-actions">
            <button onClick={syncInputs}>
              <Icon name="reset" size={14} /> 同步连线输入
            </button>
            <button onClick={() => void publishFrame()} disabled={publishing !== null}>
              <Icon name="image" size={14} /> {publishing === 'frame' ? '发布中…' : '发布帧'}
            </button>
            <button onClick={() => void publishVideo()} disabled={publishing !== null}>
              <Icon name="video" size={14} /> {publishing === 'video' ? '导出中…' : '导出 WebM'}
            </button>
            <button className="director-close" onClick={onClose} title="关闭导演台">
              <Icon name="close" size={17} />
            </button>
          </div>
        </header>
        <div className="director-main">
          <aside className="director-left-panel">
            <div className="director-panel-head">
              <strong>镜头</strong>
              <button onClick={addShot} title="新增镜头">
                <Icon name="add" size={15} />
              </button>
            </div>
            <div className="director-shot-list">
              {project.shots.map((item, index) => (
                <button
                  key={item.id}
                  className={`director-shot-card ${item.id === shot.id ? 'active' : ''}`}
                  onClick={() => save({ ...project, activeShotId: item.id })}
                >
                  <span className="director-shot-thumb">{String(index + 1).padStart(2, '0')}</span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.camera.durationSec}s · {item.camera.aspectRatio}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <div className="director-resource-note">
              <Icon name="attach" size={13} /> {shot.referenceMediaIds.length} 张真实连线参考图
            </div>
          </aside>
          <main className="director-viewport">
            <div className="director-viewport-tools">
              <span>透视预演</span>
              <span>W 移动 · E 旋转 · R 缩放</span>
            </div>
            <div
              className={`director-camera-monitor aspect-${shot.camera.aspectRatio.replace(':', '-')}`}
            >
              <canvas ref={previewRef} />
              <div className="director-monitor-label">
                CAM 01 · {shot.camera.focalLengthMm}mm · {shot.camera.aspectRatio}
              </div>
            </div>
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
              <strong>角色 ({shot.actors.length})</strong>
              {shot.actors.map((actor) => (
                <div className="director-actor-row" key={actor.id}>
                  <input
                    value={actor.name}
                    aria-label="角色名称"
                    onChange={(event) =>
                      patchShot({
                        actors: shot.actors.map((item) =>
                          item.id === actor.id
                            ? { ...item, name: event.target.value || '角色' }
                            : item
                        )
                      })
                    }
                  />
                  <select
                    value={actor.pose}
                    onChange={(event) =>
                      patchShot({
                        actors: shot.actors.map((item) =>
                          item.id === actor.id
                            ? { ...item, pose: event.target.value as typeof actor.pose }
                            : item
                        )
                      })
                    }
                  >
                    <option>站立</option>
                    <option>行走</option>
                    <option>坐姿</option>
                    <option>招手</option>
                    <option>奔跑</option>
                  </select>
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
          <button onClick={() => setTimeline((value) => (value > 0 ? 0 : 0.01))}>
            <Icon name="play" size={14} />
          </button>
          <span>00:00</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={timeline}
            onChange={(event) => setTimeline(Number(event.target.value))}
          />
          <span>00:{String(shot.camera.durationSec).padStart(2, '0')}</span>
          <div className="director-keyframes">
            <span>CAM</span>
            <i style={{ left: '18%' }} />
            <i style={{ left: '72%' }} />
            <span>{shot.actors.length} 个角色轨道 · 发布后输出真实资产</span>
          </div>
        </footer>
      </section>
    </div>
  )
}
