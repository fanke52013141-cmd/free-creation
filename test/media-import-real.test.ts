// 真实导入链路验收：把样张文件写到磁盘上，跑真正的 importMedia。
//
// document-text.test.ts 证明解析器认这些字节，但解析器不是链路的全部：扩展名→kind→白名单、
// 复制进项目媒体目录、SQLite 索引、以及「正文只在导入时抽取一次并写进 asset.textContent」这条
// 约定此前从没跑过（`importMedia` 在测试里一次都没被调用过）。文件节点的 out-text 与预览都只读
// 这一份结果，所以这条链路断了就是「拖进去一个 Word，下游拿不到文本」。
//
// 只 mock 数据目录与 SQLite（真库里插测试数据没意义），文件读写、adm-zip、unpdf 都是真的。
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DOCX,
  DOCX_TEXT,
  PPTX,
  PPTX_TEXT,
  XLSX,
  XLSX_TEXT,
  cjkPdf,
  imageOnlyPdf,
  latinPdf
} from './helpers/document-fixtures'

const h = vi.hoisted(() => ({
  dataDir: '',
  srcDir: '',
  rows: [] as Array<{ sql: string; args: unknown[] }>
}))

vi.mock('../src/main/store/db', () => ({
  getDataDir: () => h.dataDir,
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        h.rows.push({ sql, args })
        return { changes: 1 }
      },
      get: () => undefined,
      all: () => []
    })
  })
}))

/** 把一个样张写到「用户磁盘」上，返回绝对路径。 */
async function stage(fileName: string, buf: Buffer): Promise<string> {
  const abs = join(h.srcDir, fileName)
  await writeFile(abs, buf)
  return abs
}

async function importFirst(fileName: string, buf: Buffer) {
  const outcome = await (
    await import('../src/main/store/media.repo')
  ).importMedia('p1', await stage(fileName, buf))
  if (!outcome.ok) throw new Error(`导入失败：${outcome.reason}`)
  return outcome.asset
}

beforeAll(async () => {
  h.dataDir = await mkdtemp(join(tmpdir(), 'canvas-studio-import-data-'))
  h.srcDir = await mkdtemp(join(tmpdir(), 'canvas-studio-import-src-'))
})

afterAll(async () => {
  await rm(h.dataDir, { recursive: true, force: true }).catch(() => undefined)
  await rm(h.srcDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('真实文件导入链路', () => {
  it('Word / Excel / PPT / PDF：导入即抽出正文，文件真的复制进项目媒体目录', async () => {
    const cases = [
      { file: '分镜 草稿.docx', buf: DOCX, text: DOCX_TEXT, ext: '.docx' },
      { file: '角色表.xlsx', buf: XLSX, text: XLSX_TEXT, ext: '.xlsx' },
      { file: '提案.pptx', buf: PPTX, text: PPTX_TEXT, ext: '.pptx' },
      { file: '剧本.pdf', buf: cjkPdf('第一场：雨夜'), text: '第一场：雨夜', ext: '.pdf' }
    ]
    for (const item of cases) {
      const asset = await importFirst(item.file, item.buf)
      expect(asset.kind, item.file).toBe('file')
      expect(asset.textContent, item.file).toBe(item.text)
      // 节点标题用用户给的文件名（去扩展名），媒体路径用随机 ID：中文名与空格不能泄漏进路径。
      expect(asset.name, item.file).toBe(item.file.replace(/\.[a-z]+$/i, ''))
      expect(asset.path.startsWith('projects/p1/media/'), item.file).toBe(true)
      expect(asset.path.endsWith(item.ext), item.file).toBe(true)
      const copied = await readFile(join(h.dataDir, asset.path))
      expect(copied.equals(item.buf), `${item.file} 落盘内容与源文件不一致`).toBe(true)
      const row = h.rows.at(-1)
      expect(row?.sql).toContain('INSERT INTO media')
      expect(row?.args).toEqual([
        asset.id,
        'file',
        asset.mime,
        asset.path,
        asset.sizeBytes,
        expect.any(Number)
      ])
    }
  })

  it('拉丁 PDF 与中文一样走同一条链路，不额外要求外部 cmaps', async () => {
    const asset = await importFirst('scene.pdf', latinPdf(['Scene one', 'Scene two']))
    expect(asset.textContent).toBe('第 1 页\nScene one\n\n第 2 页\nScene two')
  })

  it('纯文本按 utf-8 内联，文件名里的中文与空格不影响落盘路径', async () => {
    const asset = await importFirst('第三 幕.md', Buffer.from('# 天台\n\n雨停了对白', 'utf-8'))
    expect(asset.kind).toBe('file')
    expect(asset.textContent).toBe('# 天台\n\n雨停了对白')
    await expect(readFile(join(h.dataDir, asset.path), 'utf-8')).resolves.toContain('天台')
  })

  it('旧版 .doc 与无文字层扫描件：照常导入，只是没有正文（节点据此显示不解析）', async () => {
    const legacy = await importFirst('旧文档.doc', DOCX)
    expect(legacy.kind).toBe('file')
    expect(legacy.textContent).toBeUndefined()
    const scanned = await importFirst('扫描页.pdf', imageOnlyPdf())
    expect(scanned.kind).toBe('file')
    expect(scanned.textContent).toBeUndefined()
  })

  it('超出体积闸门只跳过抽取，不把导入本身失败掉', async () => {
    // 文本内联上限 1MB、Office/PDF 抽取上限 50MB：超限的原始文件仍然可用，只是不带正文。
    const bigText = await importFirst('大文本.txt', Buffer.from('x'.repeat(1024 * 1024 + 1)))
    expect(bigText.sizeBytes).toBeGreaterThan(1024 * 1024)
    expect(bigText.textContent).toBeUndefined()
    const bigDoc = await importFirst(
      '大表格.xlsx',
      Buffer.concat([XLSX, Buffer.alloc(50 * 1024 * 1024)])
    )
    expect(bigDoc.textContent).toBeUndefined()
    expect(bigDoc.kind).toBe('file')
  })

  it('目录与不认识的扩展名都不会被当成文档', async () => {
    const outcome = await (await import('../src/main/store/media.repo')).importMedia('p1', h.srcDir)
    expect(outcome).toEqual({ ok: false, reason: '不是有效文件' })
    const unknown = await importFirst('工具.bin', Buffer.from([0x00, 0x01, 0x02]))
    expect(unknown.kind).toBe('file')
    expect(unknown.textContent).toBeUndefined()
  })

  it('视频与音频扩展名进的是媒体分类，不会因为抽取失败退化成 file', async () => {
    const clip = await importFirst('空壳.mp4', Buffer.from('ftypmp42', 'latin1'))
    expect(clip.kind).toBe('video')
    expect(clip.textContent).toBeUndefined()
    const voice = await importFirst('口播.wav', Buffer.from('RIFF', 'latin1'))
    expect(voice.kind).toBe('audio')
  })
})
