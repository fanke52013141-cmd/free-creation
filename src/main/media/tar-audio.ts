/**
 * 只读的最小 ustar 解析：从归档里取出音频成员。
 *
 * MiniMax 异步语音合成的下载地址指向的是一个 tar（实测 content-type 为
 * `application/x-tar`，成员是 `content-*.mp3` / `.extra` / `.titles`），真正的音频在
 * 归档里面。直接把它按 `.mp3` 落盘会得到一个改了扩展名的归档：节点播放器打不开，
 * 下游音频节点拿到的全是垃圾字节。这里只实现读这一种容器所需的规则。
 */

const BLOCK = 512
/** 成员名里出现的音频扩展名；与 MINIMAX_FORMATS 及常见容器保持一致。 */
const AUDIO_MEMBER = /\.(mp3|wav|pcm|flac|ogg|m4a|aac)$/i

/** ustar 头的 magic 固定在 257 字节处；拿它当容器指纹，不去猜 URL 后缀。 */
export function looksLikeTar(buf: Buffer): boolean {
  return buf.length >= BLOCK * 2 && buf.toString('ascii', 257, 263).startsWith('ustar')
}

function readCString(buf: Buffer, start: number, end: number): string {
  const slice = buf.subarray(start, end)
  const nul = slice.indexOf(0)
  return (nul >= 0 ? slice.subarray(0, nul) : slice).toString('utf8').trim()
}

function readFieldSize(buf: Buffer, offset: number): number {
  // 八进制字段可以是 NUL 或空格结尾，部分实现还会写 leading zeros；非数字一律按坏头处理。
  const digits = readCString(buf, offset, offset + 12).replace(/[^\d]/g, '')
  const size = digits ? Number.parseInt(digits, 8) : Number.NaN
  return Number.isFinite(size) ? size : -1
}

/** ustar 的校验和把 148..155 这一段按空格计入，与所有独立实现保持一致。 */
function checksumMatches(header: Buffer): boolean {
  const digits = readCString(header, 148, 156).replace(/[^\d]/g, '')
  const stored = digits ? Number.parseInt(digits, 8) : Number.NaN
  if (!Number.isFinite(stored)) return false
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  return sum === stored
}

/**
 * 返回归档里第一个音频成员的字节；没有音频成员返回 null（不退回任意文件，
 * 否则 `.titles` 这种文本会被当成音频落盘）。
 */
export function pickAudioFromTar(buf: Buffer): Buffer | null {
  if (!looksLikeTar(buf)) return null
  let offset = 0
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break // 连续两个零块是归档结尾
    // 校验和对不上说明这份归档不可信（下载被截断或被改写），此时不猜内容。
    if (!checksumMatches(header)) return null
    const name = readCString(header, 0, 100)
    const prefix = header.toString('ascii', 257, 263).startsWith('ustar')
      ? readCString(header, 345, 500)
      : ''
    const fullName = prefix && name ? `${prefix}/${name}` : name || prefix
    const size = readFieldSize(header, 124)
    if (size < 0) return null
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const dataAt = offset + BLOCK
    // 归档被截断：宁可不给产物，也不要落一个残缺的音频让用户以为合成坏了。
    if (dataAt + size > buf.length) return null
    offset = dataAt + Math.ceil(size / BLOCK) * BLOCK
    // 目录（'5'）、PAX 扩展头（'x'/'g'）与长文件名（'L'）都不是我们要的载荷。
    if (size === 0 || typeFlag !== '0') continue
    if (AUDIO_MEMBER.test(fullName)) return Buffer.from(buf.subarray(dataAt, dataAt + size))
  }
  return null
}
