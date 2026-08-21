// 浏览器直连 vite dev 时的 window.api 模拟：Electron 内 preload 已提供真实 api，
// 此 mock 仅在开发期用浏览器验证画布交互（建节点/拖拽/缩放），媒体导入返回空
import type { ProjectMeta, ProjectFile } from '@shared/types'

export function installBrowserMock(): void {
  if (window.api) return

  const now = Date.now()
  const projects: ProjectMeta[] = [
    { id: 'demo', name: '浏览器演示项目', createdAt: now, updatedAt: now, graphVersion: 0 }
  ]
  let snapshot: unknown

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
    pickMedia: () => Promise.resolve({ ok: true, data: { assets: [], errors: [] } }),
    getDroppedFilePath: () => ''
  } as unknown as typeof window.api
}
