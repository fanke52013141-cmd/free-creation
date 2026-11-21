// 主页左下角「重载界面」开发工具（2026-11-21 用户裁决：只要重载，不做重启）。
// 源码级门禁：dev 门控、保存冲刷、健康探测、失败诚实提示、诊断事件缺一不可。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const pageSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/pages/ProjectListPage.tsx'),
  'utf8'
)
const cssSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/pages/project-list-page.css'),
  'utf8'
)

describe('主页开发工具「重载界面」', () => {
  it('仅在真实 Electron 开发会话显示（打包版与浏览器验收页都不渲染）', () => {
    expect(pageSource).toContain('import.meta.env.DEV && Boolean(window.api)')
    // 2026-11-21 用户裁决：按钮固定放「新建项目」左侧，标签为「重载」。
    expect(pageSource.indexOf('project-home-dev-reload')).toBeLessThan(
      pageSource.indexOf('project-home-button-primary')
    )
    expect(pageSource).toContain("devReloading ? '重载中…' : '重载'")
  })

  it('重载前冲刷保存协调器，防止未落盘内容丢失', () => {
    expect(pageSource).toContain('useSaveCoordinator.getState().flush()')
  })

  it('先探测开发服务健康：不可达时诚实提示而不是白屏刷新', () => {
    expect(pageSource).toContain(".fetch(window.location.href, { method: 'HEAD'")
    expect(pageSource).toContain('开发服务不可达')
    expect(pageSource).toContain('开发会话已结束，请重新运行 npm run dev 后再试')
  })

  it('重载前冲刷缓冲中的诊断事件（带超时上限，不因 transport 死亡而卡住）', () => {
    expect(pageSource).toContain("event: 'dev.renderer_reload'")
    expect(pageSource).toContain('await Promise.race([')
    expect(pageSource).toContain('drainDiagnosticsEvents()')
    expect(pageSource).toContain("window.setTimeout(() => resolve('timeout'), 1500)")
    expect(pageSource).toContain('window.location.reload()')
  })

  it('样式为顶栏安静按钮 + 虚线边框，标识非正式功能', () => {
    expect(cssSource).toContain('.project-home-dev-reload')
    expect(cssSource).toContain('border-style: dashed')
    expect(cssSource).not.toContain('.project-home-dev-tools')
  })
})
