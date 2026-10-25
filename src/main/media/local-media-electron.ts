// P1-A 本地媒体一致性与运行中停止的隔离桌面验收入口；从不被应用代码引用。
// 场景：真实导入 → 裁剪/拆图/截取的单节点、选区闭包与全图一致性 →
// 运行中停止（主进程真终止 + 迟到资产清理）→ 保存重开核对 → 明确重试。
// renderer 侧场景通过函数源码注入真实页面执行；/src/* 模块只存在于
// vite 渲染器，因此统一用变量路径动态导入，主进程构建不做解析。
import { app, BrowserWindow, protocol } from 'electron'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createProject } from '../store/projects.repo'
import { importMedia, getMediaAbsPath, listMedia } from '../store/media.repo'
import { closeDb, setSetting } from '../store/db'
import { initDiagnosticsService } from '../diagnostics/service'
import { setGatewayEventSink } from '../diagnostics/gateway-events'
import { registerProjectIpc } from '../ipc/project.ipc'
import { registerMediaIpc } from '../ipc/media.ipc'
import { registerWorkspaceStateIpc } from '../ipc/workspace-state.ipc'
import { registerGatewayIpc } from '../ipc/gateway.ipc'
import { registerFlowAssetsIpc } from '../ipc/flow-assets.ipc'
import { registerFlowCommandsIpc } from '../ipc/flow-commands.ipc'
import { registerFlowAgentsIpc } from '../ipc/flow-agents.ipc'
import { registerModelIpc } from '../ipc/models.ipc'
import { registerDiagnosticsIpc, setDiagnosticsService } from '../ipc/diagnostics.ipc'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { createDesktopModelRuntime } from '../model-host/runtime'
import { getDb } from '../store/db'

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = arg('media-directory')
const phase = arg('media-phase')
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-local-media-') ||
  !['execute', 'reopen'].includes(phase ?? '')
) {
  app.exit(2)
} else {
  process.env.CANVAS_DATA_DIR = directory
  app.setPath('userData', directory)
  app.on('window-all-closed', () => {})
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
  void app.whenReady().then(async () => {
    let window: BrowserWindow | undefined
    let failed = false
    let stage = 'setup'
    let diagnostics: Awaited<ReturnType<typeof initDiagnosticsService>> | null = null
    try {
      diagnostics = await initDiagnosticsService({ dataDir: directory, disableTimers: true })
      setGatewayEventSink(diagnostics)
      setDiagnosticsService(diagnostics)
      const statePath = join(directory, 'media-state.json')
      stage = 'setup-project'
      const projectId =
        phase === 'execute'
          ? createProject('测试：本地媒体一致性与停止').id
          : String(JSON.parse(readFileSync(statePath, 'utf8')).projectId)
      setSetting('lastProjectId', projectId)
      stage = 'setup-ipc'
      registerProjectIpc()
      registerMediaIpc()
      registerWorkspaceStateIpc()
      registerDiagnosticsIpc()
      stage = 'setup-window'
      window = new BrowserWindow({
        show: false,
        width: 1900,
        height: 1050,
        webPreferences: {
          preload: resolve(__dirname, '../preload/index.js'),
          contextIsolation: true,
          sandbox: false,
          backgroundThrottling: false,
          nodeIntegration: false
        }
      })
      const active = window
      const host = new SqliteModelHost(getDb())
      registerModelIpc(host, createDesktopModelRuntime(host))
      registerGatewayIpc(active)
      registerFlowAssetsIpc(() => active)
      registerFlowCommandsIpc(
        () => active,
        (desktop) => {
          // 验收不启动 Agent Flow；注册以满足画布挂载时的 attach 调用。
          registerFlowAgentsIpc(() => active, desktop)
        }
      )
      stage = 'setup-load'
      await window.loadURL(process.env.CANVAS_MEDIA_RENDERER_URL || 'http://127.0.0.1:5199')
      stage = 'setup-canvas'
      const deadline = Date.now() + 60000
      while (
        !(await window.webContents.executeJavaScript(
          "import('/src/stores/editor.ts').then(m=>!!m.useEditorStore.getState().editor)"
        ))
      ) {
        if (Date.now() > deadline) throw new Error('MEDIA_CANVAS_TIMEOUT')
        await new Promise((done) => setTimeout(done, 100))
      }
      stage = phase ?? 'execute'
      if (phase === 'execute') {
        stage = 'import-media'
        const pngPath = join(directory, 'acceptance-source.png')
        const mp4Path = join(directory, 'acceptance-long.mp4')
        if (!existsSync(pngPath) || !existsSync(mp4Path)) throw new Error('MEDIA_FIXTURE_MISSING')
        const importedImage = await importMedia(projectId, pngPath)
        const importedVideo = await importMedia(projectId, mp4Path)
        if (!importedImage.ok || !importedVideo.ok) {
          const reasons = [importedImage, importedVideo]
            .map((outcome) => (outcome.ok ? '' : outcome.reason))
            .join('/')
          throw new Error(`MEDIA_IMPORT_INCOMPLETE:${reasons}`)
        }
        const image = importedImage.asset
        const video = importedVideo.asset
        const sourceHash = createHash('sha256')
          .update(readFileSync(getMediaAbsPath(image.path) ?? pngPath))
          .digest('hex')
        stage = 'execute-scenario'
        const report = (await window.webContents.executeJavaScript(
          `(${mediaScenario.toString()})(${JSON.stringify({
            projectId,
            imageMediaId: image.id,
            imageMediaPath: image.path,
            imageMime: image.mime,
            videoMediaId: video.id,
            videoMediaPath: video.path,
            videoMime: video.mime
          })})`
        )) as ExecuteScenarioReport
        stage = 'verify-results'
        const cropPng = report.cropResults.at(-1)
        if (!cropPng?.mediaPath) throw new Error('MEDIA_CROP_RESULT_MISSING')
        const cropPath = getMediaAbsPath(cropPng.mediaPath)
        if (!cropPath || !existsSync(cropPath)) throw new Error('MEDIA_CROP_FILE_MISSING')
        const cropSize = pngSize(readFileSync(cropPath))
        const expectedWidth = Math.floor(6000 * 0.5)
        const expectedHeight = Math.floor(4000 * 0.5)
        if (cropSize.width !== expectedWidth || cropSize.height !== expectedHeight) {
          throw new Error(
            `MEDIA_CROP_SIZE_MISMATCH:${cropSize.width}x${cropSize.height}!=${expectedWidth}x${expectedHeight}`
          )
        }
        if (
          createHash('sha256')
            .update(readFileSync(getMediaAbsPath(image.path) ?? pngPath))
            .digest('hex') !== sourceHash
        ) {
          throw new Error('MEDIA_SOURCE_OVERWRITTEN')
        }
        const mediaCount = listMedia(projectId).length
        writeFileSync(
          statePath,
          JSON.stringify(
            {
              projectId,
              sourceHash,
              sourceAssetId: image.id,
              pinnedMediaId: report.pinnedMediaId,
              cropResultCount: report.cropResultCount,
              splitResultCount: report.splitResultCount,
              audioResultCount: report.audioResultCount,
              vocalResultCount: report.vocalResultCount,
              mediaCountAfterExecute: mediaCount
            },
            null,
            2
          )
        )
        writeFileSync(
          join(directory, 'media-execute-report.json'),
          JSON.stringify({ status: 'pass', ...report, mediaCount }, null, 2)
        )
      } else {
        stage = 'reopen-scenario'
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as MediaState
        const report = (await window.webContents.executeJavaScript(
          `(${mediaReopenScenario.toString()})(${JSON.stringify(state)})`
        )) as Record<string, unknown>
        const mediaCount = listMedia(projectId).length
        if (mediaCount !== state.mediaCountAfterExecute + 1) {
          throw new Error(
            `MEDIA_REOPEN_COUNT_CHANGED:${mediaCount}!=${state.mediaCountAfterExecute + 1}`
          )
        }
        writeFileSync(
          join(directory, 'media-reopen-report.json'),
          JSON.stringify({ status: 'pass', ...report, mediaCount }, null, 2)
        )
      }
    } catch (error) {
      failed = true
      writeFileSync(
        join(directory, `media-${phase ?? 'unknown'}-report.json`),
        JSON.stringify(
          { status: 'fail', stage, error: error instanceof Error ? error.message : String(error) },
          null,
          2
        )
      )
    } finally {
      // 渲染器事件批量上报 + 服务缓冲：退出前显式排空，保证诊断证据完整落盘。
      try {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
          await window.webContents.executeJavaScript(`(async()=>{
            const diagnostics=await import('/src/engine/diagnosticsReporter.ts');
            await diagnostics.drainDiagnosticsEvents();
            if(diagnostics.pendingDiagnosticsEventCount()||diagnostics.diagnosticsTransportDropCount())throw new Error('MEDIA_DIAGNOSTICS_FLUSH_FAILED');
          })()`)
        }
        await diagnostics?.flushNow()
      } catch (flushError) {
        if (!failed) {
          failed = true
          writeFileSync(
            join(directory, `media-${phase ?? 'unknown'}-report.json`),
            JSON.stringify(
              {
                status: 'fail',
                stage: 'diagnostics-flush',
                error: flushError instanceof Error ? flushError.message : String(flushError)
              },
              null,
              2
            )
          )
        }
      }
      window?.destroy()
      closeDb()
      app.exit(failed ? 1 : 0)
    }
  })
}

interface ExecuteScenarioReport {
  cropResultCount: number
  splitResultCount: number
  pinnedMediaId: string
  mediaCount: number
  cropResults: Array<{ mediaId: string; mediaPath: string }>
  stopAttempts: Array<{ attempt: number; exec: string; tasks: number; before: number; after: number }>
  clipStopAttempts: Array<{ attempt: number; exec: string; tasks: number; before: number; after: number }>
  audioStopAttempts: Array<{ attempt: number; exec: string; tasks: number; before: number; after: number }>
  audioStopHit: boolean
  audioResultCount: number
  vocalResultCount: number
  qualitySeparator: 'done' | 'stable-failed'
}

interface MediaState {
  projectId: string
  sourceHash: string
  sourceAssetId: string
  pinnedMediaId: string
  cropResultCount: number
  splitResultCount: number
  audioResultCount: number
  vocalResultCount: number
  mediaCountAfterExecute: number
}

/** 读取 PNG IHDR 宽高，用于核对产物尺寸。 */
function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('MEDIA_PNG_HEADER_INVALID')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** renderer 侧场景里加载 vite 渲染器模块；变量路径避免主进程构建解析 /src/*。
 *  场景函数经 toString() 注入页面执行，加载器必须在函数体内部定义。 */

/** 在真实 renderer 画布上执行：构建真实节点/连线，验收一致性、停止与固定结果。 */
async function mediaScenario(args: {
  projectId: string
  imageMediaId: string
  imageMediaPath: string
  imageMime: string
  videoMediaId: string
  videoMediaPath: string
  videoMime: string
}): Promise<ExecuteScenarioReport> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vite 渲染器模块只有运行时形态
  const load = (path: string): Promise<any> => import(/* @vite-ignore */ path)
  const editor = (await load('/src/stores/editor.ts')).useEditorStore.getState().editor
  const engine = await load('/src/engine/executor.ts')
  const graph = await load('/src/canvas/graph.ts')
  const registry = await load('/src/nodes/registry.tsx')
  const nodeValues = await load('/src/nodes/nodeValues.ts')
  const store = (await load('/src/engine/store.ts')).useEngineStore
  const resourceQueue = (await load('/src/engine/resource-queue.ts')).useResourceQueue
  const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

  const createNode = (
    id: string,
    nodeType: string,
    x: number,
    y: number,
    extraProps: Record<string, unknown> = {}
  ): void => {
    editor.createShape({
      id,
      type: 'node-card',
      x,
      y,
      props: { nodeType, title: id.replace('shape:lm-', ''), text: '', ...extraProps }
    })
  }
  const connect = (fromShapeId: string, fromPort: string, toShapeId: string, toPort: string): void => {
    const target = editor.getShape(toShapeId)
    if (!target) throw new Error(`TARGET_SHAPE_MISSING:${toShapeId}`)
    const ports = registry.getNodePorts(registry.getNodeType(target.props.nodeType), target)
    const port = ports.in.find((p: { id: string }) => p.id === toPort)
    if (!port) throw new Error(`PORT_MISSING:${toPort}`)
    const source = editor.getShape(fromShapeId)
    if (!source) throw new Error(`SOURCE_SHAPE_MISSING:${fromShapeId}`)
    const sourceSpec = registry.getNodeType(source.props.nodeType)
    if (!sourceSpec) {
      throw new Error(
        `SOURCE_SPEC_MISSING:${fromShapeId}:nodeType=${String(source.props.nodeType)}:known=${Object.keys(registry.getNodeTypes?.() ?? {}).join(',')}`
      )
    }
    const sourcePorts = registry.getNodePorts(sourceSpec, source)
    const sourcePort = sourcePorts.out.find((p: { id: string }) => p.id === fromPort)
    if (!sourcePort) throw new Error(`SOURCE_PORT_MISSING:${fromShapeId}:${fromPort}`)
    if (!editor.getShapePageBounds(source.id) || !editor.getShapePageBounds(target.id)) {
      throw new Error(`BOUNDS_MISSING:${fromShapeId}->${toShapeId}`)
    }
    if (
      !graph.createEdge(
        editor,
        { shapeId: fromShapeId, portId: fromPort },
        { shapeId: toShapeId, portId: port.id }
      )
    ) {
      throw new Error(`EDGE_FAILED:${fromShapeId}->${toShapeId}`)
    }
  }
  const collection = (
    shapeId: string
  ): { results: Array<{ mediaId: string; mediaPath?: string; mime?: string }> } | null => {
    const raw = editor.getShape(shapeId)?.meta?.nodeResult
    return typeof raw === 'string' ? nodeValues.parseMediaResultCollection(raw) : null
  }
  const outputsOf = (shapeId: string): string[] =>
    Object.keys(nodeValues.projectNodeOutputs(editor.getShape(shapeId)))
  const waitIdle = async (): Promise<void> => {
    for (let i = 0; i < 1200; i++) {
      if (store.getState().phase === 'idle') return
      await delay(100)
    }
    throw new Error('MEDIA_WORKFLOW_TIMEOUT')
  }
  const waitExec = async (shapeId: string, status: string, timeoutMs = 120000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const exec = editor.getShape(shapeId)?.props?.exec
      if (exec === status) return
      if (Date.now() > deadline) throw new Error(`MEDIA_EXEC_TIMEOUT:${shapeId}:${status}`)
      await delay(50)
    }
  }
  const mediaProps = (mediaId: string, mediaPath: string, mime: string): Record<string, string> => ({
    mediaId,
    mediaPath,
    mediaMime: mime
  })

  editor.deleteShapes([...editor.getCurrentPageShapeIds()])
  // ── 一致性图：原图 → 裁剪 / 拆分；裁剪 → 失败代码（部分成功保留）；视频 → 快速截取 ──
  // 先建节点并等待 tldraw 完成一次布局，随后建连线（pagePortPoint 需要已计算的 bounds）。
  createNode('shape:lm-source', 'image', 100, 100, mediaProps(args.imageMediaId, args.imageMediaPath, args.imageMime))
  createNode('shape:lm-crop', 'image-crop', 560, 100, {
    config: JSON.stringify({
      version: 1,
      mode: 'rect',
      aspectRatio: 'free',
      rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
    })
  })
  createNode('shape:lm-split', 'image-split', 560, 460, {
    config: JSON.stringify({ version: 1, rows: 8, columns: 8, scalePercent: 100 })
  })
  createNode('shape:lm-fail', 'processor', 1020, 100, {
    // pick + 图片输入是确定性失败（需要 JSON）；用于验证下游失败不丢上游成果。
    config: JSON.stringify({ operation: 'pick', path: 'nonexistent.field', valueType: 'any', fallback: '' })
  })
  createNode('shape:lm-video-source', 'video-asset', 100, 900, mediaProps(args.videoMediaId, args.videoMediaPath, args.videoMime))
  createNode('shape:lm-clip-fast', 'video-clip', 560, 900, {
    config: JSON.stringify({
      version: 3,
      startMs: 1000,
      endMs: 6000,
      keepVideo: true,
      keepAudio: false,
      includeAudio: true,
      quality: 'fast',
      audioFormat: 'wav',
      audioSampleRate: 44100,
      extractVocals: false,
      vocalMode: 'quality'
    })
  })
  // P1-A 残余：提音 → 快速人声增强链路（真实 ffmpeg）。
  createNode('shape:lm-audio', 'video-audio', 560, 1250, {
    config: JSON.stringify({ version: 2, startMs: 1000, endMs: 21000, format: 'wav', sampleRate: 44100 })
  })
  createNode('shape:lm-vocal', 'vocal-separate', 1020, 1250, {
    config: JSON.stringify({ version: 1, mode: 'fast', outputAccompaniment: false })
  })
  await delay(250)
  connect('shape:lm-source', 'out-image', 'shape:lm-crop', 'in-image')
  connect('shape:lm-source', 'out-image', 'shape:lm-split', 'in-image')
  connect('shape:lm-crop', 'out-image', 'shape:lm-fail', 'in-value')
  connect('shape:lm-video-source', 'out-video', 'shape:lm-clip-fast', 'in-video')
  connect('shape:lm-video-source', 'out-video', 'shape:lm-audio', 'in-video')
  connect('shape:lm-audio', 'out-audio', 'shape:lm-vocal', 'in-audio')

  // ── 一致性 1：单节点手动运行 ──
  const single = await engine.runNodeManually(editor, args.projectId, [], 'shape:lm-crop')
  if (single.status !== 'done') throw new Error(`MEDIA_SINGLE_FAILED:${single.reason}`)
  const afterSingle = collection('shape:lm-crop')
  if (!afterSingle || afterSingle.results.length !== 1) throw new Error('MEDIA_SINGLE_COLLECTION')
  if (!outputsOf('shape:lm-crop').includes('out-image')) throw new Error('MEDIA_SINGLE_PORT_MISSING')

  // ── 一致性 2：选区依赖闭包（重新执行裁剪） ──
  await engine.runWorkflowForNodes(editor, args.projectId, [], ['shape:lm-crop'])
  await waitIdle()
  const afterSelection = collection('shape:lm-crop')
  if (!afterSelection || afterSelection.results.length !== 2) {
    throw new Error('MEDIA_SELECTION_COLLECTION')
  }

  // ── 一致性 3：全图执行（含快速截取；代码节点失败不得丢掉裁剪成果） ──
  await engine.runWorkflow(editor, args.projectId, [])
  await waitIdle()
  const afterFull = collection('shape:lm-crop')
  if (!afterFull || afterFull.results.length !== 3) throw new Error('MEDIA_FULL_COLLECTION')
  const splitAfterFull = collection('shape:lm-split')
  if (!splitAfterFull || splitAfterFull.results.length !== 64) throw new Error('MEDIA_SPLIT_COUNT')
  const clipFast = collection('shape:lm-clip-fast')
  if (!clipFast || clipFast.results.length !== 1) throw new Error('MEDIA_FAST_CLIP_MISSING')
  // 提音与快速人声增强全图执行结果。
  const audioAfterFull = collection('shape:lm-audio')
  if (!audioAfterFull || audioAfterFull.results.length !== 1) throw new Error('MEDIA_AUDIO_MISSING')
  // 人声分离节点写专用 vocal-separation JSON（非媒体结果集合）：校验 vocals 字段。
  const vocalRaw = editor.getShape('shape:lm-vocal')?.meta?.nodeResult
  const vocalParsed =
    typeof vocalRaw === 'string' ? (JSON.parse(vocalRaw) as { vocals?: { mediaId?: string } }) : null
  if (!vocalParsed?.vocals?.mediaId) throw new Error('MEDIA_VOCAL_MISSING')
  if (editor.getShape('shape:lm-vocal')?.meta?.nodeRun?.status !== 'success') {
    throw new Error('MEDIA_VOCAL_NOT_SUCCESS')
  }
  const failRun = editor.getShape('shape:lm-fail')?.meta?.nodeRun
  if (failRun?.status !== 'failed') throw new Error('MEDIA_FAIL_NOT_FAILED')
  const cropExec = editor.getShape('shape:lm-crop')?.props?.exec
  if (cropExec !== 'success') throw new Error(`MEDIA_CROP_MARKED_FAILED:${cropExec}`)

  // ── 运行中停止 1：宫格拆分（8×8 大图，主进程在格子间终止并回滚） ──
  createNode('shape:lm-split-stop', 'image-split', 1020, 460, {
    config: JSON.stringify({ version: 1, rows: 8, columns: 8, scalePercent: 100 })
  })
  await delay(150)
  connect('shape:lm-source', 'out-image', 'shape:lm-split-stop', 'in-image')
  const stopAttempts: ExecuteScenarioReport['stopAttempts'] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = collection('shape:lm-split-stop')?.results.length ?? 0
    const running = engine.runWorkflowForNodes(editor, args.projectId, [], ['shape:lm-split-stop'])
    await waitExec('shape:lm-split-stop', 'running')
    await delay(400)
    store.getState().stop?.()
    await running
    await waitIdle()
    const exec = String(editor.getShape('shape:lm-split-stop')?.props?.exec)
    const tasks = resourceQueue.getState().tasks.length
    const after = collection('shape:lm-split-stop')?.results.length ?? 0
    stopAttempts.push({ attempt, exec, tasks, before, after })
    if (exec === 'cancelled') {
      if (tasks !== 0) throw new Error('MEDIA_STOP_TASKS_LEAKED')
      if (after !== before) throw new Error(`MEDIA_STOP_LATE_RESULTS:${after}`)
      break
    }
    if (attempt === 3) throw new Error('MEDIA_STOP_NOT_OBSERVED_SPLIT:' + JSON.stringify(stopAttempts))
  }

  // ── 运行中停止 2：视频精确重编码截取（终止 ffmpeg 子进程） ──
  createNode('shape:lm-clip-stop', 'video-clip', 1020, 900, {
    config: JSON.stringify({
      version: 3,
      startMs: 1000,
      endMs: 79000,
      keepVideo: true,
      keepAudio: false,
      includeAudio: true,
      quality: 'balanced',
      audioFormat: 'wav',
      audioSampleRate: 44100,
      extractVocals: false,
      vocalMode: 'quality'
    })
  })
  await delay(150)
  connect('shape:lm-video-source', 'out-video', 'shape:lm-clip-stop', 'in-video')
  const clipStopAttempts: ExecuteScenarioReport['clipStopAttempts'] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = collection('shape:lm-clip-stop')?.results.length ?? 0
    const running = engine.runWorkflowForNodes(editor, args.projectId, [], ['shape:lm-clip-stop'])
    await waitExec('shape:lm-clip-stop', 'running')
    await delay(1200)
    store.getState().stop?.()
    await running
    await waitIdle()
    const exec = String(editor.getShape('shape:lm-clip-stop')?.props?.exec)
    const tasks = resourceQueue.getState().tasks.length
    const after = collection('shape:lm-clip-stop')?.results.length ?? 0
    clipStopAttempts.push({ attempt, exec, tasks, before, after })
    if (exec === 'cancelled') {
      if (tasks !== 0) throw new Error('MEDIA_STOP_TASKS_LEAKED')
      if (after !== before) throw new Error(`MEDIA_STOP_LATE_RESULTS:${after}`)
      break
    }
    if (attempt === 3) throw new Error('MEDIA_STOP_NOT_OBSERVED_CLIP:' + JSON.stringify(clipStopAttempts))
  }

  // ── 运行中停止 3：提音（终止 ffmpeg 音频提取子进程） ──
  createNode('shape:lm-audio-stop', 'video-audio', 1020, 1600, {
    config: JSON.stringify({ version: 2, startMs: 1000, endMs: 89000, format: 'wav', sampleRate: 44100 })
  })
  await delay(150)
  connect('shape:lm-video-source', 'out-video', 'shape:lm-audio-stop', 'in-video')
  const audioStopAttempts: ExecuteScenarioReport['audioStopAttempts'] = []
  // 提音是秒级完成的快速 ffmpeg 操作：停止窗口物理上很小。三次尽力停止——
  // 命中 cancelled 则完整验证终止语义；未命中则验证完成语义合法（唯一 success
  // 终态、结果追加、资源释放），ffmpeg 子进程终止通道由 balanced 截取循环验收，
  // 两者共享同一 trackMediaJob 通道。诚实记录结果，不伪造命中。
  let audioStopHit = false
  for (let attempt = 1; attempt <= 3 && !audioStopHit; attempt++) {
    const before = collection('shape:lm-audio-stop')?.results.length ?? 0
    const running = engine.runWorkflowForNodes(editor, args.projectId, [], ['shape:lm-audio-stop'])
    await waitExec('shape:lm-audio-stop', 'running')
    store.getState().stop?.()
    await running
    await waitIdle()
    const exec = String(editor.getShape('shape:lm-audio-stop')?.props?.exec)
    const tasks = resourceQueue.getState().tasks.length
    const after = collection('shape:lm-audio-stop')?.results.length ?? 0
    audioStopAttempts.push({ attempt, exec, tasks, before, after })
    if (tasks !== 0) throw new Error('MEDIA_STOP_TASKS_LEAKED')
    if (exec === 'cancelled') {
      audioStopHit = true
      if (after !== before) throw new Error(`MEDIA_STOP_LATE_RESULTS:${after}`)
    } else if (exec !== 'success') {
      throw new Error(`MEDIA_STOP_AUDIO_UNEXPECTED:${exec}`)
    }
  }

  // ── 高质量人声分离：能力探测分支 ──
  // 本机装了 audio-separator 就真跑一次；没装则断言稳定前置失败（不是异常崩溃）。
  createNode('shape:lm-vocal-quality', 'vocal-separate', 560, 1600, {
    config: JSON.stringify({ version: 1, mode: 'quality', outputAccompaniment: false })
  })
  await delay(150)
  connect('shape:lm-audio', 'out-audio', 'shape:lm-vocal-quality', 'in-audio')
  // 场景运行在渲染器页面里，globalThis 上是 preload 暴露的真实 window.api。
  const rendererApi = (globalThis as unknown as { window?: { api: {
    listMedia(projectId: string): Promise<{ ok: boolean; data: { length: number } }>
    getLocalMediaCapabilities(): Promise<{
      ok: boolean
      data?: { audioSeparator?: { available?: boolean } }
    }>
  } } }).window?.api
  if (!rendererApi) throw new Error('MEDIA_RENDERER_API_MISSING')
  const capabilityReply = await rendererApi.getLocalMediaCapabilities()
  const separatorAvailable =
    capabilityReply.ok && capabilityReply.data?.audioSeparator?.available === true
  const qualityRun = await engine.runNodeManually(
    editor,
    args.projectId,
    [],
    'shape:lm-vocal-quality'
  )
  let qualitySeparator: ExecuteScenarioReport['qualitySeparator'] = 'stable-failed'
  if (separatorAvailable) {
    if (qualityRun.status !== 'done') {
      throw new Error(`MEDIA_QUALITY_VOCAL_FAILED:${qualityRun.reason}`)
    }
    if ((collection('shape:lm-vocal-quality')?.results.length ?? 0) !== 1) {
      throw new Error('MEDIA_QUALITY_VOCAL_NO_RESULT')
    }
    qualitySeparator = 'done'
  } else if (qualityRun.status !== 'failed') {
    throw new Error(`MEDIA_QUALITY_VOCAL_UNEXPECTED:${qualityRun.status}`)
  }

  // ── 固定结果一致性（L2 真实桌面复验）：钉住裁剪历史结果，运行记录置为失败 ──
  const cropShape = editor.getShape('shape:lm-crop')
  const firstCrop = afterFull.results[0]
  if (!firstCrop) throw new Error('MEDIA_PIN_SOURCE_MISSING')
  editor.updateShape({
    id: 'shape:lm-crop',
    type: 'node-card',
    meta: {
      ...cropShape.meta,
      pinnedOutput: JSON.stringify({
        version: 1,
        outputs: {
          'out-image': {
            kind: 'image',
            mediaId: firstCrop.mediaId,
            mediaPath: firstCrop.mediaPath,
            mime: firstCrop.mime
          }
        }
      }),
      nodeRun: { runId: 'forced-failed', status: 'failed', startedAt: 1, inputs: {} }
    }
  })
  const pinnedValue = nodeValues.projectNodeOutputs(editor.getShape('shape:lm-crop'))['out-image']
  if (!pinnedValue || pinnedValue.mediaId !== firstCrop.mediaId) {
    throw new Error('MEDIA_PINNED_NOT_EXPOSED')
  }
  // 失败/取消运行不得静音显式固定结果；解除固定后失败旧候选必须被拒绝（重开段验证）。

  // ── 保存并记录重开基线 ──
  const flowAssetActions = await load('/src/canvas/flow-asset-actions.ts')
  await flowAssetActions.ensureCanvasSaved()
  const mediaList = await rendererApi.listMedia(args.projectId)
  return {
    cropResultCount: afterFull.results.length,
    splitResultCount: splitAfterFull.results.length,
    pinnedMediaId: firstCrop.mediaId,
    mediaCount: mediaList.data.length,
    cropResults: afterFull.results.map((item) => ({
      mediaId: item.mediaId,
      mediaPath: item.mediaPath ?? ''
    })),
    stopAttempts,
    clipStopAttempts,
    audioStopAttempts,
    audioStopHit,
    audioResultCount: audioAfterFull.results.length,
    vocalResultCount: 1,
    qualitySeparator
  }
}

/** 重开验收：持久化内容、固定结果、错误阶段、无自动生成与明确重试。 */
async function mediaReopenScenario(state: {
  projectId: string
  sourceAssetId: string
  pinnedMediaId: string
  cropResultCount: number
  splitResultCount: number
  audioResultCount: number
  vocalResultCount: number
}): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vite 渲染器模块只有运行时形态
  const load = (path: string): Promise<any> => import(/* @vite-ignore */ path)
  const editor = (await load('/src/stores/editor.ts')).useEditorStore.getState().editor
  const engine = await load('/src/engine/executor.ts')
  const nodeValues = await load('/src/nodes/nodeValues.ts')
  const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
  for (let i = 0; i < 200; i++) {
    if (editor.getShape('shape:lm-crop')) break
    if (i === 199) throw new Error('MEDIA_REOPEN_CANVAS_TIMEOUT')
    await delay(100)
  }
  // 无人操作重开不得自动再次生成：等待 3 秒核对运行记录不变。
  const runBefore = editor.getShape('shape:lm-crop')?.meta?.nodeRun
  await delay(3000)
  const runAfter = editor.getShape('shape:lm-crop')?.meta?.nodeRun
  if (JSON.stringify(runBefore) !== JSON.stringify(runAfter)) throw new Error('MEDIA_REOPEN_AUTO_RERUN')

  const cropShape = editor.getShape('shape:lm-crop')
  const cropCollection = nodeValues.parseMediaResultCollection(String(cropShape?.meta?.nodeResult ?? ''))
  if (!cropCollection || cropCollection.results.length !== state.cropResultCount) {
    throw new Error('MEDIA_REOPEN_CROP_COLLECTION')
  }
  const splitShape = editor.getShape('shape:lm-split')
  const splitCollection = nodeValues.parseMediaResultCollection(String(splitShape?.meta?.nodeResult ?? ''))
  if (!splitCollection || splitCollection.results.length !== state.splitResultCount) {
    throw new Error('MEDIA_REOPEN_SPLIT_COLLECTION')
  }
  const pinnedOut = nodeValues.projectNodeOutputs(cropShape)
  if (pinnedOut['out-image']?.mediaId !== state.pinnedMediaId) {
    throw new Error('MEDIA_REOPEN_PINNED_LOST')
  }
  const failRun = editor.getShape('shape:lm-fail')?.meta?.nodeRun
  if (failRun?.status !== 'failed') throw new Error('MEDIA_REOPEN_FAIL_STATE_LOST')
  const clipFastRun = editor.getShape('shape:lm-clip-fast')?.meta?.nodeRun
  if (clipFastRun?.status !== 'success') throw new Error('MEDIA_REOPEN_CLIP_STATE_LOST')
  // 提音与人声增强的持久化结果与运行记录。
  const audioShape = editor.getShape('shape:lm-audio')
  const audioCollection = nodeValues.parseMediaResultCollection(
    String(audioShape?.meta?.nodeResult ?? '')
  )
  if (!audioCollection || audioCollection.results.length !== state.audioResultCount) {
    throw new Error('MEDIA_REOPEN_AUDIO_COLLECTION')
  }
  if (audioShape?.meta?.nodeRun?.status !== 'success') throw new Error('MEDIA_REOPEN_AUDIO_STATE')
  const vocalShape = editor.getShape('shape:lm-vocal')
  const vocalReopened = JSON.parse(String(vocalShape?.meta?.nodeResult ?? '{}')) as {
    vocals?: { mediaId?: string }
  }
  if (!vocalReopened?.vocals?.mediaId) throw new Error('MEDIA_REOPEN_VOCAL_COLLECTION')
  if (vocalShape?.meta?.nodeRun?.status !== 'success') throw new Error('MEDIA_REOPEN_VOCAL_STATE')
  // 连线仍然真实存在：派生图里裁剪与拆分的输入都来自同一张原图。
  const derived = (await load('/src/canvas/graph.ts')).deriveGraph(editor)
  const cropEdges = derived.edges.filter(
    (edge: { to: { nodeId: string }; from: { nodeId: string } }) =>
      edge.to.nodeId === 'shape:lm-crop' && edge.from.nodeId === 'shape:lm-source'
  )
  if (cropEdges.length === 0) throw new Error('MEDIA_REOPEN_EDGES_LOST')

  // 明确重试仍然可用：修改参数并解除固定后手动运行成功，新增一条历史结果。
  editor.updateShape({
    id: 'shape:lm-crop',
    type: 'node-card',
    props: {
      config: JSON.stringify({
        version: 1,
        mode: 'rect',
        aspectRatio: 'free',
        rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }
      })
    }
  })
  const retry = await engine.runNodeManually(editor, state.projectId, [], 'shape:lm-crop')
  if (retry.status !== 'done') throw new Error(`MEDIA_REOPEN_RETRY_FAILED:${retry.reason}`)
  const retryCollection = nodeValues.parseMediaResultCollection(
    String(editor.getShape('shape:lm-crop')?.meta?.nodeResult ?? '')
  )
  if (!retryCollection || retryCollection.results.length !== state.cropResultCount + 1) {
    throw new Error('MEDIA_REOPEN_RETRY_COLLECTION')
  }
  return {
    cropResultCount: retryCollection.results.length,
    splitResultCount: splitCollection.results.length,
    pinnedMediaId: pinnedOut['out-image'].mediaId,
    autoRerunObserved: false
  }
}
