/**
 * Canvas Studio 离线授权协议包入口。
 *
 * 客户端主进程与签发工具（tools/cs-issuer）共同引用本包，
 * 保证两端的文件 Schema、规范字节与签名算法完全一致。
 */
export * from './errors.ts'
export {
  canonicalBytes,
  canonicalJsonString,
  decodeBase64Url,
  encodeBase64Url,
  parseStrictJson,
  signingInput,
  SIGNING_PURPOSE,
  type JsonValue,
  type SigningPurpose
} from './canonical.ts'
export {
  generateEd25519Key,
  hmacSha256,
  kidFromSpki,
  kidFromSpkiBase64Url,
  safeEqual,
  signWithPurpose,
  verifyWithPurpose
} from './sign.ts'
export {
  RSA_MODULUS_BITS,
  RSA_PSS_SALT_LENGTH,
  parseRsaPublicXml,
  rsaOaepSha256Encrypt,
  rsaPssSha256Verify,
  spkiFromRsaComponents
} from './rsa.ts'
export { buildProofMessage, deviceSummaryFromSpki } from './proof.ts'
export {
  expiresAtForDays,
  generateIssuerKey,
  generateRootKey,
  issueChallenge,
  issueIssuerCert,
  issueLicense,
  issueRevocationPolicy,
  randomUuid,
  validateRequest,
  verifyProof,
  type IssuedChallenge,
  type IssuerSigningKey,
  type IssueLicenseOptions,
  type RootKey
} from './issuer.ts'
export { sealEnvelopePayload, verifyEnvelope } from './verify.ts'
export {
  derivePasswordKey,
  keyPackageSigningInput,
  KDF_PARAMS,
  KEY_PACKAGE_LIMITS,
  KeyPackageConnectionSchema,
  KeyPackageFileSchema,
  KeyPackageHeaderSchema,
  KeyPackagePayloadSchema,
  openKeyPackage,
  originOf,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  ReceiveDeviceCredentialSchema,
  sealKeyPackage,
  validatePasswordPolicy,
  type KeyPackageConnection,
  type KeyPackageFile,
  type KeyPackageHeader,
  type KeyPackagePayload,
  type OpenedKeyPackage,
  type OpenKeyPackageInput,
  type ReceiveDeviceCredential,
  type SealKeyPackageInput,
  type SealedKeyPackage
} from './keypackage.ts'
export {
  DeviceProofSchema,
  DevicePublicKeysSchema,
  DeviceRequestSchema,
  EnvelopeSchema,
  ChallengePayloadSchema,
  ISSUER_CERT_CAPABILITIES,
  IssuerCertPayloadSchema,
  LICENSE_PRODUCT,
  LICENSE_PROTOCOL_VERSION,
  LicenseCapabilitySchema,
  LicensePayloadSchema,
  RevocationPolicyPayloadSchema,
  ROLE_CAPABILITIES,
  FILE_SIZE_LIMITS,
  KidSchema,
  Base64UrlSchema,
  Hex16Schema,
  Hex64Schema,
  KeySourceSchema,
  UtcSecondsSchema,
  UuidSchema,
  parseFileJson,
  type DeviceProof,
  type DevicePublicKeys,
  type DeviceRequest,
  type Envelope,
  type ChallengePayload,
  type IssuerCertCapability,
  type IssuerCertPayload,
  type IssuerRole,
  type Kid,
  type KeySource,
  type LicenseCapability,
  type LicensePayload,
  type RevocationPolicyPayload,
  type TrustedRoot
} from './types.ts'
