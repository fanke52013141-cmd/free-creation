// 文本文件解码：中文素材不一定来自 UTF-8。Windows 记事本「ANSI」保存即 GBK，
// PowerShell 的 Out-File/重定向默认 UTF-16LE，按 utf-8 硬读会得到一串 U+FFFD，
// 文档解析节点于是把乱码原样喂给下游模型。
//
// 判定顺序是「BOM → 严格 UTF-8 → GBK」：纯 ASCII 同时是合法的 UTF-8 与 GBK，
// 先按 UTF-8 判定才能保证正常文件一个字节都不被改动。缺 legacy 编码数据的运行环境
// 构造 TextDecoder('gbk') 会抛，此时退回原有的有损解码——宁可乱码也不让导入失败。

function decode(buf: Buffer, label: string, options?: TextDecoderOptions): string | null {
  try {
    return new TextDecoder(label, options).decode(buf)
  } catch {
    return null
  }
}

/** 去掉 BOM 后按对应编码解码；无 BOM 时返回 null。 */
function decodeWithBom(buf: Buffer): string | null {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return decode(buf.subarray(2), 'utf-16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return decode(buf.subarray(2), 'utf-16be')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return decode(buf.subarray(3), 'utf-8')
  return null
}

export function decodeTextFile(buf: Buffer): string {
  const withBom = decodeWithBom(buf)
  if (withBom !== null) return withBom
  // fatal 模式让非法 UTF-8 序列直接抛错，而不是悄悄替换成 U+FFFD——抛错才轮得到 GBK。
  const utf8 = decode(buf, 'utf-8', { fatal: true })
  if (utf8 !== null) return utf8
  return decode(buf, 'gbk') ?? buf.toString('utf-8')
}
