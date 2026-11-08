/**
 * 授权协议稳定原因码。
 *
 * 这些码会出现在授权窗口、签发工具与诊断日志中，属于对外契约：
 * 只能新增，不能修改或删除既有码的含义。
 */
export type LicenseProtocolErrorCode =
  // 文件层
  | 'FILE_TOO_LARGE'
  | 'NOT_UTF8'
  | 'DUPLICATE_KEY'
  | 'TRAILING_CONTENT'
  | 'JSON_MALFORMED'
  | 'SCHEMA_INVALID'
  // 编码层
  | 'BAD_BASE64URL'
  | 'CANONICALIZE_FAILED'
  | 'UNSUPPORTED_VALUE_TYPE'
  | 'NON_INTEGER_NUMBER'
  // 签名层
  | 'SIGNATURE_INVALID'
  | 'KID_MISMATCH'
  | 'CERT_CHAIN_INVALID'
  | 'CERT_EXPIRED'
  | 'CERT_CAPABILITY_MISSING'
  // 语义层
  | 'TERM_INVALID'
  | 'TIME_OUT_OF_RANGE'
  | 'PRODUCT_MISMATCH'
  | 'VERSION_UNSUPPORTED'
  | 'REQUEST_MISMATCH'
  | 'CHALLENGE_MISMATCH'
  | 'PROOF_INVALID'

export class LicenseProtocolError extends Error {
  readonly code: LicenseProtocolErrorCode

  constructor(code: LicenseProtocolErrorCode, message: string) {
    super(message)
    this.name = 'LicenseProtocolError'
    this.code = code
  }
}
