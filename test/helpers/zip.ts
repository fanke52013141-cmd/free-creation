// 测试用最小 zip 读取器（仅 local file header + deflate/store）。
//
// 背景：vitest jsdom 环境下 adm-zip（经 browser 条件解析）解压返回空数据，
// 而应用导出的 bundle 结构固定且无 zip64；用 Node zlib 手工解析稳定可靠。
import { inflateRawSync } from 'zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const LOCAL_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const CENTRAL_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02])

/** 解析 zip 内全部文件条目；并校验存在中央目录（基本 zip 有效性）。 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  if (!buf.subarray(0, 4).equals(LOCAL_SIG)) throw new Error('不是有效的 zip 文件')
  if (buf.indexOf(CENTRAL_SIG) < 0) throw new Error('zip 缺少中央目录')
  const entries: ZipEntry[] = []
  let idx = buf.indexOf(LOCAL_SIG)
  while (idx >= 0) {
    const method = buf.readUInt16LE(idx + 8)
    const csize = buf.readUInt32LE(idx + 18)
    const nameLen = buf.readUInt16LE(idx + 26)
    const extraLen = buf.readUInt16LE(idx + 28)
    const name = buf.slice(idx + 30, idx + 30 + nameLen).toString('utf-8')
    const dataStart = idx + 30 + nameLen + extraLen
    const compressed = buf.subarray(dataStart, dataStart + csize)
    entries.push({
      name,
      data: method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed)
    })
    idx = buf.indexOf(LOCAL_SIG, dataStart + csize)
  }
  return entries
}
