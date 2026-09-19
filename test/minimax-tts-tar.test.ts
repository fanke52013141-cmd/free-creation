// MiniMax 异步语音合成产物的 tar 解包验收。
//
// 守的是一条真实链路：2026-09-19 用真 Key 跑 t2a_async_v2，下载到的不是音频而是
// `application/x-tar`（成员 content-*.mp3 / .extra / .titles）。旧实现把整个归档按
// .mp3 落盘，节点上得到的是一个播不出声的假音频。这里既要证明解包正确，也要证明
// 我们造的归档本身是合法 ustar——用系统 tar 独立读一遍，避免「自己写自己解」的自证。
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { looksLikeTar, pickAudioFromTar } from '../src/main/media/tar-audio'

const probe = promisify(execFile)

const BLOCK = 512

interface Member {
  name: string
  /** ustar 的目录前缀字段：真实产物的成员名长到会拆分进这里，必须一起覆盖。 */
  prefix?: string
  typeFlag?: string
  body?: Buffer
}

function header(member: Member): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(member.name.slice(0, 100), 0, 'utf8')
  block.write('0000600\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(`${(member.body?.length ?? 0).toString(8).padStart(11, '0')}\0`, 124)
  block.write('04444444 \0', 136)
  block.write(member.typeFlag ?? '0', 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  if (member.prefix) block.write(member.prefix.slice(0, 155), 345, 'utf8')
  // 校验和字段在求和期间必须按空格计，否则任何独立实现（系统 tar）都不认这份归档。
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

function buildTar(members: Member[]): Buffer {
  const parts: Buffer[] = []
  for (const member of members) {
    parts.push(header(member))
    const body = member.body ?? Buffer.alloc(0)
    if (body.length) {
      const pad = Math.ceil(body.length / BLOCK) * BLOCK - body.length
      parts.push(body, Buffer.alloc(pad))
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

const DIR = 'canvas-tts-demo_202609191550_1234567890_1234567891'
/** 内容只要求长度真实，解包不该关心里面是什么。 */
const MP3_BODY = Buffer.from([0x49, 0x44, 0x33, ...Buffer.alloc(52_977, 0x7f)])

let tmpDir = ''

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tts-tar-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('MiniMax 异步合成产物的 tar 解包', () => {
  it('照真实布局取回音频成员，跳过 .extra 与 .titles', () => {
    const tar = buildTar([
      { name: DIR, typeFlag: '5' },
      { prefix: DIR, name: 'content-extra', body: Buffer.from('{"sample_rate":32000}') },
      { prefix: DIR, name: `content-${DIR}.mp3`, body: MP3_BODY },
      { prefix: DIR, name: 'content-titles', body: Buffer.from('今天天气不错') }
    ])
    expect(looksLikeTar(tar)).toBe(true)
    expect(pickAudioFromTar(tar)?.equals(MP3_BODY)).toBe(true)
  })

  it('用系统 tar 独立读一遍：证明这份夹具是合法 ustar，不是自产自解', async () => {
    const tar = buildTar([
      { name: DIR, typeFlag: '5' },
      { prefix: DIR, name: `content-${DIR}.mp3`, body: MP3_BODY },
      { prefix: DIR, name: 'content-titles', body: Buffer.from('x') }
    ])
    const abs = join(tmpDir, 'fixture.tar')
    await writeFile(abs, tar)
    // 相对路径 + cwd：Git Bash 的 GNU tar 会把 `C:\...` 里的冒号当成远程归档写法。
    const { stdout } = await probe('tar', ['-tvf', 'fixture.tar'], { cwd: tmpDir })
    expect(stdout).toContain(`${DIR}/content-${DIR}.mp3`)
    expect(stdout).toContain('52980')
  })

  it('只有非音频成员时返回 null，不把字幕文本当音频落盘', () => {
    const tar = buildTar([
      { prefix: DIR, name: 'content-titles', body: Buffer.from('今天天气不错') },
      { prefix: DIR, name: 'content-extra', body: Buffer.from('{}') }
    ])
    expect(pickAudioFromTar(tar)).toBeNull()
  })

  it('原生音频字节（非 tar）不会被误判成归档', () => {
    const raw = Buffer.concat([Buffer.from([0x49, 0x44, 0x33]), Buffer.alloc(1_200, 9)])
    expect(looksLikeTar(raw)).toBe(false)
    expect(pickAudioFromTar(raw)).toBeNull()
  })

  it('头部长度字段不是数字时返回 null，而不是按猜出来的尺寸切片', () => {
    const tar = buildTar([{ name: 'content.mp3', body: MP3_BODY }])
    tar.write('aaaaaaaaaaaa', 124)
    expect(pickAudioFromTar(tar)).toBeNull()
  })

  // 系统 tar 认这份夹具，所以改一个字节之后不认，正好证明解析器与独立实现同一把尺子。
  it('头部被改写一个字节后校验和对不上，整份归档视为不可信', () => {
    const tar = buildTar([{ prefix: DIR, name: `content-${DIR}.mp3`, body: MP3_BODY }])
    expect(pickAudioFromTar(tar)?.equals(MP3_BODY)).toBe(true)
    tar[10] = 0xff
    expect(pickAudioFromTar(tar)).toBeNull()
  })

  it('归档被截断时在下一个头读不到之前停下，不越界', () => {
    const tar = buildTar([
      { prefix: DIR, name: 'a.mp3', body: Buffer.alloc(1_024, 1) },
      { prefix: DIR, name: 'b.mp3', body: MP3_BODY }
    ])
    expect(pickAudioFromTar(tar)?.length).toBe(1_024)
    expect(pickAudioFromTar(tar.subarray(0, 1_100))).toBeNull()
  })
})
