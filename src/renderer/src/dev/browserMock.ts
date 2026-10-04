// 浏览器直连 vite dev 时的 window.api 模拟：Electron 内 preload 已提供真实 api，
// 此 mock 仅在开发期用浏览器验证画布交互；媒体仅保存在当前浏览器会话。
import type { MediaAsset, ProjectMeta, ProjectFile, ProviderSummary } from '@shared/types'
import type {
  ImportMediaBufferInput,
  IpcEnvelope,
  ImageGenerateInput,
  ImageGenerationTimingSample,
  GenerationTimingSample,
  SaveProviderInput
} from '@shared/contracts'
import { createBrowserMedia } from './browserMedia'
import { defaultPalettePreferences, type PalettePreferences } from '@shared/palette-preferences'
import { defaultWorkspaceProfile, type WorkspaceProfile } from '@shared/workspace-profile'

// 在模块作用域取 Api 类型：函数内 `if (window.api) return` 会把 window.api 收窄成
// never，导致函数内 typeof 取不到。此别名让 mockApi 获得逐成员的上下文类型检查
// （F16：缺成员/形状不符都在编译期报错，替代原先的整体强转）。
type WindowApi = typeof window.api

export function installBrowserMock(): void {
  if (window.api) return
  const media = createBrowserMedia()

  // 浏览器验收页不是 Electron 的项目数据库，但刷新页面也不应让正在验收的节点消失。
  // 仅把画布快照和不含密钥的供应商摘要放到当前 tab 的 sessionStorage；关闭 tab 后即清空，
  // 真实桌面项目仍只走主进程 SQLite/文件存储。
  const readSession = <T>(key: string, fallback: T): T => {
    try {
      const raw = window.sessionStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  }
  const writeSession = (key: string, value: unknown): void => {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // 容量或隐私模式受限时仍保留本页内存态，不让验收页崩溃。
    }
  }
  const snapshotKey = 'canvas-studio.browser-demo.snapshot.v1'
  const providersKey = 'canvas-studio.browser-demo.providers.v3'

  const now = Date.now()
  const projects: ProjectMeta[] = [
    { id: 'demo', name: '浏览器演示项目', createdAt: now, updatedAt: now, graphVersion: 0 }
  ]
  const workspaceProfiles = new Map<string, WorkspaceProfile>([['demo', defaultWorkspaceProfile()]])
  let snapshot: unknown = readSession(snapshotKey, null)
  let graphVersion = 0
  const defaultProviders: ProviderSummary[] = [
    {
      id: 'mock-toapis',
      name: 'ToAPIS',
      specId: 'toapis',
      baseURL: 'https://toapis.com/v1',
      hasApiKey: true,
      createdAt: now - 1000,
      models: [{ id: 'gpt-image-2', modality: 'image' }]
    },
    {
      id: 'mock-relay',
      name: '演示中转站',
      specId: 'relay',
      baseURL: 'https://example.com/v1',
      hasApiKey: true,
      createdAt: now,
      models: [
        { id: 'gpt-image-2', modality: 'image' },
        { id: 'gpt-5.2', modality: 'text' }
      ]
    },
    {
      id: 'mock-minimax',
      name: '演示 MiniMax',
      specId: 'minimax',
      baseURL: 'https://api.minimax.example/v2',
      hasApiKey: true,
      createdAt: now,
      models: [
        { id: 'MiniMax-H3', modality: 'video' },
        { id: 'MiniMax-H3-Max', modality: 'video' }
      ]
    },
    {
      id: 'mock-seedance',
      name: '演示 Seedance',
      specId: 'seedance',
      baseURL: 'https://ark.example/api/v3',
      hasApiKey: true,
      createdAt: now,
      models: [
        { id: 'Seedance-2.0', modality: 'video' },
        { id: 'Seedance-2.0-Fast', modality: 'video' }
      ]
    }
  ]
  const rawProviders = readSession(providersKey, defaultProviders)
  const hasToapis = rawProviders.some((p) => p.specId === 'toapis' || p.id === 'mock-toapis')
  const providers = hasToapis ? rawProviders : [defaultProviders[0], ...rawProviders]
  const templates: Array<Record<string, unknown>> = []
  const snapshots: Array<Record<string, unknown> & { projectId: string }> = []
  let palettePreferences: PalettePreferences = defaultPalettePreferences()
  // 浏览器演示没有 SQLite，因此只在当前页内存中模拟这一 API；绝不写入 localStorage。
  const imageGenerationTimings: ImageGenerationTimingSample[] = []
  const generationTimings: GenerationTimingSample[] = []
  const isTimingKey = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,95}$/.test(value)

  const inMemoryApiKeys = new Map<string, string>()

  // F16：演示模式未实现能力的统一信封。调用方拿到的是正常错误分支，
  // 不再是强转时代「调用即 undefined 崩溃」。
  const notImplementedInDemo = (action: string): {
    ok: false
    error: { code: string; message: string }
  } => ({
    ok: false as const,
    error: { code: 'DEMO_NOT_IMPLEMENTED', message: `浏览器演示不支持：${action}` }
  })

  // 模型场景 fixture 开关（ok / noBinding），见 models 命名空间注释。
  const modelScenario = (): string => {
    try {
      return window.sessionStorage.getItem('canvas-studio.browser-demo.modelScenario') || 'ok'
    } catch {
      return 'ok'
    }
  }

  const mockApi: WindowApi = {
    reportNodeRunEvent: () => Promise.resolve({ ok: true, data: true }),
    exportNodeRunDiagnostics: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'UNAVAILABLE', message: '诊断导出仅支持桌面端' }
      }),
    bootstrap: () => Promise.resolve({ ok: true, data: { lastProjectId: 'demo' } }),
    listProjects: () => Promise.resolve({ ok: true, data: projects }),
    createProject: ({
      name,
      workspaceProfile
    }: {
      name: string
      workspaceProfile?: WorkspaceProfile
    }) => {
      const p: ProjectMeta = {
        id: 'p' + Date.now(),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        graphVersion
      }
      projects.unshift(p)
      if (workspaceProfile) workspaceProfiles.set(p.id, workspaceProfile)
      return Promise.resolve({ ok: true, data: p })
    },
    cloneProject: ({ sourceId, name }: { sourceId: string; name: string }) => {
      const source = projects.find((project) => project.id === sourceId)
      if (!source)
        return Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: '源项目不存在' } })
      const p: ProjectMeta = {
        ...source,
        id: `p${Date.now()}`,
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        graphVersion: 0
      }
      projects.unshift(p)
      const profile = workspaceProfiles.get(sourceId)
      if (profile) workspaceProfiles.set(p.id, profile)
      return Promise.resolve({ ok: true, data: p })
    },
    saveWorkspaceProfile: ({
      projectId,
      workspaceProfile
    }: {
      projectId: string
      workspaceProfile: WorkspaceProfile
    }) => {
      const project = projects.find((item) => item.id === projectId)
      if (!project) return Promise.resolve({ ok: true, data: null })
      workspaceProfiles.set(projectId, workspaceProfile)
      project.updatedAt = Date.now()
      return Promise.resolve({ ok: true, data: project })
    },
    listLibraryCategories: () => Promise.resolve({ ok: true, data: [] }),
    saveLibraryCategory: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '请在桌面应用中保存分类' } }),
    discardLibraryMaterialization: () => Promise.resolve({ ok: true, data: false }),
    searchLibrary: () => Promise.resolve({ ok: true, data: { items: [], nextCursor: null } }),
    getLibraryResource: () => Promise.resolve({ ok: true, data: null }),
    createLibraryResource: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持资源库写入' }
      }),
    captureLibraryMedia: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持收藏项目素材' }
      }),
    publishLibraryRevision: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持资源库写入' }
      }),
    archiveLibraryResource: () => Promise.resolve({ ok: true, data: false }),
    listLibraryCollections: () => Promise.resolve({ ok: true, data: [] }),
    createLibraryCollection: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持收藏集写入' }
      }),
    setLibraryCollections: () => Promise.resolve({ ok: true, data: false }),
    listLibraryBoards: () => Promise.resolve({ ok: true, data: [] }),
    createLibraryBoard: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持展板写入' } }),
    getLibraryBoardItems: () => Promise.resolve({ ok: true, data: [] }),
    saveLibraryBoard: () => Promise.resolve({ ok: true, data: false }),
    materializeLibraryResource: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持资源物化' } }),
    exportLibrary: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持资源库导出' }
      }),
    importLibrary: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持资源库导入' }
      }),
    renameProject: ({ id, name }: { id: string; name: string }) => {
      const p = projects.find((x) => x.id === id)
      if (!p) return Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: '不存在' } })
      p.name = name
      return Promise.resolve({ ok: true, data: p })
    },
    deleteProject: () => Promise.resolve({ ok: true, data: true }),
    openProject: (id: string) => {
      const meta = projects.find((x) => x.id === id)
      if (!meta) return Promise.resolve({ ok: true, data: null })
      const file: ProjectFile = {
        version: 1,
        meta,
        nodes: [],
        edges: [],
        groups: [],
        tldrawSnapshot: snapshot,
        workspaceProfile: workspaceProfiles.get(id)
      }
      return Promise.resolve({ ok: true, data: file })
    },
    saveProject: (input: { tldrawSnapshot?: unknown }) => {
      snapshot = input.tldrawSnapshot
      graphVersion += 1
      writeSession(snapshotKey, snapshot)
      return Promise.resolve({ ok: true, data: { graphVersion } })
    },
    saveProjectSync: (input: { tldrawSnapshot?: unknown }) => {
      snapshot = input.tldrawSnapshot
      writeSession(snapshotKey, snapshot)
      return { ok: true, data: { graphVersion } }
    },
    closeProject: () => Promise.resolve({ ok: true, data: true }),
    onExternalProjectChange: () => () => undefined,
    exportProject: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持项目导出' } }),
    importProject: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持项目导入' } }),
    importMedia: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器不能读取本地路径，请使用上传按钮选择文件' }
      }),
    importMediaBuffer: (input: ImportMediaBufferInput) =>
      media
        .addBuffer(input.projectId, {
          name: input.name ?? '演示媒体',
          mime: input.mime,
          data: input.data
        })
        .then((data) => ({ ok: true as const, data }))
        .catch((error) => ({
          ok: false as const,
          error: { code: 'MOCK_IMPORT', message: String(error) }
        })) as Promise<IpcEnvelope<MediaAsset>>, // F16-legacy：@shared/types 与 contracts 的 MediaAsset 声明分叉，局部cast
    cropImage: (input: {
      projectId: string
      sourceMediaId: string
      config: import('@shared/image-crop').ImageCropConfig
    }) =>
      media
        .cropImage(input.projectId, input.sourceMediaId, input.config)
        .then((data) => ({ ok: true as const, data }))
        .catch((error) => ({
          ok: false as const,
          error: { code: 'MOCK_IMAGE_CROP', message: String(error) }
        })),
    splitImageGrid: (input: {
      projectId: string
      sourceMediaId: string
      config: import('@shared/image-split').ImageSplitConfig
    }) =>
      media
        .splitImage(input.projectId, input.sourceMediaId, input.config)
        .then((data) => ({ ok: true as const, data }))
        .catch((error) => ({
          ok: false as const,
          error: { code: 'MOCK_IMAGE_SPLIT', message: String(error) }
        })),
    extractVideoFrame: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持视频取帧' } }),
    clipVideo: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持视频截取' } }),
    extractVideoAudio: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持音频提取' } }),
    soundAdjust: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持声音调整' } }),
    probeVideo: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持视频探测' } }),
    generateVideoThumbnails: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持视频缩略图' }
      }),
    generateAudioWaveform: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持音频波形' }
      }),
    separateVocals: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持人声分离' } }),
    ttsGenerate: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持本地配音' } }),
    getLocalMediaCapabilities: () =>
      Promise.resolve({
        ok: true,
        data: {
          ffmpeg: { available: false, message: '浏览器演示不检测本机工具' },
          ffprobe: { available: false, message: '浏览器演示不检测本机工具' },
          audioSeparator: { available: false, message: '浏览器演示不检测本机工具' }
        }
      }),
    getVideoEngineStatus: () =>
      Promise.resolve({
        ok: true,
        data: {
          pythonAvailable: false,
          ready: false,
          installing: false,
          progress: '',
          message: '浏览器演示不支持本地 CUDA 推理'
        }
      }),
    installVideoEngine: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '请在桌面版应用中安装本地推理环境' }
      }),
    convertVideoDepth: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持本地深度视频转换' }
      }),
    convertVideoClay: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持本地白模视频转换' }
      }),
    cancelVideoConversion: () => Promise.resolve({ ok: true, data: false }),
    pickMedia: async (projectId: string) => ({ ok: true, data: await media.pick(projectId) }),
    listMedia: (projectId: string) => Promise.resolve({ ok: true, data: media.list(projectId) }),
    deleteMedia: (id: string) => Promise.resolve({ ok: true, data: media.remove(id) }),
    revealMedia: () => Promise.resolve({ ok: true, data: true }),
    copyMediaPath: () => Promise.resolve({ ok: true, data: true }),
    openMedia: () => Promise.resolve({ ok: true, data: true }),
    batchExportMedia: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持媒体导出' } }),
    workspace: {
      listTemplates: () =>
        // F16-legacy：演示模板存的是宽松 Record，形状分歧局部 cast
        Promise.resolve({ ok: true, data: templates }) as unknown as ReturnType<
          WindowApi['workspace']['listTemplates']
        >,
      // F16-legacy：演示模板存的是宽松 Record（接口无索引签名，参数型不兼容），整体 cast
      saveTemplate: ((input: Record<string, unknown>) => {
        const template = { ...input, id: `wf-${Date.now()}`, createdAt: Date.now() }
        templates.unshift(template)
        return Promise.resolve({ ok: true, data: template })
      }) as unknown as WindowApi['workspace']['saveTemplate'],
      deleteTemplate: (id: string) => {
        const index = templates.findIndex((template) => template.id === id)
        if (index >= 0) templates.splice(index, 1)
        return Promise.resolve({ ok: true, data: index >= 0 })
      },
      listSnapshots: (projectId: string) =>
        Promise.resolve({
          ok: true,
          data: snapshots
            .filter((snapshot) => snapshot.projectId === projectId)
            .map((snapshot) => {
              const publicSnapshot: Record<string, unknown> = { ...snapshot }
              delete publicSnapshot.projectId
              return publicSnapshot
            }) as never[] // F16-legacy：宽松快照 Record
        }),
      // F16-legacy：同 saveTemplate
      saveSnapshot: ((input: Record<string, unknown> & { projectId: string }) => {
        const snapshot = {
          ...input,
          id: `snap-${Date.now()}`,
          createdAt: Date.now()
        }
        snapshots.unshift(snapshot)
        return Promise.resolve({ ok: true, data: snapshot })
      }) as unknown as WindowApi['workspace']['saveSnapshot'],
      deleteSnapshot: (input: { projectId: string; id: string }) => {
        const index = snapshots.findIndex(
          (snapshot) => snapshot.id === input.id && snapshot.projectId === input.projectId
        )
        if (index >= 0) snapshots.splice(index, 1)
        return Promise.resolve({ ok: true, data: index >= 0 })
      },
      // F16 修正：真实方法名是 getPalettePreferences（旧 mock 写错名被强转掩盖）
      getPalettePreferences: () => Promise.resolve({ ok: true, data: palettePreferences }),
      savePalettePreferences: (prefs: PalettePreferences) => {
        palettePreferences = prefs
        return Promise.resolve({ ok: true, data: palettePreferences })
      },
      recordImageGenerationTiming: (input: ImageGenerationTimingSample) => {
        if (
          !isTimingKey(input.runId) ||
          !isTimingKey(input.providerKey) ||
          !isTimingKey(input.modelKey) ||
          !Number.isInteger(input.durationMs) ||
          input.durationMs < 100 ||
          input.durationMs > 30 * 60 * 1000 ||
          !Number.isInteger(input.recordedAt) ||
          input.recordedAt <= 0
        ) {
          return Promise.resolve({
            ok: false as const,
            error: { code: 'WORKSPACE_STATE_ERROR', message: '图片生成耗时记录格式无效' }
          })
        }
        if (imageGenerationTimings.some((sample) => sample.runId === input.runId)) {
          return Promise.resolve({ ok: true as const, data: [...imageGenerationTimings] })
        }
        imageGenerationTimings.unshift({
          runId: input.runId,
          providerKey: input.providerKey,
          modelKey: input.modelKey,
          durationMs: input.durationMs,
          recordedAt: input.recordedAt
        })
        const sameModel = imageGenerationTimings.filter(
          (sample) => sample.providerKey === input.providerKey && sample.modelKey === input.modelKey
        )
        if (sameModel.length > 20) {
          const oldest = sameModel[20]
          const index = imageGenerationTimings.indexOf(oldest)
          if (index >= 0) imageGenerationTimings.splice(index, 1)
        }
        return Promise.resolve({ ok: true as const, data: [...imageGenerationTimings] })
      },
      getImageGenerationTimings: () =>
        Promise.resolve({ ok: true as const, data: [...imageGenerationTimings] }),
      recordGenerationTiming: (input: GenerationTimingSample) => {
        if (!generationTimings.some((sample) => sample.sampleId === input.sampleId)) {
          generationTimings.unshift(input)
        }
        return Promise.resolve({ ok: true as const, data: [...generationTimings] })
      },
      getGenerationTimings: () =>
        Promise.resolve({ ok: true as const, data: [...generationTimings] })
    },
    getDroppedFilePath: () => '',
    // ── F16 补齐：资源库目录/画布结构导入导出的演示桩 ─────────────────────────
    // 查询类返回诚实的空态；变更类返回 DEMO_NOT_IMPLEMENTED 信封（可被 UI 正常
    // 分支处理），两者都不再是强转时代调用即崩溃的 undefined。
    captureLibraryNodes: () => Promise.resolve(notImplementedInDemo('将节点保存到资源库')),
    listLibraryFolders: () => Promise.resolve({ ok: true as const, data: [] }),
    createLibraryFolder: () => Promise.resolve(notImplementedInDemo('新建资源库目录')),
    renameLibraryFolder: () => Promise.resolve(notImplementedInDemo('重命名资源库目录')),
    deleteLibraryFolder: () => Promise.resolve(notImplementedInDemo('删除资源库目录')),
    setLibraryResourceFolder: () => Promise.resolve(notImplementedInDemo('移动资源到目录')),
    exportCanvasStructure: () => Promise.resolve(notImplementedInDemo('导出画布结构')),
    importCanvasStructure: () => Promise.resolve(notImplementedInDemo('导入画布结构')),
    // ── F16 核心：models 命名空间（rendererGateway.resolveModelFeature 依赖）──
    // 场景 fixture：sessionStorage['canvas-studio.browser-demo.modelScenario']
    //   'ok'（默认）→ 演示绑定可解析，生成节点走演示链路
    //   'noBinding'  → 返回未绑定错误，用于验收「模型未绑定」的用户反馈
    models: {
      listConnections: () =>
        Promise.resolve({
          ok: true as const,
          data: [
            {
              id: 'demo-connection',
              name: '演示模型连接',
              protocol: 'openai-compatible',
              baseUrl: 'https://demo.example.com/v1',
              auth: { type: 'none' },
              headers: {},
              enabled: true,
              metadata: {},
              // 契约 Timestamp 是 ISO 字符串，不是毫秒数
              createdAt: new Date(now).toISOString(),
              updatedAt: new Date(now).toISOString()
            }
          ]
        }),
      listDefinitions: () =>
        Promise.resolve({
          ok: true as const,
          data: [
            {
              id: 'demo-def-image',
              name: '演示生图模型',
              connectionId: 'demo-connection',
              modelId: 'gpt-image-2',
              enabled: true,
              validation: {},
              metadata: {},
              capabilities: [
                {
                  operation: 'image.generate',
                  asynchronous: false,
                  streaming: false,
                  acceptedAssetKinds: [],
                  producedAssetKinds: [],
                  controls: {}
                },
                {
                  operation: 'image.edit',
                  asynchronous: false,
                  streaming: false,
                  acceptedAssetKinds: [],
                  producedAssetKinds: [],
                  controls: {}
                }
              ]
            },
            {
              id: 'demo-def-text',
              name: '演示文本模型',
              connectionId: 'demo-connection',
              modelId: 'gpt-5.2',
              enabled: true,
              validation: {},
              metadata: {},
              capabilities: [
                {
                  operation: 'text.generate',
                  asynchronous: false,
                  streaming: false,
                  acceptedAssetKinds: [],
                  producedAssetKinds: [],
                  controls: {}
                }
              ]
            }
          ]
        }),
      listBindings: () =>
        Promise.resolve(
          modelScenario() === 'ok'
            ? {
                ok: true as const,
                data: [
                  {
                    featureKey: 'image.generate',
                    modelDefinitionId: 'demo-def-image',
                    target: {
                      connectionId: 'demo-connection',
                      modelId: 'gpt-image-2',
                      operation: 'image.generate'
                    },
                    enabled: true,
                    overrides: {},
                    updatedAt: new Date(now).toISOString()
                  },
                  {
                    featureKey: 'text.generate',
                    modelDefinitionId: 'demo-def-text',
                    target: {
                      connectionId: 'demo-connection',
                      modelId: 'gpt-5.2',
                      operation: 'text.generate'
                    },
                    enabled: true,
                    overrides: {},
                    updatedAt: new Date(now).toISOString()
                  }
                ]
              }
            : { ok: true as const, data: [] }
        ),
      resolveBinding: (input: { featureKey: string }) => {
        if (modelScenario() !== 'ok') {
          return Promise.resolve({
            ok: false as const,
            error: {
              code: 'DEMO_MODEL_UNBOUND',
              message: '演示模式：该功能未绑定模型（场景 noBinding）'
            }
          })
        }
        const map: Record<
          string,
          { modelId: string; operation: 'image.generate' | 'text.generate' }
        > = {
          'image.generate': { modelId: 'gpt-image-2', operation: 'image.generate' },
          'text.generate': { modelId: 'gpt-5.2', operation: 'text.generate' }
        }
        const hit = map[input.featureKey]
        if (!hit) {
          return Promise.resolve({
            ok: false as const,
            error: {
              code: 'DEMO_MODEL_UNBOUND',
              message: `演示模式：功能 ${input.featureKey} 未绑定演示模型`
            }
          })
        }
        return Promise.resolve({
          ok: true as const,
          data: {
            featureKey: input.featureKey,
            providerId: 'mock-relay',
            modelId: hit.modelId,
            operation: hit.operation,
            modelKey: `demo:${hit.modelId}`
          }
        })
      },
      saveConnection: () => Promise.resolve(notImplementedInDemo('保存模型连接')),
      saveDefinition: () => Promise.resolve(notImplementedInDemo('保存模型定义')),
      deleteDefinition: () => Promise.resolve(notImplementedInDemo('删除模型定义')),
      deleteDefinitions: () => Promise.resolve(notImplementedInDemo('批量删除模型定义')),
      deleteConnection: () => Promise.resolve(notImplementedInDemo('删除模型连接')),
      discover: () => Promise.resolve({ ok: true as const, data: [] }),
      validate: () => Promise.resolve(notImplementedInDemo('验证模型')),
      saveBinding: () => Promise.resolve(notImplementedInDemo('保存功能绑定'))
    },
    gateway: {
      listProviders: () => Promise.resolve({ ok: true, data: providers }),
      // F16 补齐：演示环境与桌面同构的三个入口
      listExecutableProviders: () => Promise.resolve({ ok: true, data: providers }),
      exportProviders: () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'DEMO_NOT_IMPLEMENTED', message: '浏览器演示不支持：导出供应商配置' }
        }),
      importProviders: () =>
        Promise.resolve({
          ok: false as const,
          error: { code: 'DEMO_NOT_IMPLEMENTED', message: '浏览器演示不支持：导入供应商配置' }
        }),
      saveProvider: (input: SaveProviderInput) => {
        const existing = input.id
          ? providers.find((provider) => provider.id === input.id)
          : undefined
        const id = input.id ?? 'p' + Date.now()
        if (input.apiKey?.trim()) {
          inMemoryApiKeys.set(id, input.apiKey.trim())
        }
        const p: ProviderSummary = {
          id,
          name: input.name,
          specId: input.specId,
          baseURL: input.baseURL,
          hasApiKey: Boolean(
            input.apiKey?.trim() || existing?.hasApiKey || inMemoryApiKeys.has(id)
          ),
          models: input.models.map((model) => ({ ...model })),
          createdAt: existing?.createdAt ?? Date.now()
        }
        const i = providers.findIndex((x) => x.id === p.id)
        if (i >= 0) providers[i] = p
        else providers.push(p)
        writeSession(providersKey, providers)
        return Promise.resolve({ ok: true, data: p })
      },
      deleteProvider: (id: string) => {
        inMemoryApiKeys.delete(id)
        const i = providers.findIndex((x) => x.id === id)
        if (i >= 0) providers.splice(i, 1)
        writeSession(providersKey, providers)
        return Promise.resolve({ ok: true, data: i >= 0 })
      },
      testProvider: (input: SaveProviderInput) =>
        Promise.resolve({
          ok: true,
          data: {
            models: input.models.map((model) => model.id),
            message: '配置格式校验通过'
          }
        }),
      // 协议自检的请求体由主进程的真实构造器生成，浏览器演示里没有那套代码，
      // 也不该拿一份假的请求体骗用户说「构造成功」。
      probeProvider: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'MOCK',
            message: '浏览器演示不提供供应商协议自检，请在桌面端打开设置面板'
          }
        }),
      chatStart: () => Promise.resolve({ ok: true, data: { taskId: 'mock-task' } }),
      chatCancel: () => Promise.resolve({ ok: true, data: true }),
      audioGenerate: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'MOCK', message: '浏览器演示不支持音频生成' }
        }),
      speechGenerate: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'MOCK', message: '浏览器演示不支持配音合成' }
        }),
      voiceDesign: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'MOCK', message: '浏览器演示不支持音色设计' }
        }),
      imageGenerate: async (input: ImageGenerateInput) => {
        const prov = providers.find((p) => p.id === input.providerId)
        const key = inMemoryApiKeys.get(input.providerId)
        if (prov && key && prov.baseURL) {
          try {
            // 真实在浏览器尝试调用 OpenAI-compatible images/generations
            const base = prov.baseURL.replace(/\/+$/, '')
            const resp = await fetch(`${base}/images/generations`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`
              },
              body: JSON.stringify({
                prompt: input.prompt,
                model: input.modelId || 'gpt-image-2',
                size: input.size || '1024x1024',
                n: 1,
                response_format: 'b64_json'
              })
            })
            if (resp.ok) {
              const resJson = await resp.json()
              const b64 = resJson?.data?.[0]?.b64_json
              const imgUrl = resJson?.data?.[0]?.url
              if (b64) {
                const binary = atob(b64)
                const bytes = new Uint8Array(binary.length)
                for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j)
                const asset = await media.addBuffer(input.projectId, {
                  name: `生成图片-${Date.now()}`,
                  mime: 'image/png',
                  data: bytes
                })
                return { ok: true, data: asset }
              } else if (imgUrl) {
                const imgResp = await fetch(imgUrl)
                if (imgResp.ok) {
                  const blob = await imgResp.blob()
                  const buf = new Uint8Array(await blob.arrayBuffer())
                  const asset = await media.addBuffer(input.projectId, {
                    name: `生成图片-${Date.now()}`,
                    mime: blob.type || 'image/png',
                    data: buf
                  })
                  return { ok: true, data: asset }
                }
              }
            }
          } catch (e) {
            console.warn('浏览器直接生图请求失败，降级回生成态：', e)
          }
        }
        return media
          .createGeneratedImage(input.projectId, input.prompt, input.size)
          .then((data) => ({ ok: true as const, data }))
          .catch((error) => ({
            ok: false as const,
            error: { code: 'MOCK_IMAGE_GENERATE', message: String(error) }
          }))
      },
      imageEdit: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'MOCK', message: '浏览器演示不支持图片修改' }
        }),
      videoSubmit: () => Promise.resolve({ ok: true, data: { taskId: 'mock-video' } }),
      videoCancel: () => Promise.resolve({ ok: true, data: true }),
      videoTask: () => Promise.resolve({ ok: true, data: null }),
      onEvent: () => () => undefined
    }
  }
  // F16 修复：直接赋值而非 as 断言。断言对缺失成员不报错（已实测），赋值检查
  // 才会逐成员校验；缺失成员的编译错误即待补缺口清单，补齐方式见 notImplementedInDemo。
  window.api = mockApi
}
