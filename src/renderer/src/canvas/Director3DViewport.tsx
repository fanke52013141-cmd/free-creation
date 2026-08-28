// P6：真实 WebGL 白模视口与导演机位导出。它只消费导演台的稳定配置数据，不建立 iframe 或隐藏状态。
/* eslint-disable react/no-unknown-property -- 下列属性属于 Three Fiber 的渲染器原语，不会传递给 DOM。 */
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Camera, Scene, WebGLRenderer, WebGLRenderTarget } from 'three'
import {
  directorCameraFov,
  directorCameraTarget,
  evaluateDirectorShot,
  type DirectorCamera,
  type DirectorShot
} from '../nodes/director-data'

interface RenderContext {
  gl: WebGLRenderer
  camera: Camera
  scene: Scene
}

export interface Director3DViewportHandle {
  /** 强制使用已配置的导演机位，导出与 out-camera 语义一致的预演静帧。 */
  captureDirectorFrame: () => Promise<Blob>
  recordDirectorVideo: (
    sourceShot: DirectorShot,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ) => Promise<Blob>
}

function previewFrameSize(camera: DirectorCamera): { width: number; height: number } {
  if (camera.aspectRatio === '9:16') return { width: 720, height: 1280 }
  if (camera.aspectRatio === '4:3') return { width: 960, height: 720 }
  if (camera.aspectRatio === '3:4') return { width: 720, height: 960 }
  return { width: 1280, height: 720 }
}

function applyDirectorCamera(activeCamera: Camera, camera: DirectorCamera): void {
  const projectionCamera = activeCamera as Camera & {
    fov?: number
    updateProjectionMatrix: () => void
  }
  projectionCamera.position.set(camera.x, camera.y, camera.z)
  if ('fov' in projectionCamera) projectionCamera.fov = directorCameraFov(camera.focalLengthMm)
  projectionCamera.lookAt(...directorCameraTarget(camera))
  projectionCamera.updateProjectionMatrix()
}

function applyDirectorActors(scene: Scene, shot: DirectorShot): void {
  for (const actor of shot.actors) {
    const group = scene.getObjectByName(actor.id)
    if (!group) continue
    group.position.set((actor.x - 50) / 10, 0, ((actor.z ?? 0) + actor.y - 62) / 10)
    group.scale.setScalar(Math.max(0.35, Math.min(2.5, actor.scale)))
  }
}

function renderDirectorCanvas(
  context: RenderContext,
  shot: DirectorShot,
  canvas = document.createElement('canvas')
): HTMLCanvasElement {
  const { width, height } = previewFrameSize(shot.camera)
  const target = new WebGLRenderTarget(width, height)
  const pixels = new Uint8Array(width * height * 4)
  const previousTarget = context.gl.getRenderTarget()
  canvas.width = width
  canvas.height = height
  applyDirectorCamera(context.camera, shot.camera)
  applyDirectorActors(context.scene, shot)
  try {
    context.gl.setRenderTarget(target)
    context.gl.clear()
    context.gl.render(context.scene, context.camera)
    context.gl.readRenderTargetPixels(target, 0, 0, width, height, pixels)
  } finally {
    context.gl.setRenderTarget(previousTarget)
    target.dispose()
    context.gl.render(context.scene, context.camera)
  }
  const image = canvas.getContext('2d')?.createImageData(width, height)
  if (!image) throw new Error('无法编码 3D 预演帧')
  // WebGL 的像素原点在左下；Canvas PNG 的像素原点在左上。
  for (let row = 0; row < height; row += 1) {
    const source = (height - row - 1) * width * 4
    image.data.set(pixels.subarray(source, source + width * 4), row * width * 4)
  }
  canvas.getContext('2d')?.putImageData(image, 0, 0)
  return canvas
}

async function renderDirectorFrame(context: RenderContext, shot: DirectorShot): Promise<Blob> {
  const canvas = renderDirectorCanvas(context, shot)
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('无法生成 3D 预演帧'))),
      'image/png'
    )
  )
}

function CameraRig({ camera }: { camera: DirectorCamera }): null {
  const activeCamera = useThree((state) => state.camera)
  useEffect(() => {
    applyDirectorCamera(activeCamera, camera)
  }, [activeCamera, camera])
  return null
}

function PrevisActor({ actor }: { actor: DirectorShot['actors'][number] }): React.JSX.Element {
  const x = (actor.x - 50) / 10
  const z = ((actor.z ?? 0) + actor.y - 62) / 10
  const scale = Math.max(0.35, Math.min(2.5, actor.scale))
  return (
    <group position={[x, 0, z]} scale={scale} name={actor.id}>
      <mesh position={[0, 1.68, 0]} castShadow>
        <sphereGeometry args={[0.22, 24, 16]} />
        <meshStandardMaterial color={actor.color} roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.86, 0]} castShadow>
        <boxGeometry args={[0.46, 1.25, 0.3]} />
        <meshStandardMaterial color={actor.color} roughness={0.76} />
      </mesh>
      <mesh position={[0, 0.08, 0]} receiveShadow>
        <cylinderGeometry args={[0.38, 0.46, 0.12, 20]} />
        <meshStandardMaterial color="#253342" roughness={0.92} />
      </mesh>
    </group>
  )
}

function PrevisScene({ shot }: { shot: DirectorShot }): React.JSX.Element {
  return (
    <>
      <color attach="background" args={['#111923']} />
      <fog attach="fog" args={['#111923', 12, 42]} />
      <ambientLight intensity={1.1} />
      <directionalLight castShadow position={[5, 8, 4]} intensity={2.2} />
      <Grid args={[40, 40]} cellColor="#385068" sectionColor="#6d8ea8" fadeDistance={26} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#16212c" roughness={0.96} />
      </mesh>
      {shot.actors.map((actor) => (
        <PrevisActor key={actor.id} actor={actor} />
      ))}
      <CameraRig camera={shot.camera} />
      <OrbitControls target={directorCameraTarget(shot.camera)} makeDefault enableDamping />
    </>
  )
}

export const Director3DViewport = forwardRef<Director3DViewportHandle, { shot: DirectorShot }>(
  function Director3DViewport({ shot }, ref): React.JSX.Element {
    const renderer = useRef<RenderContext | null>(null)
    const [viewportError, setViewportError] = useState<string | null>(null)
    const [ready, setReady] = useState(false)
    const [canvasGeneration, setCanvasGeneration] = useState(0)

    useEffect(() => {
      return () => {
        renderer.current = null
      }
    }, [])
    useImperativeHandle(
      ref,
      () => ({
        captureDirectorFrame: async () => {
          if (!renderer.current) throw new Error('3D 预演尚未就绪，请稍后重试')
          return await renderDirectorFrame(renderer.current, shot)
        },
        recordDirectorVideo: async (sourceShot, onProgress, signal) => {
          if (!renderer.current) throw new Error('3D 预演尚未就绪，请稍后重试')
          if (!('MediaRecorder' in window)) throw new Error('当前环境不支持 WebM 预演导出')
          const { width, height } = previewFrameSize(sourceShot.camera)
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const stream = canvas.captureStream(sourceShot.camera.fps)
          const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : 'video/webm'
          const recorder = new MediaRecorder(stream, { mimeType: mime })
          const chunks: Blob[] = []
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data)
          }
          const stopped = new Promise<void>((resolve, reject) => {
            recorder.onstop = () => resolve()
            recorder.onerror = () => reject(new Error('3D 预演视频编码失败'))
          })
          const totalFrames = Math.max(
            1,
            Math.round(sourceShot.camera.durationSec * sourceShot.camera.fps)
          )
          const track = stream.getVideoTracks()[0] as MediaStreamTrack & {
            requestFrame?: () => void
          }
          recorder.start()
          try {
            for (let index = 0; index < totalFrames; index += 1) {
              if (signal?.aborted) throw new Error('已取消 3D 视频导出')
              renderDirectorCanvas(
                renderer.current,
                evaluateDirectorShot(sourceShot, index / sourceShot.camera.fps),
                canvas
              )
              track.requestFrame?.()
              onProgress((index + 1) / totalFrames)
              await new Promise<void>((resolve) =>
                window.setTimeout(resolve, 1000 / sourceShot.camera.fps)
              )
            }
          } finally {
            if (recorder.state === 'recording') recorder.stop()
            await stopped
            stream.getTracks().forEach((item) => item.stop())
            renderDirectorCanvas(renderer.current, shot)
          }
          if (signal?.aborted) throw new Error('已取消 3D 视频导出')
          return new Blob(chunks, { type: 'video/webm' })
        }
      }),
      [shot]
    )
    return (
      <div className="director-3d-viewport" aria-label="3D 白模预演视口">
        <div className="director-3d-badge">白模预演 · 尚未加载 3D 模型</div>
        {viewportError ? (
          <div className="director-3d-error" role="alert">
            <strong>3D 视口无法启动</strong>
            <span>{viewportError}</span>
            <button
              type="button"
              onClick={() => {
                setViewportError(null)
                setReady(false)
                renderer.current = null
                setCanvasGeneration((value) => value + 1)
              }}
            >
              重试
            </button>
          </div>
        ) : null}
        <Canvas
          key={canvasGeneration}
          shadows
          dpr={[1, 1.5]}
          camera={{ position: [0, 1.6, 5], fov: 50 }}
          fallback={
            <div className="director-3d-error" role="alert">
              <strong>当前环境不支持 WebGL</strong>
              <span>请更新显卡驱动或在 Electron 硬件加速开启后重试。</span>
            </div>
          }
          onCreated={({ gl, camera, scene }) => {
            try {
              if (!gl.getContext()) throw new Error('WebGL 上下文创建失败')
              renderer.current = { gl, camera, scene }
              setReady(true)
            } catch (error) {
              renderer.current = null
              setReady(false)
              setViewportError(error instanceof Error ? error.message : '未知 WebGL 错误')
            }
          }}
        >
          <PrevisScene shot={shot} />
        </Canvas>
        {!ready && !viewportError ? (
          <span className="director-3d-loading">正在启动 3D 视口…</span>
        ) : null}
        <span className="director-3d-hint">拖拽查看 · 滚轮缩放 · 发布时回到右侧设定的导演机位</span>
      </div>
    )
  }
)
