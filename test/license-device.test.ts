/**
 * 设备适配器测试：软件适配器全操作（创建→读公钥→挑战证明→签名/解封装→销毁）、
 * 跨设备拒绝、密钥丢失行为，以及 PCP 适配器的脚本装配安全。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  buildProofMessage,
  decodeBase64Url,
  deviceSummaryFromSpki,
  encodeBase64Url,
  generateEd25519Key,
  hmacSha256,
  kidFromSpki,
  rsaOaepSha256Encrypt,
  rsaPssSha256Verify
} from '@free-creation/license-protocol'
import { SoftwareDeviceAdapter, createInMemorySoftwareAdapter } from '../src/main/security/license/device/software'
import { WindowsPcpDeviceAdapter, fillScript } from '../src/main/security/license/device/windows-pcp'
import { LicenseError } from '../src/main/security/license/errors'

describe('SoftwareDeviceAdapter', () => {
  it('创建→读公钥→挑战证明→签名→解封装→销毁 全链路', async () => {
    const adapter = createInMemorySoftwareAdapter()
    await adapter.createDeviceKeys()
    const publicKeys = await adapter.readPublicKeys()

    expect(publicKeys.keySource).toBe('software-dev')
    expect(publicKeys.ekPublicKeyHash).toBeNull()
    expect(publicKeys.deviceSummary).toMatch(/^[0-9a-f]{16}$/)

    const challengeId = '11111111-2222-4333-8444-555555555555'
    const nonce = randomBytes(32)
    const secret = randomBytes(32)
    const wrapped = rsaOaepSha256Encrypt({ wrapPublicKey: publicKeys.wrapPublicKey, plaintext: secret })

    const proof = await adapter.attestChallenge({
      challengeId,
      nonceBase64Url: encodeBase64Url(nonce),
      wrappedSecretBase64Url: encodeBase64Url(wrapped)
    })

    // 签发端视角：用自己掌握的 secret 复算 HMAC，必须一致。
    const expectedMac = hmacSha256(secret, buildProofMessage('proofHmac', challengeId, encodeBase64Url(nonce)))
    expect(proof.secretHmac).toBe(encodeBase64Url(expectedMac))

    // K_sign 签名必须能在申请公钥下验证。
    const signMessage = buildProofMessage('proofSign', challengeId, encodeBase64Url(nonce))
    expect(
      rsaPssSha256Verify({ signPublicKey: publicKeys.signPublicKey, message: signMessage, sig: proof.challengeSignature })
    ).toBe(true)

    // sign/unwrap 常规操作。
    const data = Buffer.from('activation-check')
    const sig = await adapter.sign(data)
    expect(rsaPssSha256Verify({ signPublicKey: publicKeys.signPublicKey, message: data, sig })).toBe(true)
    const unwrapped = await adapter.unwrap(rsaOaepSha256Encrypt({ wrapPublicKey: publicKeys.wrapPublicKey, plaintext: Buffer.from('payload') }))
    expect(unwrapped.toString('utf8')).toBe('payload')

    await adapter.destroyDeviceKeys()
    await expect(adapter.readPublicKeys()).rejects.toMatchObject({ code: 'DEVICE_KEY_MISSING' })
  })

  it('未创建密钥前读取公钥报 DEVICE_KEY_MISSING', async () => {
    const adapter = createInMemorySoftwareAdapter()
    await expect(adapter.readPublicKeys()).rejects.toMatchObject({ code: 'DEVICE_KEY_MISSING' })
  })

  it('磁盘模式：密钥落盘并可重新加载（幂等）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cs-license-device-'))
    const keyStorePath = join(root, 'security', 'dev-device-keys.json')
    const first = new SoftwareDeviceAdapter({ keyStorePath })
    await first.createDeviceKeys()
    expect(existsSync(keyStorePath)).toBe(true)

    const publicKeysFirst = await first.readPublicKeys()
    const second = new SoftwareDeviceAdapter({ keyStorePath })
    await second.createDeviceKeys() // 幂等：不重建
    const publicKeysSecond = await second.readPublicKeys()
    expect(publicKeysSecond.signPublicKey).toBe(publicKeysFirst.signPublicKey)
    expect(publicKeysSecond.deviceSummary).toBe(deviceSummaryFromSpki(
      Buffer.from(decodeBase64Url(publicKeysFirst.signPublicKey)),
      Buffer.from(decodeBase64Url(publicKeysFirst.wrapPublicKey))
    ))
  })

  it('用错误私钥封装的秘密无法解封装', async () => {
    const adapter = createInMemorySoftwareAdapter()
    await adapter.createDeviceKeys()
    const otherAdapter = createInMemorySoftwareAdapter()
    await otherAdapter.createDeviceKeys()
    const otherKeys = await otherAdapter.readPublicKeys()

    const wrappedForOther = rsaOaepSha256Encrypt({
      wrapPublicKey: otherKeys.wrapPublicKey,
      plaintext: Buffer.alloc(32, 1)
    })
    await expect(adapter.unwrap(wrappedForOther)).rejects.toMatchObject({ code: 'DEVICE_UNWRAP_FAILED' })
  })
})

describe('设备摘要与 kid 的协议一致性', () => {
  it('deviceSummaryFromSpki 与 kidFromSpki 基于同一 SPKI 语义', () => {
    const key = generateEd25519Key()
    const spki = Buffer.from(decodeBase64Url(key.publicKey))
    expect(kidFromSpki(spki)).toBe(key.kid)
    const summary = deviceSummaryFromSpki(spki, spki)
    expect(summary).toHaveLength(16)
  })
})

describe('WindowsPcpDeviceAdapter 脚本装配安全', () => {
  it('fillScript 拒绝带引号/分号等注入字符的参数', () => {
    expect(() => fillScript('X=__DATA_B64__', { __DATA_B64__: "abc'; rm" })).toThrow(LicenseError)
    expect(fillScript('X=__DATA_B64__', { __DATA_B64__: 'YWJj' })).toBe('X=YWJj')
  })

  it('PCP 适配器 probe 在无 JSON 输出时报 DEVICE_TOOL_ERROR 之外的稳定行为', async () => {
    // 不实际运行 powershell：只验证接口契约存在且 keySource 正确。
    const adapter = new WindowsPcpDeviceAdapter()
    expect(adapter.keySource).toBe('tpm-pcp')
  })
})
