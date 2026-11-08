/**
 * 设备适配器选择（应用启动时一次性决定）。
 *
 * 优先级：
 * 1. Windows PCP（真实 TPM 绑定）探测可用 → WindowsPcpDeviceAdapter；
 * 2. 开发未打包构建 + 显式 CANVAS_LICENSE_ALLOW_SOFTWARE_DEVICE=1 → 软件适配器
 *    （密钥存 <dataDir>/security/dev-device-keys.json，无硬件绑定，仅供隔离联调）；
 * 3. 其余（生产打包且无 TPM）→ 不可用适配器：授权停在锁定态并给出区分提示，
 *    绝不静默降级到软件密钥（对应验收「软件 TPM 被拒绝」）。
 */
import { app } from 'electron'
import { join } from 'node:path'
import type { DeviceKeyAdapter } from './adapter.ts'
import { LicenseError } from '../errors.ts'
import { WindowsPcpDeviceAdapter } from './windows-pcp.ts'
import { SoftwareDeviceAdapter } from './software.ts'

class UnavailableDeviceAdapter implements DeviceKeyAdapter {
  readonly keySource = 'tpm-pcp' as const

  constructor(private readonly reason: string) {}

  private unavailable(): never {
    throw new LicenseError('DEVICE_UNSUPPORTED', this.reason)
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    return { available: false, detail: this.reason }
  }

  async createDeviceKeys(): Promise<void> {
    this.unavailable()
  }
  async readPublicKeys(): Promise<never> {
    this.unavailable()
  }
  async attestChallenge(): Promise<never> {
    this.unavailable()
  }
  async sign(): Promise<never> {
    this.unavailable()
  }
  async unwrap(): Promise<never> {
    this.unavailable()
  }
  async destroyDeviceKeys(): Promise<void> {
    this.unavailable()
  }
}

let gateAdapter: DeviceKeyAdapter | null = null

/** 门禁通过后登记设备适配器（密钥包服务的签名/解封装通道）。 */
export function setGateAdapter(adapter: DeviceKeyAdapter): void {
  gateAdapter = adapter
}

export function getGateAdapter(): DeviceKeyAdapter | null {
  return gateAdapter
}

export async function selectDeviceAdapter(input: {
  dataDir: string
  /** 测试注入；缺省探测真实 PCP。 */
  adapterOverride?: DeviceKeyAdapter
}): Promise<{ adapter: DeviceKeyAdapter; detail: string }> {
  if (input.adapterOverride) {
    return { adapter: input.adapterOverride, detail: '测试注入适配器' }
  }
  const pcp = new WindowsPcpDeviceAdapter()
  try {
    const probe = await pcp.probe()
    if (probe.available) {
      return { adapter: pcp, detail: probe.detail }
    }
    const tpmUnavailableReason = `本机 TPM/PCP 不可用：${probe.detail}`
    const devAllowed = !app.isPackaged && process.env.CANVAS_LICENSE_ALLOW_SOFTWARE_DEVICE === '1'
    if (devAllowed) {
      return {
        adapter: new SoftwareDeviceAdapter({ keyStorePath: join(input.dataDir, 'security', 'dev-device-keys.json') }),
        detail: `${tpmUnavailableReason}；开发构建已显式启用软件设备密钥（无硬件绑定）`
      }
    }
    return {
      adapter: new UnavailableDeviceAdapter(tpmUnavailableReason),
      detail: tpmUnavailableReason
    }
  } catch (error) {
    return {
      adapter: new UnavailableDeviceAdapter(`TPM/PCP 探测异常：${String((error as Error).message).slice(0, 160)}`),
      detail: 'TPM/PCP 探测异常'
    }
  }
}
