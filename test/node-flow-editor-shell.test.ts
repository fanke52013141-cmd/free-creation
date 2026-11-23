// 节点流编辑页外壳契约（2026-11-23 用户裁决：恢复真·全屏 + 纯黑顶栏，右下角四个按钮全要）。
// 背景：2026-11-11 起编辑页是铺满窗口的全屏页；11-21「弹窗统一」把它并进了 XL 弹窗档
//（96vw×92vh、圆角、统一标题栏），覆盖掉了 11-11「全屏编辑」与 11-16「纯黑顶栏」两条裁决。
// 源码级门禁：防再次被并回弹窗壳；「确实铺满窗口」由 scripts/acceptance/nf-user-walkthrough.cjs 真机断言。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const editorSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/composite/CompositeCanvasEditor.tsx'),
  'utf8'
)
const editorCssSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/composite/composite-editor.css'),
  'utf8'
)
const shellSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/ModalShell.tsx'),
  'utf8'
)
const shellCssSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/modal-shell.css'),
  'utf8'
)
const walkthroughSource = readFileSync(
  resolve(process.cwd(), 'scripts/acceptance/nf-user-walkthrough.cjs'),
  'utf8'
)

describe('节点流编辑页外壳：真·全屏 + 纯黑顶栏', () => {
  it('编辑页走统一壳的全屏档，铺满窗口，而不是 XL 弹窗', () => {
    expect(editorSource).toContain('size="fullscreen"')
    expect(editorSource).not.toContain('size="xl"')
    expect(shellSource).toContain("'s' | 'm' | 'l' | 'xl' | 'fullscreen'")
    expect(shellCssSource).toMatch(
      /\.modal-shell\[data-size='fullscreen'\] \{\s*width: 100vw;\s*height: 100vh;\s*max-width: none;\s*max-height: none;/
    )
  })

  it('全屏档不保留遮罩与模糊（遮罩被完全盖住，留着只会白耗性能）', () => {
    expect(shellSource).toContain("'modal-shell-overlay modal-shell-overlay--fullscreen'")
    expect(shellCssSource).toMatch(
      /\.modal-shell-overlay--fullscreen \{[^}]*padding: 0;[^}]*backdrop-filter: none;/
    )
  })

  it('自有纯黑顶栏（仅显示名称），不显示统一标题栏与右上角 X', () => {
    expect(editorSource).toContain('hideHeader')
    expect(editorSource).toContain('<header className="composite-canvas-topbar">')
    expect(editorSource).toContain('id="composite-canvas-title"')
    // 11-16 用户裁决：整条顶栏纯黑，与窗口右上角按钮同色——样式必须还在。
    expect(editorCssSource).toMatch(/\.composite-canvas-topbar \{[^}]*用户裁决 2026-11-16/)
  })

  it('右下角四个按钮齐全：历史版本 / 保存 / 另存为新版本 / 取消', () => {
    const barStart = editorSource.indexOf('className="nf-action-bar"')
    const barEnd = editorSource.indexOf('{capability && showVersions', barStart)
    expect(barStart).toBeGreaterThan(-1)
    expect(barEnd).toBeGreaterThan(barStart)
    const bar = editorSource.slice(barStart, barEnd)
    for (const label of ['历史版本', '保存', '另存为新版本', '取消']) expect(bar).toContain(label)
    expect(editorCssSource).toMatch(
      /\.nf-action-bar \{\s*position: absolute;\s*right: 16px;\s*bottom: 14px;/
    )
  })

  it('真机走查断言「确实铺满窗口」与自有顶栏（再被并回弹窗壳会直接失败）', () => {
    expect(walkthroughSource).toContain('EDITOR_NOT_FULLSCREEN')
    expect(walkthroughSource).toContain('EDITOR_TOPBAR_MISSING')
    expect(walkthroughSource).toContain("page.locator('#composite-canvas-title')")
  })
})
