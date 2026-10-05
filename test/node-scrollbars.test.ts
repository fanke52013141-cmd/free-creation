import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const stylesheet = read('src/renderer/src/assets/scrollbars.css')
describe('全局隐藏滚动条规则', () => {
  it('应用入口加载公共规则，未来区域自动继承', () => {
    expect(read('src/renderer/src/main.tsx')).toContain("import './assets/scrollbars.css'")
    expect(stylesheet).toMatch(/\*\s*\{/)
    expect(stylesheet).toContain('scrollbar-width: none !important')
    expect(stylesheet).toContain('scrollbar-gutter: auto !important')
    expect(stylesheet).toContain('*::-webkit-scrollbar')
    expect(stylesheet).toContain('display: none !important')
  })
  it('保留 overflow 和交互，不再创建可见阅读滑块', () => {
    expect(stylesheet).not.toMatch(/\boverflow(?:-x|-y)?\s*:/)
    expect(stylesheet).not.toContain('pointer-events: none')
    expect(read('src/renderer/src/canvas/NodePresentation.tsx')).not.toContain('NodeReadingScrollbar')
  })
})
