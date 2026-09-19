// 文件节点的文档正文抽取（用户 2026-09-18 需求：Excel / Word / PDF 导入后要能直接喂给下游文本）。
// 样张字节放在 test/helpers/document-fixtures.ts，与真实导入链路共用同一份。
import { describe, expect, it } from 'vitest'
import { extractDocumentText } from '../src/main/media/document-text'
import {
  DOCX,
  DOCX_TEXT,
  PPTX,
  PPTX_TEXT,
  XLSX,
  XLSX_TEXT,
  cjkPdf,
  imageOnlyPdf,
  latinPdf,
  zipPackage
} from './helpers/document-fixtures'

describe('Office 文档正文抽取', () => {
  it('Word：一段一行，实体还原，空段不产出空行', async () => {
    expect(await extractDocumentText('.docx', DOCX)).toBe(DOCX_TEXT)
  })

  it('Excel：工作表名成标题，共享字符串还原，空列占位保持列对齐', async () => {
    expect(await extractDocumentText('.xlsx', XLSX)).toBe(XLSX_TEXT)
  })

  it('PPT：按幻灯片序号分页输出', async () => {
    expect(await extractDocumentText('.pptx', PPTX)).toBe(PPTX_TEXT)
  })

  it('旧版二进制格式不抽取（节点据此如实显示"不解析"）', async () => {
    expect(await extractDocumentText('.doc', DOCX)).toBe('')
  })

  it('坏包与空缓冲只返回空串，不把导入流程带崩', async () => {
    expect(await extractDocumentText('.docx', Buffer.from('not a zip'))).toBe('')
    expect(await extractDocumentText('.docx', Buffer.alloc(0))).toBe('')
    expect(
      await extractDocumentText('.xlsx', zipPackage({ 'xl/workbook.xml': '<workbook/>' }))
    ).toBe('')
  })
})

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
