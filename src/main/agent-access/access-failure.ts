export class AccessFailure extends Error {
  constructor(
    readonly code: string,
    readonly phase: string,
    readonly detail?: string,
    /** 版本冲突时宿主报告的当前图版本（结构化回传，客户端可直接用它重试）。 */
    readonly currentGraphVersion?: number
  ) {
    super(code)
  }
}

export interface AccessDiagnosticsContext {
  requestId: string
  traceId: string
  spanId: string
}
