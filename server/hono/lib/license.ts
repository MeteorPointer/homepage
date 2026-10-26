// License JWT 签发与吊销。详见 docs/mod-authorization.md
//
// 算法固定 RS256：模组端用 JDK 内置的 SHA256withRSA 即可验签，
// 不必为了 ML-DSA 之类的算法去打包额外依赖。
import { base64UrlEncode, encodeUtf8 } from './crypto'
import type { Env } from '../types'

export interface LicenseClaims {
  iss: string
  aud: 'nsuk-mod'
  sub: string
  jti: string
  iat: number
  /** 建议客户端开始后台续期的时间；网络失败不影响使用到 exp */
  refresh_after: number
  /** 包含离线宽限的绝对硬截止时间 */
  exp: number
  mod_id: 'simukraft'
  license_version: 2 | 3
  install_id: string
  credential_version: number
  /** v3：License 与官网登记的最终 JAR 构建绑定。 */
  build_id?: string
  artifact_sha256?: string
  minecraft_version?: string
  mod_version?: string
  entitlements: string[]
  tier: string
  name: string
}

export interface LicensePublicKey {
  kid: string
  kty: 'RSA'
  alg: 'RS256'
  use: 'sig'
  n: string
  e: string
}

export class LicenseError extends Error {
  constructor(
    message: string,
    readonly code = 'LICENSE_ERROR',
  ) {
    super(message)
    this.name = 'LicenseError'
  }
}

/** PEM → CryptoKey。私钥格式为 PKCS#8 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')

  if (!body) throw new LicenseError('签名私钥为空', 'NO_KEY')

  const binary = atob(body)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  return crypto.subtle.importKey(
    'pkcs8',
    bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign'],
  )
}

function keyId(env: Env): string {
  return String(env.MOD_LICENSE_KEY_ID || 'nsuk-rs256-1').trim() || 'nsuk-rs256-1'
}

/** 返回与当前私钥对应的公开 JWK；只含 RSA 公钥参数 n/e。 */
export async function licensePublicKey(env: Env): Promise<LicensePublicKey> {
  const pem = env.MOD_LICENSE_PRIVATE_KEY
  if (!pem) throw new LicenseError('未配置 License 签名私钥', 'NOT_CONFIGURED')
  const jwk = await crypto.subtle.exportKey('jwk', await importPrivateKey(pem))
  if (!jwk.n || !jwk.e) throw new LicenseError('无法导出 License 公钥', 'INVALID_KEY')
  return {
    kid: keyId(env),
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
    n: jwk.n,
    e: jwk.e,
  }
}

export async function signLicense(env: Env, claims: LicenseClaims): Promise<string> {
  const pem = env.MOD_LICENSE_PRIVATE_KEY
  if (!pem) throw new LicenseError('未配置 License 签名私钥', 'NOT_CONFIGURED')

  const key = await importPrivateKey(pem)

  const header = base64UrlEncode(
    encodeUtf8(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyId(env) })),
  )
  const payload = base64UrlEncode(encodeUtf8(JSON.stringify(claims)))
  const signingInput = `${header}.${payload}`

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encodeUtf8(signingInput))
  return `${signingInput}.${base64UrlEncode(sig)}`
}

// ─── 吊销名单 ───

/**
 * 把 jti 加入吊销名单。TTL 设为 License 的剩余寿命 ——
 * 令牌自然过期之后名单里再留着它没有意义，白占 KV。
 */
export async function revokeJti(kv: KVNamespace, jti: string, expiresAt: number): Promise<void> {
  const ttl = Math.max(60, expiresAt - Math.floor(Date.now() / 1000))
  await kv.put(`license:revoked:${jti}`, '1', { expirationTtl: ttl })
}

export async function isJtiRevoked(kv: KVNamespace, jti: string): Promise<boolean> {
  return (await kv.get(`license:revoked:${jti}`)) !== null
}
