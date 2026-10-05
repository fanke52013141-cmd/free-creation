// 节点设置面板规范门禁（docs/NODE_CANVAS_PRESENTATION_SPEC.md §10）
// .settings-field 曾没有全局基线，各节点自定间距导致「有的左右、有的上下、标签贴框」。
// 本门禁锁住：全局基线存在、标签字号统一、hint 唯一权威、节点不得再私有化结构属性。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

const appCss = read('src/renderer/src/assets/app.css')
const uiSurfaces = read('src/renderer/src/assets/ui-surfaces.css')
const specDoc = read('docs/NODE_CANVAS_PRESENTATION_SPEC.md')

describe('节点设置面板规范（§10）', () => {
  it('.settings-field 有全局基线：grid + 6px 标签-控件间距 + 长控件满宽', () => {
    expect(appCss).toMatch(/\.settings-field \{[^}]*display: grid;[^}]*gap: 6px;/)
    expect(appCss).toMatch(
      /\.settings-field > input,\s*\.settings-field > textarea,\s*\.settings-field > select \{\s*width: 100%;/
    )
  })

  it('规范注释块与规范文档章节同时存在，文档不再裸奔', () => {
    expect(appCss).toContain('节点设置面板规范')
    expect(specDoc).toContain('## 10. 节点设置面板规范（2026-10-05，强制）')
  })

  it('标签统一 .opt-label 11px；hint 是 11px muted 且 margin 0（间距由容器 gap 提供）', () => {
    expect(appCss).toMatch(/\.opt-label \{[^}]*font-size: 11px;/)
    expect(appCss).toMatch(/\.contract-settings-hint \{[^}]*margin: 0;[^}]*font-size: 11px;/)
    // 唯一权威：ui-surfaces 不得再定义独立的 hint 基线规则块（浅色主题的 :is() 颜色适配除外）
    expect(uiSurfaces).not.toMatch(/\.contract-settings-hint\s*\{/)
  })

  it('节点不得私有化 settings 字段的结构属性（display/gap/margin）', () => {
    // 此前 website / sound-adjust 各自定义 display:grid + gap，现由全局基线提供
    expect(appCss).not.toMatch(/\.website-settings \.settings-field \{[^}]*gap:/)
    expect(appCss).not.toMatch(/\.sound-adjust-settings \.settings-field \{[^}]*gap:/)
    const bodyDir = 'src/renderer/src/nodes/specs/bodies'
    for (const file of [
      'aiProcess.tsx',
      'chat.tsx',
      'sound-adjust.tsx',
      'video-ai.tsx',
      'website.tsx'
    ]) {
      const source = read(`${bodyDir}/${file}`)
      expect(source, file).not.toMatch(/style=\{[^}]*(gap|margin)/)
    }
  })
})
