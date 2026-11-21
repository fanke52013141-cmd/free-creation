import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('覆盖层点击外部关闭', () => {
  // 2026-11-21 弹窗统一：遮罩关闭语义收敛到 ModalShell（onPointerDown 拦截 +
  // 遮罩自点关闭 + Esc），组件侧断言改为「使用了 ModalShell 的统一关闭通道」。
  const shell = read('src/renderer/src/components/ModalShell.tsx')
  expect(shell).toContain('onPointerDown={(event) => event.stopPropagation()}')
  expect(shell).toContain('if (closeOnOverlay && event.target === event.currentTarget) onClose()')

  it('供应商设置与模型选择器仅在点击各自遮罩时关闭，并拦截画布指针', () => {
    const provider = read('src/renderer/src/gateway/ProviderSettingsPanel.tsx')
    expect(provider).toContain('<ModalShell')
    expect(provider).toContain('bodyClassName="modal-shell-body--flush"')
    // 模型选择器的内嵌遮罩仍是自己的遮罩语义
    expect(provider).toContain('if (event.target === event.currentTarget) setModelPickerOpen(false)')
  })

  it('模型目录隔离遮罩点击，底栏搜索只隔离自身的指针事件', () => {
    const catalog = read('src/renderer/src/gateway/ModelCatalogPanel.tsx')
    const search = read('src/renderer/src/canvas/SearchPalette.tsx')
    expect(catalog).toContain('<ModalShell')
    expect(catalog).toContain('bodyClassName="modal-shell-body--flush"')
    expect(search).toContain('onPointerDown={(event) => stopEventPropagation(event)}')
    expect(search).toContain("document.addEventListener('pointerdown', dismiss, true)")
    expect(search).toMatch(/role="search"\s+aria-label="全局搜索"/)
    expect(search).not.toContain('aria-modal')
  })

  it('确认对话框点击背景按取消处理，导演台背景点击关闭且保持焦点语义', () => {
    const confirm = read('src/renderer/src/components/ConfirmDialog.tsx')
    const director = read('src/renderer/src/canvas/DirectorStudioPanel.tsx')
    expect(confirm).toContain('<ModalShell')
    expect(confirm).toContain('onClose={() => resolve(false)}')
    expect(director).toContain('onPointerDown={(event) => event.stopPropagation()}')
    expect(director).toContain('if (event.target === event.currentTarget) onClose()')
    expect(director).toContain('previousFocusRef.current?.isConnected')
  })

  it('媒体预览与图像/视频工作台关闭背景点击且不把指针事件交给画布', () => {
    const media = read('src/renderer/src/canvas/NodeCardView.tsx')
    const imageEdit = read('src/renderer/src/nodes/specs/bodies/image-edit.tsx')
    const video = read('src/renderer/src/nodes/specs/bodies/video-transforms.tsx')
    expect(media).toContain('if (event.target === event.currentTarget) setPreview(null)')
    // P 图 / 视频工作台：遮罩关闭交给 ModalShell（closeOnOverlay 默认开启）
    expect(imageEdit).toContain('<ModalShell')
    expect(imageEdit).toContain('className="image-edit-workbench"')
    expect(video).toContain('<ModalShell')
    expect(video).toContain('className="video-operations-dialog"')
    expect(video).toContain('hideHeader')
  })
})
