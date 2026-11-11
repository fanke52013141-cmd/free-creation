/**
 * 节点流发布/草稿的结构化错误码（W1）。
 *
 * GUI、CLI、MCP 共用同一组稳定 code；IPC envelope 与 Agent access 只映射 code，
 * 不解析中文 message。message 仍保留给用户，但不进入诊断事件的 message 字段。
 */
export const COMPOSITE_PUBLISH_ERROR_CODES = [
  'VERSION_IMMUTABLE',
  'VERSION_NOT_NEWER',
  'DRAFT_REVISION_CONFLICT',
  'DRAFT_NOT_FOUND',
  'PUBLISH_INVALID'
] as const

export type CompositePublishErrorCode = (typeof COMPOSITE_PUBLISH_ERROR_CODES)[number]

export interface CompositePublishErrorDetails {
  capabilityId?: string
  version?: string
  expectedRevision?: number
  currentRevision?: number
  existingHash?: string
  incomingHash?: string
  latestVersion?: string
  issues?: ReadonlyArray<{ code: string; path: string; message: string }>
}

export class CompositePublishError extends Error {
  readonly code: CompositePublishErrorCode
  readonly details: CompositePublishErrorDetails

  constructor(
    code: CompositePublishErrorCode,
    message: string,
    details: CompositePublishErrorDetails = {}
  ) {
    super(message)
    this.name = 'CompositePublishError'
    this.code = code
    this.details = details
  }
}

export function isCompositePublishError(error: unknown): error is CompositePublishError {
  return error instanceof CompositePublishError
}

/** 只提取稳定 code；用于 IPC/诊断，不读取原始 message。 */
export function compositeErrorCode(error: unknown, fallback = 'PUBLISH_INVALID'): string {
  return isCompositePublishError(error) ? error.code : fallback
}
