import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const stylesheet = read('src/renderer/src/canvas/node-scrollbars.css')
const canvasEditor = read('src/renderer/src/canvas/CanvasEditor.tsx')

describe('节点内部滚动条视觉规范', () => {
  it('只影响节点卡片中的内容容器，且画布编辑器明确加载该规则', () => {
    expect(canvasEditor).toContain("import './node-scrollbars.css'")
    expect(stylesheet).toContain('.node-card-wrap :is(')
    expect(stylesheet).not.toMatch(/(^|\n)\s*\*\s*\{/)
    expect(stylesheet).not.toContain('.node-palette')
    expect(stylesheet).not.toContain('.node-menu')
    expect(stylesheet).not.toContain('.csp-messages')
  })

  it('覆盖节点正文、代码/JSON/脚本/分镜与媒体结果，但不修改它们的 overflow', () => {
    for (const selector of [
      '.node-body',
      '.node-text',
      '.json-body',
      '.code-body',
      '.script-body',
      '.storyboard-body',
      '.file-asset-preview',
      '.media-result-grid',
      '.image-edit-workbench-body',
      '.video-trim-workbench-body',
      '.chat-body-compact',
      'textarea',
      "[contenteditable='true']"
    ]) {
      expect(stylesheet).toContain(selector)
    }
    expect(stylesheet).not.toMatch(/\boverflow(?:-x|-y)?\s*:/)
  })

  it('Firefox 与 Chromium 都隐藏视觉轨道，滚轮和键盘滚动仍由已有 overflow 保持', () => {
    expect(stylesheet).toContain('scrollbar-width: none')
    expect(stylesheet).toContain('-ms-overflow-style: none')
    expect(stylesheet).toContain('::-webkit-scrollbar')
    expect(stylesheet).toMatch(/::-webkit-scrollbar\s*\{[\s\S]*?width:\s*0;[\s\S]*?height:\s*0;/)
    expect(stylesheet).not.toContain('pointer-events: none')
  })
})
