/**
 * 凭据包服务的**共享实例桥**（F9 收尾）。
 *
 * 为什么需要它：`KeyPackageService` 在 `src/main/index.ts` 里与设备密钥库、授权服务、
 * vault 一起构造（它要签名、解封、读设备公钥），外部入口无法也不应另建第二个实例——
 * 那会绕开设备绑定与授权门禁。这里只发布**同一个实例**的窄接口，agent-access 经由它调用，
 * 与 flow-bridge 同一模式。
 *
 * 安全边界：
 * - 只暴露导出/预览侧的三个方法；导入侧要人在 GUI 确认，不经这个端口开放；
 * - 未发布（非桌面启动、或未激活/无 vault）时返回 null，调用方必须如实拒绝
 *   （KEYS_SERVICE_UNAVAILABLE），不降级成本地替身。
 */
export interface KeysPackageAccessPort {
  /** 导出本机接收凭证文本（.cscred）；回执文本由调用方写入受控目录。 */
  exportReceiveCredential(): Promise<{
    credentialText: string
    deviceSummary: string
    expiresAt: number | null
  }>
  /** 为某台接收设备封包（需要接收凭证文本 + 密码 + 连接 ID 列表）。 */
  sealKeyPackageForRecipient(input: {
    password: string
    recipientCredentialText: string
    connectionIds: string[]
  }): Promise<{ packageText: string; packageId: string; expiresAt: number; connectionCount: number }>
  /** 预览已有凭据包（只读，不解密落库）。 */
  openKeyPackagePreview(input: { packageText: string; password: string }): Promise<{
    packageId: string
    expiresAt: number
    issuerDeviceSummary: string
    connections: Array<{ id: string; name: string; protocol: string; baseUrl: string; modelCount: number }>
    alreadyImported: boolean
  }>
  /** 可导出连接清单（与 GUI 同一 listExportableConnections）。 */
  listExportableConnections(): Promise<
    Array<{ id: string; name: string; protocol: string; baseUrl: string; modelCount: number }>
  >
}

let published: KeysPackageAccessPort | null = null

/** 由 main 在 KeyPackageService 构造完成后调用一次（应用生命周期内只有一个实例）。 */
export function publishKeysPackageAccessPort(port: KeysPackageAccessPort): void {
  published = port
}

/** 读取共享凭据包端口；未发布时返回 null。 */
export function keysPackageAccessPort(): KeysPackageAccessPort | null {
  return published
}

/** 仅测试使用：清空发布状态，避免用例之间串台。 */
export function resetKeysPackageAccessPortForTest(): void {
  published = null
}
