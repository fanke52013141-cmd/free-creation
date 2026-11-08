/**
 * Windows CNG Platform Crypto Provider 设备适配器。
 *
 * 两把 RSA-2048 不可导出密钥（K_sign 签名用、K_wrap 解封装用）创建在
 * `Microsoft Platform Crypto Provider` 中，绑定当前 Windows 账户的持久密钥容器。
 * 通过 execFile 调用 powershell.exe（-NoProfile -NonInteractive），沿用仓库既有模式；
 * 输出约定为最后一行 JSON（仅 ASCII），解析时兼容 UTF-16LE 控制台编码。
 *
 * 边界：完整 TCG 证明（EK 证书链 + MakeCredential/ActivateCredential/Certify）
 * 需要 PCPTool 互通，属方案 P0 待办；本适配器当前提供 EK 公钥摘要 + 双密钥持有证明。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import {
  buildProofMessage,
  decodeBase64Url,
  deviceSummaryFromSpki,
  encodeBase64Url,
  parseRsaPublicXml,
  rsaPssSha256Verify,
  type DevicePublicKeys
} from '@free-creation/license-protocol'
import { LicenseError } from '../errors.ts'
import type {
  DeviceAttestationResult,
  DeviceKeyAdapter,
  DeviceProbeResult
} from './adapter.ts'

const PCP_PROVIDER_NAME = 'Microsoft Platform Crypto Provider'
export const PCP_SIGN_KEY_NAME = 'CS-STUDIO-SIGN-K1'
export const PCP_WRAP_KEY_NAME = 'CS-STUDIO-WRAP-K1'

const TOOL_TIMEOUT_MS = 60_000

interface PcpToolOutput {
  ok: boolean
  code?: string
  detail?: string
  [key: string]: unknown
}

/** 运行一段 PowerShell 脚本并解析最后一行 JSON。脚本只输出 ASCII。 */
async function runPcpScript(script: string): Promise<PcpToolOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: TOOL_TIMEOUT_MS, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = decodeConsoleOutput(stdout ?? Buffer.alloc(0))
        const jsonLine = [...text.split(/\r?\n/)].reverse().find((line) => line.trim().startsWith('{'))
        if (!jsonLine) {
          const stderrText = decodeConsoleOutput(Buffer.from(stderr ?? Buffer.alloc(0))).trim()
          const detail = (stderrText || text.trim()).slice(-400)
          if (error) {
            reject(new LicenseError('DEVICE_TOOL_ERROR', `PCP 工具执行失败: ${String(error.message).slice(0, 160)} ${detail}`.trim()))
          } else {
            reject(new LicenseError('DEVICE_TOOL_ERROR', `PCP 工具无 JSON 输出${detail ? `: ${detail}` : ''}`))
          }
          return
        }
        let parsed: PcpToolOutput
        try {
          parsed = JSON.parse(jsonLine) as PcpToolOutput
        } catch {
          reject(new LicenseError('DEVICE_TOOL_ERROR', 'PCP 工具输出不是 JSON'))
          return
        }
        if (error && !parsed.ok) {
          parsed = { ...parsed, detail: parsed.detail ?? String(error.message).slice(0, 200) }
        }
        resolve(parsed)
      }
    )
  })
}

/** PowerShell 控制台可能是 UTF-16LE（含 NUL 字节）；按内容探测后解码。 */
function decodeConsoleOutput(output: Buffer): string {
  if (output.includes(0x00)) {
    const withoutBom = output[0] === 0xff && output[1] === 0xfe ? output.subarray(2) : output
    return withoutBom.toString('utf16le')
  }
  return output.toString('utf8')
}

function pcpFailure(output: PcpToolOutput, fallbackCode: LicenseError['code']): LicenseError {
  const code = (output.code as LicenseError['code']) ?? fallbackCode
  return new LicenseError(code, output.detail ?? 'PCP 操作失败')
}

// PowerShell 片段：打开双密钥并输出公钥 XML。
// 公钥导出对不可导出密钥同样允许；私钥材料绝不跨进程边界。
const SCRIPT_TEMPLATE_PROBE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$provider = New-Object System.Security.Cryptography.CngProvider('${PCP_PROVIDER_NAME}')
$signExists = [System.Security.Cryptography.CngKey]::Exists('${PCP_SIGN_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
$wrapExists = [System.Security.Cryptography.CngKey]::Exists('${PCP_WRAP_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; signExists = $signExists; wrapExists = $wrapExists })
`

const SCRIPT_TEMPLATE_CREATE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$provider = New-Object System.Security.Cryptography.CngProvider('${PCP_PROVIDER_NAME}')
$signExists = [System.Security.Cryptography.CngKey]::Exists('${PCP_SIGN_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
$wrapExists = [System.Security.Cryptography.CngKey]::Exists('${PCP_WRAP_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
if ($signExists -and $wrapExists) { Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; created = $false }); exit 0 }
if ($signExists -or $wrapExists) { Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $false; code = 'DEVICE_KEY_STATE_SPLIT'; detail = 'only-one-key-exists' }); exit 0 }
$algorithm = New-Object System.Security.Cryptography.CngAlgorithm('RSA')
$parameters = New-Object System.Security.Cryptography.CngKeyCreationParameters
$parameters.Provider = $provider
$parameters.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::NonExportable
$parameters.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::AllUsages
$lengthBytes = [BitConverter]::GetBytes(2048)
$parameters.Parameters.Add((New-Object System.Security.Cryptography.CngProperty('Length', $lengthBytes, [System.Security.Cryptography.CngPropertyOptions]::None)))
foreach ($name in @('${PCP_SIGN_KEY_NAME}', '${PCP_WRAP_KEY_NAME}')) {
  $created = [System.Security.Cryptography.CngKey]::Create($algorithm, $name, $parameters)
  $created.Dispose()
}
Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; created = $true })
`

const SCRIPT_TEMPLATE_PUBLIC = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$provider = New-Object System.Security.Cryptography.CngProvider('${PCP_PROVIDER_NAME}')
function Export-RsaPublicXml([string]$name) {
  $opened = [System.Security.Cryptography.CngKey]::Open($name, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
  try {
    $rsa = New-Object System.Security.Cryptography.RSACng($opened)
    try { return $rsa.ToXmlString($false) } finally { $rsa.Clear() }
  } finally { $opened.Dispose() }
}
$signXml = Export-RsaPublicXml('${PCP_SIGN_KEY_NAME}')
$wrapXml = Export-RsaPublicXml('${PCP_WRAP_KEY_NAME}')
$ekHash = $null
try {
  $ek = Get-TpmEndorsementKeyInfo -ErrorAction Stop
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $ekBytes = $ek.PublicKey.ExportSubjectPublicKeyInfo()
    $ekHash = ([System.BitConverter]::ToString($sha.ComputeHash($ekBytes))).Replace('-','').ToLowerInvariant()
  } finally { $sha.Dispose() }
} catch { $ekHash = $null }
Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; signXml = $signXml; wrapXml = $wrapXml; ekHash = $ekHash })
`

const SCRIPT_TEMPLATE_ATTEST = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$provider = New-Object System.Security.Cryptography.CngProvider('${PCP_PROVIDER_NAME}')
$signKey = [System.Security.Cryptography.CngKey]::Open('${PCP_SIGN_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
$wrapKey = [System.Security.Cryptography.CngKey]::Open('${PCP_WRAP_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
$signRsa = New-Object System.Security.Cryptography.RSACng($signKey)
$wrapRsa = New-Object System.Security.Cryptography.RSACng($wrapKey)
try {
  $wrapped = [Convert]::FromBase64String('__WRAPPED_B64__')
  $secret = $wrapRsa.Decrypt($wrapped, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
  $message = [Convert]::FromBase64String('__HMAC_MESSAGE_B64__')
  $hmac = New-Object System.Security.Cryptography.HMACSHA256(, $secret)
  try { $mac = $hmac.ComputeHash($message) } finally { $hmac.Dispose() }
  $signMessage = [Convert]::FromBase64String('__SIGN_MESSAGE_B64__')
  $signature = $signRsa.SignData($signMessage, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pss)
  [Array]::Clear($secret, 0, $secret.Length)
  Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; hmac = [Convert]::ToBase64String($mac); signature = [Convert]::ToBase64String($signature) })
} finally {
  $signRsa.Clear(); $wrapRsa.Clear(); $signKey.Dispose(); $wrapKey.Dispose()
}
`

const SCRIPT_TEMPLATE_SIGN = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$provider = New-Object System.Security.Cryptography.CngProvider('${PCP_PROVIDER_NAME}')
$signKey = [System.Security.Cryptography.CngKey]::Open('${PCP_SIGN_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
$signRsa = New-Object System.Security.Cryptography.RSACng($signKey)
try {
  $data = [Convert]::FromBase64String('__DATA_B64__')
  $signature = $signRsa.SignData($data, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pss)
  Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; signature = [Convert]::ToBase64String($signature) })
} finally { $signRsa.Clear(); $signKey.Dispose() }
`

const SCRIPT_TEMPLATE_UNWRAP = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$provider = New-Object System.Security.Cryptography.CngProvider('${PCP_PROVIDER_NAME}')
$wrapKey = [System.Security.Cryptography.CngKey]::Open('${PCP_WRAP_KEY_NAME}', $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
$wrapRsa = New-Object System.Security.Cryptography.RSACng($wrapKey)
try {
  $wrapped = [Convert]::FromBase64String('__WRAPPED_B64__')
  $secret = $wrapRsa.Decrypt($wrapped, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
  $temp = Join-Path '__TEMP_DIR__' 'unwrap.out'
  [System.IO.File]::WriteAllBytes($temp, $secret)
  [Array]::Clear($secret, 0, $secret.Length)
  Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; out = $temp })
} finally { $wrapRsa.Clear(); $wrapKey.Dispose() }
`

const SCRIPT_TEMPLATE_DESTROY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$provider = New-Object System.Security.Cryptography.CngProvider('${PCP_PROVIDER_NAME}')
$removed = @()
foreach ($name in @('${PCP_SIGN_KEY_NAME}', '${PCP_WRAP_KEY_NAME}')) {
  $existed = [System.Security.Cryptography.CngKey]::Exists($name, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
  if ($existed) {
    $opened = [System.Security.Cryptography.CngKey]::Open($name, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::UserKey)
    try { $opened.Delete() } finally { $opened.Dispose() }
    $removed += $name
  }
}
Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; removed = $removed.Count })
`

/** 用一段仅含 ASCII 安全字符的占位替换装配脚本，避免注入与编码问题。 */
export function fillScript(template: string, replacements: Record<string, string>): string {
  let script = template
  for (const [token, value] of Object.entries(replacements)) {
    if (!/^[A-Za-z0-9_+/=-]*$/.test(value) && token !== '__TEMP_DIR__') {
      throw new LicenseError('DEVICE_TOOL_ERROR', '脚本参数包含非法字符')
    }
    script = script.replaceAll(token, value)
  }
  return script
}

function rsaPublicXmlToSpkiBase64Url(xml: string): string {
  const { modulus, exponent } = parseRsaPublicXml(xml)
  // 就地构造 SPKI DER：模数在前、指数在后。
  const der = buildSpkiDer(modulus, exponent)
  return encodeBase64Url(der)
}

// 极小 DER 构造器（与协议包 spkiFromRsaComponents 一致；此处独立实现避免协议包依赖方向混乱）。
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x100) return Buffer.from([0x81, length])
  return Buffer.from([0x82, length >> 8, length & 0xff])
}
function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}
function buildSpkiDer(modulus: Buffer, exponent: Buffer): Buffer {
  const int = (value: Buffer): Buffer => {
    const padded = value[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value
    return derTag(0x02, padded)
  }
  const rsaOid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])
  const alg = derTag(0x30, Buffer.concat([rsaOid, Buffer.from([0x05, 0x00])]))
  const keySeq = derTag(0x30, Buffer.concat([int(modulus), int(exponent)]))
  const bitString = Buffer.concat([Buffer.from([0x00]), keySeq])
  return derTag(0x30, Buffer.concat([alg, derTag(0x03, bitString)]))
}

export class WindowsPcpDeviceAdapter implements DeviceKeyAdapter {
  readonly keySource = 'tpm-pcp' as const

  async probe(): Promise<DeviceProbeResult> {
    try {
      const output = await runPcpScript(SCRIPT_TEMPLATE_PROBE)
      if (!output.ok) throw pcpFailure(output, 'DEVICE_PROBE_FAILED')
      const signExists = output.signExists === true
      const wrapExists = output.wrapExists === true
      return {
        available: true,
        detail:
          signExists && wrapExists
            ? 'PCP 可用，设备密钥已存在'
            : signExists || wrapExists
              ? 'PCP 可用，但设备密钥只有一把（状态异常）'
              : 'PCP 可用，设备密钥尚未创建'
      }
    } catch (error) {
      if (error instanceof LicenseError) throw error
      return {
        available: false,
        detail: `PCP 不可用：${String((error as Error).message).slice(0, 200)}`
      }
    }
  }

  async createDeviceKeys(): Promise<void> {
    const output = await runPcpScript(SCRIPT_TEMPLATE_CREATE)
    if (!output.ok) throw pcpFailure(output, 'DEVICE_KEY_CREATION_FAILED')
  }

  async readPublicKeys(): Promise<DevicePublicKeys> {
    const output = await runPcpScript(SCRIPT_TEMPLATE_PUBLIC)
    if (!output.ok) throw pcpFailure(output, 'DEVICE_KEY_MISSING')
    const signSpki = Buffer.from(rsaPublicXmlToSpkiBase64Url(output.signXml as string), 'base64url')
    const wrapSpki = Buffer.from(rsaPublicXmlToSpkiBase64Url(output.wrapXml as string), 'base64url')
    const ekHash = typeof output.ekHash === 'string' && /^[0-9a-f]{64}$/.test(output.ekHash) ? output.ekHash : null
    return {
      signPublicKey: encodeBase64Url(signSpki),
      wrapPublicKey: encodeBase64Url(wrapSpki),
      ekPublicKeyHash: ekHash,
      keySource: this.keySource,
      deviceSummary: deviceSummaryFromSpki(signSpki, wrapSpki)
    }
  }

  async attestChallenge(input: {
    challengeId: string
    nonceBase64Url: string
    wrappedSecretBase64Url: string
  }): Promise<DeviceAttestationResult> {
    const hmacMessage = buildProofMessage('proofHmac', input.challengeId, input.nonceBase64Url)
    const signMessage = buildProofMessage('proofSign', input.challengeId, input.nonceBase64Url)
    const script = fillScript(SCRIPT_TEMPLATE_ATTEST, {
      __WRAPPED_B64__: Buffer.from(decodeBase64Url(input.wrappedSecretBase64Url)).toString('base64'),
      __HMAC_MESSAGE_B64__: hmacMessage.toString('base64'),
      __SIGN_MESSAGE_B64__: signMessage.toString('base64')
    })
    const output = await runPcpScript(script)
    if (!output.ok) throw pcpFailure(output, 'DEVICE_UNWRAP_FAILED')
    return {
      secretHmac: encodeBase64Url(Buffer.from(output.hmac as string, 'base64')),
      challengeSignature: encodeBase64Url(Buffer.from(output.signature as string, 'base64'))
    }
  }

  async sign(data: Uint8Array): Promise<string> {
    const script = fillScript(SCRIPT_TEMPLATE_SIGN, {
      __DATA_B64__: Buffer.from(data).toString('base64')
    })
    const output = await runPcpScript(script)
    if (!output.ok) throw pcpFailure(output, 'DEVICE_SIGN_FAILED')
    return encodeBase64Url(Buffer.from(output.signature as string, 'base64'))
  }

  async unwrap(wrapped: Uint8Array): Promise<Buffer> {
    // OAEP 明文不能走 JSON 往返（二进制），经用户临时目录文件交接并立即清理。
    const tempDir = mkdtempSync(join(tmpdir(), 'cs-unwrap-'))
    try {
      const script = fillScript(SCRIPT_TEMPLATE_UNWRAP, {
        __WRAPPED_B64__: Buffer.from(wrapped).toString('base64'),
        __TEMP_DIR__: tempDir
      })
      const output = await runPcpScript(script)
      if (!output.ok) throw pcpFailure(output, 'DEVICE_UNWRAP_FAILED')
      const outPath = output.out as string
      const secret = await readFile(outPath)
      await rm(outPath, { force: true })
      return secret
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async destroyDeviceKeys(): Promise<void> {
    const output = await runPcpScript(SCRIPT_TEMPLATE_DESTROY)
    if (!output.ok) throw pcpFailure(output, 'DEVICE_TOOL_ERROR')
  }
}

/**
 * 直接验证一段 K_sign 签名是否匹配给定设备公钥（激活时本机持有验证用）。
 */
export function verifyDeviceSignatureLocally(input: {
  signPublicKey: string
  message: Uint8Array
  sigBase64Url: string
}): boolean {
  return rsaPssSha256Verify({
    signPublicKey: input.signPublicKey,
    message: Buffer.from(input.message),
    sig: input.sigBase64Url
  })
}
