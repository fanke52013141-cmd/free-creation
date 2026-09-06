// 浏览器直连 vite dev 时的 window.api 模拟：Electron 内 preload 已提供真实 api，
// 此 mock 仅在开发期用浏览器验证画布交互；媒体仅保存在当前浏览器会话。
import type { ProjectMeta, ProjectFile, ProviderSummary } from '@shared/types'
import type { ImageGenerateInput, SaveProviderInput } from '@shared/contracts'
import { createBrowserMedia } from './browserMedia'
import {
  defaultPalettePreferences,
  normalizePalettePreferences,
  type PalettePreferences
} from '@shared/palette-preferences'

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
  const providersKey = 'canvas-studio.browser-demo.providers.v1'

  const now = Date.now()
  const projects: ProjectMeta[] = [
    { id: 'demo', name: '浏览器演示项目', createdAt: now, updatedAt: now, graphVersion: 0 }
  ]
  let snapshot: unknown = readSession(snapshotKey, null)
  let graphVersion = 0
  const defaultProviders: ProviderSummary[] = [
    {
      id: 'mock-relay',
      name: '演示中转站',
      specId: 'relay',
      baseURL: 'https://example.com/v1',
      hasApiKey: true,
      createdAt: now,
      models: [
        { id: 'gpt-image-2', modality: 'image' },
        { id: 'gpt-5.2', modality: 'text' },
        { id: 'MiniMax-H3', modality: 'video' }
      ]
    }
  ]
  const providers = readSession(providersKey, defaultProviders)
  const templates: Array<Record<string, unknown>> = []
  const snapshots: Array<Record<string, unknown> & { projectId: string }> = []
  let palettePreferences: PalettePreferences = defaultPalettePreferences()

  window.api = {
    bootstrap: () => Promise.resolve({ ok: true, data: { lastProjectId: 'demo' } }),
    listProjects: () => Promise.resolve({ ok: true, data: projects }),
    createProject: ({ name }: { name: string }) => {
      const p: ProjectMeta = {
        id: 'p' + Date.now(),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        graphVersion
      }
      projects.unshift(p)
      return Promise.resolve({ ok: true, data: p })
    },
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
        tldrawSnapshot: snapshot
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
    importMediaBuffer: (input: {
      projectId: string
      name: string
      mime: string
      data: Uint8Array
    }) =>
      media
        .addBuffer(input.projectId, input)
        .then((data) => ({ ok: true as const, data }))
        .catch((error) => ({
          ok: false as const,
          error: { code: 'MOCK_IMPORT', message: String(error) }
        })),
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
    probeVideo: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持视频探测' } }),
    generateVideoThumbnails: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'MOCK', message: '浏览器演示不支持视频缩略图' }
      }),
    generateAudioWaveform: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持音频波形' } }),
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
    pickMedia: async (projectId: string) => ({ ok: true, data: await media.pick(projectId) }),
    listMedia: (projectId: string) => Promise.resolve({ ok: true, data: media.list(projectId) }),
    deleteMedia: (id: string) => Promise.resolve({ ok: true, data: media.remove(id) }),
    revealMedia: () => Promise.resolve({ ok: true, data: true }),
    copyMediaPath: () => Promise.resolve({ ok: true, data: true }),
    openMedia: () => Promise.resolve({ ok: true, data: true }),
    batchExportMedia: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持媒体导出' } }),
    comfyui: {
      status: () =>
        Promise.resolve({
          ok: true,
          data: { configured: false, available: false, baseUrl: '' }
        }),
      saveSettings: (input: { baseUrl: string }) =>
        Promise.resolve({ ok: true, data: { baseUrl: input.baseUrl } })
    },
    workspace: {
      listTemplates: () => Promise.resolve({ ok: true, data: templates }),
      saveTemplate: (input: Record<string, unknown>) => {
        const template = { ...input, id: `wf-${Date.now()}`, createdAt: Date.now() }
        templates.unshift(template)
        return Promise.resolve({ ok: true, data: template })
      },
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
            })
        }),
      saveSnapshot: (input: Record<string, unknown> & { projectId: string }) => {
        const snapshot = {
          ...input,
          id: `snap-${Date.now()}`,
          timestamp: Date.now()
        }
        snapshots.unshift(snapshot)
        return Promise.resolve({ ok: true, data: snapshot })
      },
      deleteSnapshot: ({ projectId, id }: { projectId: string; id: string }) => {
        const index = snapshots.findIndex(
          (snapshot) => snapshot.projectId === projectId && snapshot.id === id
        )
        if (index >= 0) snapshots.splice(index, 1)
        return Promise.resolve({ ok: true, data: index >= 0 })
      },
      getPalettePreferences: () => Promise.resolve({ ok: true, data: palettePreferences }),
      savePalettePreferences: (input: PalettePreferences) => {
        palettePreferences = normalizePalettePreferences(input)
        return Promise.resolve({ ok: true, data: palettePreferences })
      }
    },
    getDroppedFilePath: () => '',
    gateway: {
      listProviders: () => Promise.resolve({ ok: true, data: providers }),
      saveProvider: (input: SaveProviderInput) => {
        const existing = input.id
          ? providers.find((provider) => provider.id === input.id)
          : undefined
        const p: ProviderSummary = {
          id: input.id ?? 'p' + Date.now(),
          name: input.name,
          specId: input.specId,
          baseURL: input.baseURL,
          // 演示页从不把 API Key 写入浏览器存储；仅保留“已配置”状态以供 UI 验收。
          hasApiKey: Boolean(input.apiKey?.trim() || existing?.hasApiKey),
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
            message: '浏览器演示环境：已校验模型配置结构，不会发送 API Key 或真实网络请求'
          }
        }),
      chatStart: () => Promise.resolve({ ok: true, data: { taskId: 'mock-task' } }),
      chatCancel: () => Promise.resolve({ ok: true, data: true }),
      audioGenerate: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'MOCK', message: '浏览器演示不支持音频生成' }
        }),
      imageGenerate: (input: ImageGenerateInput) =>
        media
          .createGeneratedImage(input.projectId, input.prompt, input.size)
          .then((data) => ({ ok: true as const, data }))
          .catch((error) => ({
            ok: false as const,
            error: { code: 'MOCK_IMAGE_GENERATE', message: String(error) }
          })),
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
  } as unknown as typeof window.api
}
