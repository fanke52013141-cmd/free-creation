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
  /** 发布所基于的草稿修订；与当前草稿不一致时拒绝并保留草稿。 */
  expectedRevision?: number
  publishedBy?: string
}

export interface CompositeSearchInput {
  query?: string
  includeArchived?: boolean
  limit?: number
}

/** 删除前引用检查（W3）：画布实例 + 其他节点流发布版本的嵌套引用。 */
export interface CompositeReferenceReport {
  capabilityId: string
  /** 各项目画布上绑定该能力的实例（含固定版本）。 */
  projectInstances: Array<{
    projectId: string
    projectName: string
    nodeId: string
    version: string
  }>
  /** 其他能力的已发布版本通过 dependencies 固定引用该能力。 */
  nestedVersions: Array<{
    capabilityId: string
    version: string
    refVersion: string
  }>
}
