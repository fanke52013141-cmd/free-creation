// 3D 预演视口。编辑摄像机与拍摄摄像机严格分离：OrbitControls 只控制前者，
// 导出/发布始终使用由导演工程保存的后者，避免“看场景时误改镜头”。
/* eslint-disable react/no-unknown-property -- Three Fiber renderer primitives. */
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls, TransformControls } from '@react-three/drei'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  Camera,
  Group,
  PerspectiveCamera,
  ShaderMaterial,
  Scene,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget
} from 'three'
import {
  directorCameraFov,
  directorCameraTarget,
  evaluateDirectorShot,
  type DirectorCamera,
  type DirectorSpace,
  type DirectorShot
} from '../nodes/director-data'
import { mediaUrl } from '../nodes/registry'

interface RenderContext {
  gl: WebGLRenderer
  /** The persistent shot camera, never controlled by OrbitControls. */
  camera: PerspectiveCamera
  /** The free editor camera created by Canvas. */
  editorCamera: Camera
  scene: Scene
}

export interface Director3DViewportHandle {
  captureDirectorFrame: () => Promise<Blob>
  recordDirectorVideo: (
    sourceShot: DirectorShot,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ) => Promise<Blob>
  recordDirectorSequence: (
    segments: Array<{ shot: DirectorShot; durationSec: number }>,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ) => Promise<Blob>
  /** Converts the current free viewport angle into a director camera patch. */
  captureEditorView: () => Pick<DirectorCamera, 'x' | 'y' | 'z' | 'heading' | 'pitch'>
}

interface Director3DViewportProps {
  shot: DirectorShot
  space: DirectorSpace
  selectedActorId: string | null
  transformMode: 'translate' | 'rotate'
  onSelectActor: (actorId: string | null) => void
  onCommitActorTransform: (
    actorId: string,
    patch: { x: number; y: number; heading: number }
  ) => void
}

function previewFrameSize(camera: DirectorCamera): { width: number; height: number } {
  if (camera.aspectRatio === '9:16') return { width: 720, height: 1280 }
  if (camera.aspectRatio === '4:3') return { width: 960, height: 720 }
  if (camera.aspectRatio === '3:4') return { width: 720, height: 960 }
  return { width: 1280, height: 720 }
}

function applyDirectorCamera(activeCamera: PerspectiveCamera, camera: DirectorCamera): void {
  const { width, height } = previewFrameSize(camera)
  activeCamera.aspect = width / height
  activeCamera.position.set(camera.x, camera.y, camera.z)
  activeCamera.fov = directorCameraFov(camera.focalLengthMm)
  activeCamera.lookAt(...directorCameraTarget(camera))
  activeCamera.updateProjectionMatrix()
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
    context.gl.render(context.scene, context.editorCamera)
  }
  const image = canvas.getContext('2d')?.createImageData(width, height)
  if (!image) throw new Error('无法编码 3D 预演帧')
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

function PrevisActor({
  actor,
  selected,
  transformMode,
  onSelect,
  onCommitTransform
}: {
  actor: DirectorShot['actors'][number]
  selected: boolean
  transformMode: Director3DViewportProps['transformMode']
  onSelect: () => void
  onCommitTransform: (patch: { x: number; y: number; heading: number }) => void
}): React.JSX.Element {
  const groupRef = useRef<Group>(null)
  const x = (actor.x - 50) / 10
  const z = ((actor.z ?? 0) + actor.y - 62) / 10
  const scale = Math.max(0.35, Math.min(2.5, actor.scale))
  const body = (
    <group
      ref={groupRef}
      position={[x, 0, z]}
      rotation-y={((actor.heading ?? 0) * Math.PI) / 180}
      scale={scale}
      name={actor.id}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
    >
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
  if (!selected) return body
  return (
    <TransformControls
      mode={transformMode}
      showY={transformMode === 'translate' ? false : true}
      onMouseUp={() => {
        const position = groupRef.current?.position
        if (!position) return
        onCommitTransform({
          x: position.x * 10 + 50,
          y: position.z * 10 + 62 - actor.z,
          heading: (groupRef.current?.rotation.y ?? 0) * (180 / Math.PI)
        })
      }}
    >
      {body}
    </TransformControls>
  )
}

function WhiteboxPrimitive({
  primitive
}: {
  primitive: DirectorSpace['primitives'][number]
}): React.JSX.Element {
  return (
    <mesh position={[primitive.x, primitive.y, primitive.z]} receiveShadow castShadow>
      <boxGeometry args={[primitive.width, primitive.height, primitive.depth]} />
      <meshStandardMaterial
        color={primitive.kind === 'wall' ? '#314a5c' : '#466278'}
        roughness={0.9}
      />
    </mesh>
  )
}

const imageDepthVertexShader = `
  uniform sampler2D uTexture;
  uniform vec2 uParallax;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 color = texture2D(uTexture, uv).rgb;
    float depth = dot(color, vec3(0.299, 0.587, 0.114));
    vec3 displaced = position;
    displaced.xy += uParallax * (depth - 0.5) * 1.6;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`

const imageDepthFragmentShader = `
  uniform sampler2D uTexture;
  varying vec2 vUv;

  void main() {
    gl_FragColor = texture2D(uTexture, vUv);
  }
`

/**
 * A low-cost 2.5D backdrop. The source image is sampled in the vertex shader and its luminance
 * becomes an approximate depth field. This is intentionally a replaceable presentation layer,
 * not a claim of metric depth reconstruction.
 */
function ImageDepthBackdrop({
  path,
  strength
}: {
  path: string
  strength: number
}): React.JSX.Element | null {
  const [texture, setTexture] = useState<Texture | null>(null)
  const textureRef = useRef<Texture | null>(null)
  const materialRef = useRef<ShaderMaterial>(null)
  const camera = useThree((state) => state.camera)
  const baseline = useRef({ x: camera.position.x, y: camera.position.y })

  useEffect(() => {
    let disposed = false
    const loader = new TextureLoader()
    loader.load(
      mediaUrl(path),
      (loaded) => {
        if (disposed) {
          loaded.dispose()
          return
        }
        loaded.colorSpace = SRGBColorSpace
        loaded.needsUpdate = true
        baseline.current = { x: camera.position.x, y: camera.position.y }
        textureRef.current = loaded
        setTexture(loaded)
      },
      undefined,
      () => {
        if (!disposed) setTexture(null)
      }
    )
    return () => {
      disposed = true
      textureRef.current?.dispose()
      textureRef.current = null
    }
  }, [camera, path])

  useFrame(() => {
    const uniforms = materialRef.current?.uniforms
    if (!uniforms?.uParallax) return
    const maxStrength = Math.max(0, Math.min(1, strength))
    uniforms.uParallax.value.set(
      (camera.position.x - baseline.current.x) * maxStrength * 0.035,
      (camera.position.y - baseline.current.y) * maxStrength * 0.02
    )
  })

  if (!texture) return null
  return (
    <mesh position={[0, 3.2, -8.5]} renderOrder={-1}>
      <planeGeometry args={[18, 10, 64, 36]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={{
          uTexture: { value: texture },
          uParallax: { value: new Vector2() }
        }}
        vertexShader={imageDepthVertexShader}
        fragmentShader={imageDepthFragmentShader}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
    </mesh>
  )
}

function PrevisScene({
  shot,
  space,
  selectedActorId,
  transformMode,
  onSelectActor,
  onCommitActorTransform
}: Director3DViewportProps): React.JSX.Element {
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null)
  const editorCamera = useThree((state) => state.camera)
  useEffect(() => {
    controlsRef.current?.target.set(0, 1, 0)
    controlsRef.current?.update()
  }, [editorCamera])
  return (
    <>
      <color attach="background" args={['#111923']} />
      <fog attach="fog" args={['#111923', 12, 42]} />
      <ambientLight intensity={1.1} />
      <directionalLight castShadow position={[5, 8, 4]} intensity={2.2} />
      {space.mode === 'image-depth' && space.backgroundMediaPath ? (
        <ImageDepthBackdrop
          key={space.backgroundMediaPath}
          path={space.backgroundMediaPath}
          strength={space.parallaxStrength ?? 0.28}
        />
      ) : null}
      <Grid args={[40, 40]} cellColor="#385068" sectionColor="#6d8ea8" fadeDistance={26} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow onClick={() => onSelectActor(null)}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#16212c" roughness={0.96} />
      </mesh>
      {space.primitives.map((primitive) => (
        <WhiteboxPrimitive primitive={primitive} key={primitive.id} />
      ))}
      {shot.actors.map((actor) => (
        <PrevisActor
          key={actor.id}
          actor={actor}
          selected={actor.id === selectedActorId}
          transformMode={transformMode}
          onSelect={() => onSelectActor(actor.id)}
          onCommitTransform={(patch) => onCommitActorTransform(actor.id, patch)}
        />
      ))}
      <OrbitControls ref={controlsRef} makeDefault enableDamping />
    </>
  )
}

function editorViewAsDirectorCamera(
  editorCamera: Camera
): Pick<DirectorCamera, 'x' | 'y' | 'z' | 'heading' | 'pitch'> {
  const direction = new Vector3()
  editorCamera.getWorldDirection(direction)
  return {
    x: editorCamera.position.x,
    y: editorCamera.position.y,
    z: editorCamera.position.z,
    heading: (Math.atan2(direction.x, -direction.z) * 180) / Math.PI,
    pitch: (Math.asin(Math.max(-1, Math.min(1, direction.y))) * 180) / Math.PI
  }
}

export const Director3DViewport = forwardRef<Director3DViewportHandle, Director3DViewportProps>(
  function Director3DViewport(props, ref): React.JSX.Element {
    const renderer = useRef<RenderContext | null>(null)
    const [viewportError, setViewportError] = useState<string | null>(null)
    const [ready, setReady] = useState(false)
    const [canvasGeneration, setCanvasGeneration] = useState(0)

    useEffect(
      () => () => {
        renderer.current?.camera.removeFromParent()
        renderer.current = null
      },
      []
    )

    useImperativeHandle(
      ref,
      () => ({
        captureDirectorFrame: async () => {
          if (!renderer.current) throw new Error('3D 预演尚未就绪，请稍后重试')
          return await renderDirectorFrame(renderer.current, props.shot)
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
          }
          if (signal?.aborted) throw new Error('已取消 3D 视频导出')
          return new Blob(chunks, { type: mime })
        },
        recordDirectorSequence: async (segments, onProgress, signal) => {
          if (!renderer.current) throw new Error('3D 预演尚未就绪，请稍后重试')
          if (!segments.length) throw new Error('镜头序列为空，无法导出')
          if (!('MediaRecorder' in window)) throw new Error('当前环境不支持 WebM 预演导出')
          const fps = segments[0]!.shot.camera.fps
          const { width, height } = previewFrameSize(segments[0]!.shot.camera)
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const stream = canvas.captureStream(fps)
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
            recorder.onerror = () => reject(new Error('3D 预演序列编码失败'))
          })
          const totalFrames = Math.max(
            1,
            segments.reduce(
              (total, segment) => total + Math.max(1, Math.round(segment.durationSec * fps)),
              0
            )
          )
          const track = stream.getVideoTracks()[0] as MediaStreamTrack & {
            requestFrame?: () => void
          }
          let rendered = 0
          recorder.start()
          try {
            for (const segment of segments) {
              const segmentFrames = Math.max(1, Math.round(segment.durationSec * fps))
              for (let index = 0; index < segmentFrames; index += 1) {
                if (signal?.aborted) throw new Error('已取消 3D 序列导出')
                renderDirectorCanvas(
                  renderer.current,
                  evaluateDirectorShot(segment.shot, index / fps),
                  canvas
                )
                track.requestFrame?.()
                rendered += 1
                onProgress(rendered / totalFrames)
                await new Promise<void>((resolve) => window.setTimeout(resolve, 1000 / fps))
              }
            }
          } finally {
            if (recorder.state === 'recording') recorder.stop()
            await stopped
            stream.getTracks().forEach((item) => item.stop())
          }
          if (signal?.aborted) throw new Error('已取消 3D 序列导出')
          return new Blob(chunks, { type: mime })
        },
        captureEditorView: () => {
          if (!renderer.current) throw new Error('3D 预演尚未就绪，请稍后重试')
          return editorViewAsDirectorCamera(renderer.current.editorCamera)
        }
      }),
      [props.shot]
    )

    return (
      <div className="director-3d-viewport" aria-label="3D 白模预演视口">
        <div className="director-3d-badge">
          {props.space.mode === 'image-depth'
            ? '图片视差空间 · 本地近似深度'
            : props.space.status === 'ready'
              ? '白模空间已就绪'
              : '白模预演 · 可直接布置人物'}
        </div>
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
          camera={{ position: [8, 6, 10], fov: 50 }}
          fallback={
            <div className="director-3d-error" role="alert">
              <strong>当前环境不支持 WebGL</strong>
              <span>请更新显卡驱动或在 Electron 硬件加速开启后重试。</span>
            </div>
          }
          onCreated={({ gl, camera, scene }) => {
            try {
              if (!gl.getContext()) throw new Error('WebGL 上下文创建失败')
              const shotCamera = new PerspectiveCamera(50, 16 / 9, 0.1, 200)
              shotCamera.name = 'director-shot-camera'
              scene.add(shotCamera)
              applyDirectorCamera(shotCamera, props.shot.camera)
              renderer.current = { gl, camera: shotCamera, editorCamera: camera, scene }
              setReady(true)
            } catch (error) {
              renderer.current = null
              setReady(false)
              setViewportError(error instanceof Error ? error.message : '未知 WebGL 错误')
            }
          }}
        >
          <PrevisScene {...props} />
        </Canvas>
        {!ready && !viewportError ? (
          <span className="director-3d-loading">正在启动 3D 视口…</span>
        ) : null}
        <span className="director-3d-hint">
          拖拽查看 · 点击人物后拖动坐标轴移动 · 发布始终使用导演机位
        </span>
      </div>
    )
  }
)
