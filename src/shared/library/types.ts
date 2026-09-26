import type { LibraryCategory } from './blueprint'

export type LibraryPreset = 'image' | 'prompt' | 'character' | 'scene' | 'style' | 'custom'

export type LibraryValueType = 'text' | 'markdown' | 'image' | 'audio' | 'video' | 'file' | 'json' | 'recipe'

/** Binary payloads only cross IPC during explicit import/capture operations. */
export interface LibraryComponentInput {
  role: string
  valueType: LibraryValueType
  text?: string
  data?: Uint8Array
  mime?: string
  fileName?: string
  metadata?: Record<string, unknown>
  /** A prior component may be reused when publishing a new immutable revision. */
  reuseComponentId?: string
}

export interface CreateLibraryResourceInput {
  title: string
  formPreset: LibraryPreset
  category?: { id: string; version: number }
  description?: string
  tags?: string[]
  collectionIds?: string[]
  /** Folder where the resource is filed; omitted means library root. */
  folderId?: string
  components: LibraryComponentInput[]
  changeNote?: string
}

export interface CaptureProjectMediaInput {
  projectId: string
  mediaId: string
  title?: string
  description?: string
  tags?: string[]
}

export interface CaptureProjectNodesInput {
  projectId: string
  title: string
  folderId?: string
  /** When set, the selected nodes become a new immutable revision of this asset. */
  resourceId?: string
  baseRevisionId?: string
  changeNote?: string
  nodes: Array<{
    nodeId: string
    title: string
    nodeType: string
    text?: string
    mediaId?: string
    mediaMime?: string
  }>
}

export interface LibraryFolder {
  id: string
  name: string
  parentId: string | null
  resourceCount: number
  createdAt: number
  updatedAt: number
}

export interface CreateLibraryFolderInput {
  name: string
  parentId?: string | null
}

export interface PublishLibraryRevisionInput extends CreateLibraryResourceInput {
  resourceId: string
  /** Expected current head for conflict protection. */
  baseRevisionId: string
  /** Optional historical revision from which the content was derived. */
  sourceRevisionId?: string
}

export interface LibrarySearchInput {
  query?: string
  categoryId?: string
  formPreset?: LibraryPreset | 'all'
  collectionId?: string
  folderId?: string
  includeArchived?: boolean
  cursor?: string
  limit?: number
}

export interface LibraryResourceSummary {
  id: string
  formPreset: LibraryPreset
  title: string
  description: string
  category?: LibraryCategory
  latestRevisionId: string
  revisionNumber: number
  componentCount: number
  coverPath?: string
  tags: string[]
  collectionIds: string[]
  folderIds: string[]
  updatedAt: number
  archivedAt?: number
}

export interface LibraryResourceComponent {
  id: string
  role: string
  valueType: LibraryValueType
  text?: string
  blobPath?: string
  contentHash?: string
  mime?: string
  fileName?: string
  sizeBytes?: number
  metadata: Record<string, unknown>
  order: number
}

export interface LibraryRevisionSummary {
  id: string
  revisionNumber: number
  title: string
  description: string
  changeNote?: string
  createdAt: number
  componentCount: number
}

export interface LibraryResourceDetail extends LibraryResourceSummary {
  selectedRevisionId: string
  selectedRevisionNumber: number
  selectedTitle: string
  selectedDescription: string
  selectedChangeNote?: string
  revisions: LibraryRevisionSummary[]
  components: LibraryResourceComponent[]
}

export interface LibraryCollection {
  id: string
  name: string
  description: string
  resourceCount: number
  createdAt: number
  updatedAt: number
}

export interface CreateLibraryCollectionInput {
  name: string
  description?: string
}

export interface SetLibraryCollectionsInput {
  resourceId: string
  collectionIds: string[]
}

export interface LibraryBoard {
  id: string
  title: string
  description: string
  createdAt: number
  updatedAt: number
}

export interface LibraryBoardItem {
  id: string
  resourceId: string
  revisionId: string
  x: number
  y: number
  width: number
  height: number
  note: string
  order: number
}

export interface SaveLibraryBoardInput {
  boardId: string
  items: LibraryBoardItem[]
}
