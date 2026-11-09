/**
 * 发行包固定的受信根公钥（方案 §3.3：文件中自带的任意根证书不能取得信任）。
 *
 * ⚠ 本文件由发证流程生成：当前固定的是【开发/测试根】。
 * 切换生产根时：用 cs-issuer 在离线环境生成生产根，替换本文件的 kid 与
 * publicKey，并同步更新 environment 标注。生产根私钥绝不进入任何仓库或构建机。
 *
 * 根指纹（人工核对用）：
 *   kid: sha256-f3f96c67e1feba4ad7cbcc716baae11cd7bbecb2945a9fcfb1602e8026aefbb8
 * 生成时间：2026-11-09 · 用途：P1 隔离联调与验收
 * 换根说明：原开发根私钥仅存于旧开发机且已不可得，2026-11-09 在本机重新 init-root；
 * 旧根（sha256-fb796e4f…）签发的授权自本版起不再受信。
 */
import type { TrustedRoot } from '@free-creation/license-protocol'

export const TRUSTED_ROOT_ENVIRONMENT = 'development' as const

export const TRUSTED_ROOT: TrustedRoot = {
  kid: 'sha256-f3f96c67e1feba4ad7cbcc716baae11cd7bbecb2945a9fcfb1602e8026aefbb8',
  publicKey: 'MCowBQYDK2VwAyEAIxKi5Qt62YvygquKT4qW4J1MI9NGd1uvhblkIN_o-_8'
}
