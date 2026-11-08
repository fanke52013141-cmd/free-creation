import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('引用候选菜单单行呈现', () => {
  it('候选按钮只占一行：标题省略、token 固定右侧、超长有 title 兜底', () => {
    const css = read('src/renderer/src/assets/app.css')
    const prompt = read('src/renderer/src/nodes/specs/bodies/ImageMentionPrompt.tsx')
    expect(css).toMatch(/\.ref-mention-menu\s*\{[^}]*flex-direction:\s*column;/)
    expect(css).toMatch(/\.ref-mention-menu\s*\{[^}]*overflow-y:\s*auto;/)
    expect(css).toMatch(/\.ref-mention-menu button\s*\{[^}]*white-space:\s*nowrap;/)
    expect(css).toMatch(
      /\.ref-mention-menu button > span:not\(\.ref-mention-thumb\)\s*\{[^}]*text-overflow:\s*ellipsis;/
    )
    expect(css).toMatch(/\.ref-mention-menu button > small\s*\{[^}]*margin-left:\s*auto;/)
    expect(prompt).toContain('title={item.title || item.name || item.token}')
  })
})
