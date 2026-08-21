// 媒体资产 store：资产中心的数据源（加载/删除/增量更新）
// 导入和生成操作完成后可调用 refresh() 增量刷新列表
import { create } from 'zustand'
import type { MediaAsset } from '@shared/types'

interface MediaState {
  assets: MediaAsset[]
  loaded: boolean
  /** 按类型筛选：all / image / video / audio / file */
  filter: MediaAsset['kind'] | 'all'
  /** 搜索关键词（匹配文件名） */
  keyword: string
  load: (projectId: string) => Promise<void>
  refresh: (projectId: string) => Promise<void>
  remove: (projectId: string, mediaId: string) => Promise<void>
  setFilter: (filter: MediaAsset['kind'] | 'all') => void
  setKeyword: (kw: string) => void
}

export const useMediaStore = create<MediaState>((set, get) => ({
  assets: [],
  loaded: false,
  filter: 'all',
  keyword: '',
  load: async (projectId) => {
    const res = await window.api.listMedia(projectId)
    if (res.ok) set({ assets: res.data, loaded: true })
  },
  refresh: async (projectId) => {
    const res = await window.api.listMedia(projectId)
    if (res.ok) set({ assets: res.data, loaded: true })
  },
  remove: async (_projectId, mediaId) => {
    const res = await window.api.deleteMedia(mediaId)
    if (res.ok && res.data) {
      set({ assets: get().assets.filter((a) => a.id !== mediaId) })
    }
  },
  setFilter: (filter) => set({ filter }),
  setKeyword: (keyword) => set({ keyword })
}))

/** 过滤后的资产列表（按 filter + keyword） */
export function filteredAssets(
  state: Pick<MediaState, 'assets' | 'filter' | 'keyword'>
): MediaAsset[] {
  let list = state.assets
  if (state.filter !== 'all') {
    list = list.filter((a) => a.kind === state.filter)
  }
  const kw = state.keyword.trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (a) =>
        (a.name ?? '').toLowerCase().includes(kw) || a.id.toLowerCase().includes(kw)
    )
  }
  return list
}
