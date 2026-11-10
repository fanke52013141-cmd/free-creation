import type { CompositeManifest } from './manifest'

/** 组合能力发现摘要；不含内部图，避免列表接口传输整份 manifest。 */
export interface CompositeCapabilitySummary {
  id: string
  name: string
  description: string
  tags: string[]
  latestVersion: string | null
  archived: boolean
  createdAt: number
  updatedAt: number
}

/** 已发布的不可变版本。 */
export interface CompositeVersionRecord {
  capabilityId: string
  version: string
  manifest: CompositeManifest
  contentHash: string
  publishedAt: number
}

/** 可编辑草稿；revision 用于并发保护。 */
export interface CompositeDraftRecord {
  capabilityId: string
  manifest: CompositeManifest
  revision: number
  updatedAt: number
}

export interface CompositeDraftSaveInput {
  manifest: CompositeManifest
  /** 传入则做乐观并发校验；不传按覆盖保存。 */
  expectedRevision?: number
}

export interface CompositePublishInput {
  manifest: CompositeManifest
  publishedBy?: string
}

export interface CompositeSearchInput {
  query?: string
  includeArchived?: boolean
  limit?: number
}
