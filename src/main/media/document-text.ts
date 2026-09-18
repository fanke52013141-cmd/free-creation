// 文档正文抽取：
//   .docx / .xlsx / .pptx —— 本质是 zip + XML，用工程已有的 adm-zip 解包，不额外依赖。
//   .pdf —— 交给 `unpdf`（打包好的 pdf.js）逐页取文字。
// 旧版 .doc/.xls/.ppt 是二进制复合文档，不在解析范围内，文件节点会如实显示"不解析"。
import AdmZip from 'adm-zip'
import { extractText, getDocumentProxy } from 'unpdf'
import { BINARY_DOC_EXTS, OOXML_DOC_EXTS } from '../../shared/mime'

/** 超过这个体积的文档不解包（zip 炸弹与超大表格的兜底闸门）。 */
export const MAX_DOC_BYTES = 50 * 1024 * 1024
/** 抽取正文的字符上限：结果会写进节点 props.text 并随项目持久化。 */
const MAX_DOC_CHARS = 200_000
/** 单次 PDF 抽取的页数上限：页数只影响耗时，截断点在正文里如实标注。 */
const MAX_PDF_PAGES = 300

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 抽取 `<w:t>` / `<t>` / `<a:t>` 之类标签内的文字并按顺序拼接。 */
function textsIn(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1])).join('')
}

/** Word：一个 `</w:p>` 一行；表格单元格本身就以段落承载文字，因此表格会摊平成行。 */
function docxText(xml: string): string {
  return xml
    .split('</w:p>')
    .map((block) => textsIn(block, 'w:t'))
    .filter((line) => line.trim() !== '')
    .join('\n')
}

/** PowerPoint：按 slide 序号顺序，每张幻灯片一段。 */
function pptxText(zip: AdmZip): string {
  return zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .sort(
      (a, b) =>
        Number(/slide(\d+)\.xml$/.exec(a.entryName)?.[1] ?? 0) -
        Number(/slide(\d+)\.xml$/.exec(b.entryName)?.[1] ?? 0)
    )
    .map((entry, index) => {
      const body = entry
        .getData()
        .toString('utf8')
        .split('</a:p>')
        .map((block) => textsIn(block, 'a:t'))
        .filter((line) => line.trim() !== '')
        .join('\n')
      return body ? `第 ${index + 1} 页\n${body}` : ''
    })
    .filter((slide) => slide !== '')
    .join('\n\n')
}

/** 单元格引用（`BC12`）→ 0 基列号，用于还原稀疏行的空列。 */
function columnIndex(ref: string): number {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1] ?? ''
  let index = 0
  for (const char of letters) index = index * 26 + (char.toUpperCase().charCodeAt(0) - 64)
  return letters ? index - 1 : 0
}

function sheetNameEntries(xml: string): string[] {
  return [...xml.matchAll(/<sheet\b[^>]*\sname="([^"]*)"/g)].map((match) => decodeXml(match[1]))
}

function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textsIn(match[1], 't'))
}

/** Excel：`工作表名` 标题 + 每行 `单元格 | 单元格`，与人在表格里读到的顺序一致。 */
function xlsxText(zip: AdmZip): string {
  const read = (name: string): string => {
    const entry = zip.getEntry(name)
    return entry ? entry.getData().toString('utf8') : ''
  }
  const strings = sharedStrings(read('xl/sharedStrings.xml'))
  const titles = sheetNameEntries(read('xl/workbook.xml'))
  const sheets = zip
    .getEntries()
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
    .sort(
      (a, b) =>
        Number(/sheet(\d+)\.xml$/.exec(a.entryName)?.[1] ?? 0) -
        Number(/sheet(\d+)\.xml$/.exec(b.entryName)?.[1] ?? 0)
    )
  return sheets
    .map((entry, index) => {
      const rows = [
        ...entry
          .getData()
          .toString('utf8')
          .matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)
      ]
        .map((row) => {
          const cells: string[] = []
          for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const ref = /r="([A-Za-z]+\d+)"/.exec(cell[1])?.[1] ?? ''
            const type = /t="([^"]*)"/.exec(cell[1])?.[1] ?? ''
            const inner = cell[2] ?? ''
            const value =
              type === 'inlineStr'
                ? textsIn(inner, 't')
                : type === 's'
                  ? (strings[Number(textsIn(inner, 'v'))] ?? '')
                  : textsIn(inner, 'v')
            const column = columnIndex(ref)
            while (cells.length < column) cells.push('')
            cells[column] = value
          }
          while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
          return cells.join(' | ')
        })
        .filter((row) => row.trim() !== '')
      if (!rows.length) return ''
      const title = titles[index] ?? `工作表 ${index + 1}`
      return `${title}\n${rows.join('\n')}`
    })
    .filter((sheet) => sheet !== '')
    .join('\n\n')
}

/** 抽取结果统一收尾：超长即截断，并在正文里留一句能读懂的截断说明。 */
function clampChars(text: string): string {
  return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…（内容已截断）` : text
}

/**
 * PDF 正文：pdf.js 逐页抽取，多页时与 PPT 一样给「第 N 页」标题。
 * `useSystemFonts: false` 让抽取过程完全不读系统字体目录也不执行外部字体代码；
 * `verbosity: 0` 压掉 pdf.js 对每个非嵌入字体的告警。
 * 扫描件没有文字层，抽出来是空串（节点据此显示不解析，而不是假装成功）。
 */
async function pdfText(buf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(buf), {
    useSystemFonts: false,
    verbosity: 0
  })
  try {
    const { text, totalPages } = await extractText(doc, { mergePages: false })
    // 页码按原始页序标注：中间的空页（整页图片）会被跳过，但不能让后面的页跟着错位。
    const pages = text
      .slice(0, MAX_PDF_PAGES)
      .map((page, index) => ({ index, body: page.replace(/[ \t]+\n/g, '\n').trim() }))
      .filter((page) => page.body !== '')
    if (!pages.length) return ''
    const truncated = totalPages > MAX_PDF_PAGES ? `\n…（仅解析前 ${MAX_PDF_PAGES} 页）` : ''
    if (totalPages === 1 && pages.length === 1) return pages[0].body
    return pages.map((page) => `第 ${page.index + 1} 页\n${page.body}`).join('\n\n') + truncated
  } finally {
    // pdf.js 的释放入口在 loadingTask 上；不销毁会留下一个常驻 worker。
    await doc.loadingTask.destroy()
  }
}

/**
 * 抽取文档正文；任何解析失败都返回空串，让导入照常成功（原始文件资产仍然可用）。
 */
export async function extractDocumentText(ext: string, buf: Buffer): Promise<string> {
  if (!BINARY_DOC_EXTS.includes(ext) || buf.length === 0 || buf.length > MAX_DOC_BYTES) return ''
  if (ext === '.pdf') {
    try {
      return clampChars(await pdfText(buf))
    } catch (error) {
      console.warn('extractDocumentText failed:', ext, error)
      return ''
    }
  }
  if (!OOXML_DOC_EXTS.includes(ext)) return ''
  try {
    const zip = new AdmZip(buf)
    const text =
      ext === '.docx'
        ? docxText(zip.getEntry('word/document.xml')?.getData().toString('utf8') ?? '')
        : ext === '.pptx'
          ? pptxText(zip)
          : xlsxText(zip)
    return clampChars(text)
  } catch (error) {
    console.warn('extractDocumentText failed:', ext, error)
    return ''
  }
}
