// 浏览器直连 vite dev 时的 window.api 模拟：Electron 内 preload 已提供真实 api，
// 此 mock 仅在开发期用浏览器验证画布交互（建节点/拖拽/缩放），媒体导入返回空
import type { ProjectMeta, ProjectFile, ProviderSummary } from '@shared/types'

export function installBrowserMock(): void {
  if (window.api) return

  const now = Date.now()
  const projects: ProjectMeta[] = [
    { id: 'demo', name: '浏览器演示项目', createdAt: now, updatedAt: now, graphVersion: 0 }
  ]
  let snapshot: unknown
  const providers: ProviderSummary[] = [
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
  const templates: Array<Record<string, unknown>> = []
  const snapshots: Array<Record<string, unknown> & { projectId: string }> = []

  window.api = {
    bootstrap: () => Promise.resolve({ ok: true, data: { lastProjectId: 'demo' } }),
    listProjects: () => Promise.resolve({ ok: true, data: projects }),
    createProject: ({ name }: { name: string }) => {
      const p: ProjectMeta = {
        id: 'p' + Date.now(),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        graphVersion: 0
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
      return Promise.resolve({ ok: true, data: { graphVersion: 1 } })
    },
    saveProjectSync: () => undefined,
    closeProject: () => Promise.resolve({ ok: true, data: true }),
    importMedia: () => Promise.resolve({ ok: true, data: { assets: [], errors: [] } }),
    importMediaBuffer: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持媒体写入' } }),
    cropImage: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持本地裁剪' } }),
    extractVideoFrame: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持视频取帧' } }),
    clipVideo: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持视频截取' } }),
    extractVideoAudio: () =>
      Promise.resolve({ ok: false, error: { code: 'MOCK', message: '浏览器演示不支持音频提取' } }),
    pickMedia: () => Promise.resolve({ ok: true, data: { assets: [], errors: [] } }),
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
      }
    },
    getDroppedFilePath: () => '',
    gateway: {
      listProviders: () => Promise.resolve({ ok: true, data: providers }),
      saveProvider: (input: { id?: string; name: string }) => {
        const p: ProviderSummary = {
          id: input.id ?? 'p' + Date.now(),
          name: input.name,
          specId: 'relay',
          baseURL: '',
          hasApiKey: false,
          models: [],
          createdAt: Date.now()
        }
        const i = providers.findIndex((x) => x.id === p.id)
        if (i >= 0) providers[i] = p
        else providers.push(p)
        return Promise.resolve({ ok: true, data: p })
      },
      deleteProvider: (id: string) => {
        const i = providers.findIndex((x) => x.id === id)
        if (i >= 0) providers.splice(i, 1)
        return Promise.resolve({ ok: true, data: i >= 0 })
      },
      testProvider: () =>
        Promise.resolve({
          ok: true,
          data: { models: ['gpt-image-2', 'gpt-5.2'], message: '演示环境' }
        }),
      chatStart: () => Promise.resolve({ ok: true, data: { taskId: 'mock-task' } }),
      chatCancel: () => Promise.resolve({ ok: true, data: true }),
      imageGenerate: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'MOCK', message: '浏览器演示不支持真实生成' }
        }),
      videoSubmit: () => Promise.resolve({ ok: true, data: { taskId: 'mock-video' } }),
      videoCancel: () => Promise.resolve({ ok: true, data: true }),
      videoTask: () => Promise.resolve({ ok: true, data: null }),
      onEvent: () => () => undefined
    }
  } as unknown as typeof window.api
}
