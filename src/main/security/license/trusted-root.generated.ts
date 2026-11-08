/**
 * 发行包固定的受信根公钥（方案 §3.3：文件中自带的任意根证书不能取得信任）。
 *
 * ⚠ 本文件由发证流程生成：当前固定的是【开发/测试根】。
 * 切换生产根时：用 cs-issuer 在离线环境生成生产根，替换本文件的 kid 与
 * publicKey，并同步更新 environment 标注。生产根私钥绝不进入任何仓库或构建机。
 *
 * 根指纹（人工核对用）：
 *   kid: sha256-fb796e4fb604983e5847b5ba3124c4d7af626a225a98dfb44a6f41a87888e96a
 * 生成时间：2026-11-07 · 用途：P1 隔离联调与验收
 */
import type { TrustedRoot } from '@free-creation/license-protocol'

export const TRUSTED_ROOT_ENVIRONMENT = 'development' as const

export const TRUSTED_ROOT: TrustedRoot = {
  kid: 'sha256-fb796e4fb604983e5847b5ba3124c4d7af626a225a98dfb44a6f41a87888e96a',
  publicKey: 'MCowBQYDK2VwAyEAlUKoHtNNIOGdig_5RA7XKQs6AbLCiWrUxMH_DoQtsBA'
}
