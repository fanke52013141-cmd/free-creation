// IPC 契约：通道名 + payload 类型 + 统一信封（见《技术框架与规范》§10）

export const IPC = {
  app: {
    bootstrap: 'app:bootstrap'
  },
  project: {
    list: 'project:list',
    create: 'project:create',
    rename: 'project:rename',
    remove: 'project:delete',
    open: 'project:open',
    save: 'project:save',
    saveSync: 'project:save-sync',
    close: 'project:close'
  },
  media: {
    import: 'media:import',
    pick: 'media:pick'
  }
} as const

export type IpcEnvelope<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export interface BootstrapInfo {
  lastProjectId: string | null
}

export interface CreateProjectInput {
  name: string
}

export interface RenameProjectInput {
  id: string
  name: string
}

export interface SaveProjectInput {
  id: string
  tldrawSnapshot?: unknown
  graph?: { nodes: unknown[]; edges: unknown[]; groups: unknown[] }
}
