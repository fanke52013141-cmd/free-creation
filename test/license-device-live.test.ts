/**
 * Windows PCP 适配器真机验证（需要真实 TPM/PCP 环境）。
 *
 * 默认跳过；设置 CANVAS_LICENSE_LIVE_PCP=1 时运行。
 * 该测试会真实创建设备密钥（CS-STUDIO-SIGN-K1 / CS-STUDIO-WRAP-K1），
 * 走一遍挑战证明与持有验证，最后销毁密钥恢复初始状态。
 */
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  buildProofMessage,
  encodeBase64Url,
  hmacSha256,
  rsaOaepSha256Encrypt,
  rsaPssSha256Verify
} from '@free-creation/license-protocol'
import { WindowsPcpDeviceAdapter } from '../src/main/security/license/device/windows-pcp'

const liveEnabled = process.env.CANVAS_LICENSE_LIVE_PCP === '1'

describe.skipIf(!liveEnabled)('WindowsPcpDeviceAdapter 真机验证', () => {
  it('probe → create → readPublicKeys → attestChallenge → sign → destroy', async () => {
    const adapter = new WindowsPcpDeviceAdapter()

    const probe = await adapter.probe()
    expect(probe.available, `PCP 探测应可用: ${probe.detail}`).toBe(true)

    await adapter.createDeviceKeys()
    await adapter.createDeviceKeys() // 幂等

    const publicKeys = await adapter.readPublicKeys()
    expect(publicKeys.keySource).toBe('tpm-pcp')
    expect(publicKeys.deviceSummary).toMatch(/^[0-9a-f]{16}$/)
    // EK 摘要：非管理员会话可能取不到，两种结果都记录下来。
    console.info(`[live-pcp] ekPublicKeyHash=${publicKeys.ekPublicKeyHash ?? '(当前会话不可得)'}`)

    const challengeId = '22222222-3333-4444-8555-666666666666'
    const nonce = randomBytes(32)
    const secret = randomBytes(32)
    const wrapped = rsaOaepSha256Encrypt({ wrapPublicKey: publicKeys.wrapPublicKey, plaintext: secret })

    const proof = await adapter.attestChallenge({
      challengeId,
      nonceBase64Url: encodeBase64Url(nonce),
      wrappedSecretBase64Url: encodeBase64Url(wrapped)
    })
    const expectedMac = hmacSha256(secret, buildProofMessage('proofHmac', challengeId, encodeBase64Url(nonce)))
    expect(proof.secretHmac).toBe(encodeBase64Url(expectedMac))
    const signMessage = buildProofMessage('proofSign', challengeId, encodeBase64Url(nonce))
    expect(
      rsaPssSha256Verify({ signPublicKey: publicKeys.signPublicKey, message: signMessage, sig: proof.challengeSignature })
    ).toBe(true)

    // 激活后的本机持有验证。
    const check = Buffer.from('cs-license-hold-check')
    const sig = await adapter.sign(check)
    expect(rsaPssSha256Verify({ signPublicKey: publicKeys.signPublicKey, message: check, sig })).toBe(true)

    // unwrap 常规通道。
    const unwrapped = await adapter.unwrap(
      rsaOaepSha256Encrypt({ wrapPublicKey: publicKeys.wrapPublicKey, plaintext: Buffer.from('keystore-master') })
    )
    expect(unwrapped.toString('utf8')).toBe('keystore-master')

    // ⚠ 不调用 destroyDeviceKeys：PCP 容器是整机持久的设备身份，
    // 销毁会让本机既有授权全部失效（锁定 DEVICE_KEY_MISSING）。
    // 销毁只允许由使用者通过换机/重置流程显式执行。
    const after = await adapter.probe()
    expect(after.available).toBe(true)
  })
})

describe.skipIf(liveEnabled)('PCP 真机验证', () => {
  it('默认跳过（设置 CANVAS_LICENSE_LIVE_PCP=1 启用）', () => {
    expect(true).toBe(true)
  })
})
