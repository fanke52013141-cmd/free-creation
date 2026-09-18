// 文件节点的文档正文抽取（用户 2026-09-18 需求：Excel / Word / PDF 导入后要能直接喂给下游文本）。
// Word / Excel / PPT 是 zip + XML，PDF 是 xref + 内容流——两者都在这里按字节现造，
// 不依赖任何真实办公文档，也不触达磁盘。
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { extractDocumentText } from '../src/main/media/document-text'

function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'))
  }
  return zip.toBuffer()
}

const DOCX = zipOf({
  'word/document.xml': `<?xml version="1.0"?>
<w:document><w:body>
<w:p><w:r><w:t>选题：雨夜</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">第二段 &amp; 符号 &lt;标记&gt;</w:t></w:r></w:p>
<w:p><w:r><w:t></w:t></w:r></w:p>
</w:body></w:document>`
})

const XLSX = zipOf({
  'xl/workbook.xml': `<?xml version="1.0"?>
<workbook><sheets>
<sheet name="角色" sheetId="1" r:id="rId1"/>
<sheet name="场景" sheetId="2" r:id="rId2"/>
</sheets></workbook>`,
  'xl/sharedStrings.xml': `<?xml version="1.0"?>
<sst><si><t>姓名</t></si><si><t>城市</t></si><si><t>小明 &amp; 小红</t></si></sst>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0"?>
<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row>
<row r="3"><c r="A3"/><c r="B3" t="inlineStr"><is><t>内联值</t></is></c></row>
</sheetData></worksheet>`
})

const PPTX = zipOf({
  'ppt/slides/slide1.xml': `<?xml version="1.0"?>
<p:sld><p:cSld><a:tbl><a:tr><a:tc><a:p><a:r><a:t>镜头一：街角</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:cSld></p:sld>`,
  'ppt/slides/slide2.xml': `<?xml version="1.0"?>
<p:sld><p:cSld><a:p><a:r><a:t>镜头二：天台</a:t></a:r></a:p></p:cSld></p:sld>`
})

describe('Office 文档正文抽取', () => {
  it('Word：一段一行，实体还原，空段不产出空行', async () => {
    expect(await extractDocumentText('.docx', DOCX)).toBe('选题：雨夜\n第二段 & 符号 <标记>')
  })

  it('Excel：工作表名成标题，共享字符串还原，空列占位保持列对齐', async () => {
    expect(await extractDocumentText('.xlsx', XLSX)).toBe(
      ['角色', '姓名 | 城市', '小明 & 小红 |  | 42', ' | 内联值'].join('\n')
    )
  })

  it('PPT：按幻灯片序号分页输出', async () => {
    expect(await extractDocumentText('.pptx', PPTX)).toBe(
      '第 1 页\n镜头一：街角\n\n第 2 页\n镜头二：天台'
    )
  })

  it('旧版二进制格式不抽取（节点据此如实显示"不解析"）', async () => {
    expect(await extractDocumentText('.doc', DOCX)).toBe('')
  })

  it('坏包与空缓冲只返回空串，不把导入流程带崩', async () => {
    expect(await extractDocumentText('.docx', Buffer.from('not a zip'))).toBe('')
    expect(await extractDocumentText('.docx', Buffer.alloc(0))).toBe('')
    expect(await extractDocumentText('.xlsx', zipOf({ 'xl/workbook.xml': '<workbook/>' }))).toBe('')
  })
})

// ── PDF：按字节现造合法文件（xref 偏移必须精确，因此逐对象累加 latin1 字节长度）──

function assemblePdf(objects: string[]): Buffer {
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((content, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${content}\nendobj\n`
  })
  const startxref = Buffer.byteLength(body, 'latin1')
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f `,
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `)
  ].join('\n')
  const trailer = `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(body + `${xref}${trailer}`, 'latin1')
}

function streamObject(payload: string): string {
  return `<< /Length ${Buffer.byteLength(payload, 'latin1')} >>\nstream\n${payload}\nendstream`
}

/** Base-14 + WinAnsi literal string：只覆盖拉丁文字，等价于最简导出器。 */
function latinPdf(pages: string[]): Buffer {
  const fontId = 3 + pages.length * 2
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  ]
  pages.forEach((page, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${index * 2 + 4} 0 R ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    )
    objects.push(streamObject(`BT /F1 24 Tf 72 700 Td (${page.replace(/[()\\]/g, '\\$&')}) Tj ET`))
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  return assemblePdf(objects)
}

/**
 * 中文 PDF 的真实形态：Type0 / Identity-H 子集字体 + ToUnicode CMap（UTF-16BE）。
 * 抽取只依赖 ToUnicode，因此不需要 pdf.js 的外部 cmaps 目录——这一条必须有回归测试。
 */
function cjkPdf(text: string): Buffer {
  const chars = [...text]
  const cid = (index: number): string => String(index + 1).padStart(4, '0')
  const hex = chars.map((_, index) => cid(index)).join('')
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${chars.length} beginbfchar`,
    ...chars.map((ch, index) => `<${cid(index)}> <${ch.codePointAt(0)!.toString(16)}>`),
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end'
  ].join('\n')
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R ' +
      '/Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEE+SimSun /Encoding /Identity-H ' +
      '/DescendantFonts [5 0 R] /ToUnicode 7 0 R >>',
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEE+SimSun /CIDSystemInfo ` +
      `<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R ` +
      `/DW 1000 /W [1 ${chars.length} 1000] >>`,
    streamObject(`BT /F1 24 Tf 72 700 Td <${hex}> Tj ET`),
    streamObject(cmap),
    '<< /Type /FontDescriptor /FontName /ABCDEE+SimSun /Flags 4 ' +
      '/FontBBox [-25 -250 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 >>'
  ])
}

/** 只有矢量图形、没有文字层——扫描件在这里的形态。 */
function imageOnlyPdf(): Buffer {
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    streamObject('q 100 100 200 200 re f Q')
  ])
}

describe('PDF 正文抽取（unpdf / pdf.js）', () => {
  it('拉丁文字：多页按页标注页码', async () => {
    expect(await extractDocumentText('.pdf', latinPdf(['Scene one', 'Scene two']))).toBe(
      '第 1 页\nScene one\n\n第 2 页\nScene two'
    )
  })

  it('单页不额外加页码标题', async () => {
    expect(await extractDocumentText('.pdf', latinPdf(['Rainy night']))).toBe('Rainy night')
  })

  it('中文：Identity-H 子集字体靠 ToUnicode 还原，不依赖外部 cmaps', async () => {
    expect(await extractDocumentText('.pdf', cjkPdf('第一场：雨夜，霓虹倒映'))).toBe(
      '第一场：雨夜，霓虹倒映'
    )
  })

  it('无文字层的扫描件抽出空串，节点据此显示不解析', async () => {
    expect(await extractDocumentText('.pdf', imageOnlyPdf())).toBe('')
  })

  it('坏 PDF 只返回空串，不抛出', async () => {
    expect(await extractDocumentText('.pdf', Buffer.from('%PDF-1.4 broken'))).toBe('')
    expect(await extractDocumentText('.pdf', DOCX)).toBe('')
  })
})
