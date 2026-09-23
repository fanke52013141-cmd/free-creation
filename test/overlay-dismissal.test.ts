import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('覆盖层点击外部关闭', () => {
  it('供应商设置与模型选择器仅在点击各自遮罩时关闭，并拦截画布指针', () => {
    const provider = read('src/renderer/src/gateway/ProviderSettingsPanel.tsx')
    expect(provider).toContain('onPointerDown={(event) => stopEventPropagation(event)}')
    expect(provider).toContain('if (event.target === event.currentTarget) close()')
    expect(provider).toContain('if (event.target === event.currentTarget) setModelPickerOpen(false)')
  })

  it('模型目录和搜索面板不会把遮罩点击透传给画布', () => {
    const catalog = read('src/renderer/src/gateway/ModelCatalogPanel.tsx')
    const search = read('src/renderer/src/canvas/SearchPalette.tsx')
    expect(catalog).toContain('onPointerDown={(event) => stopEventPropagation(event)}')
    expect(catalog).toContain('event.target === event.currentTarget) close()')
    expect(search).toContain('stopEventPropagation(e)')
    expect(search).toContain('role="dialog" aria-modal="true" aria-label="搜索节点"')
  })

  it('确认对话框点击背景按取消处理，导演台背景点击关闭且保持焦点语义', () => {
    const confirm = read('src/renderer/src/components/ConfirmDialog.tsx')
    const director = read('src/renderer/src/canvas/DirectorStudioPanel.tsx')
    expect(confirm).toContain('onPointerDown={(e) => e.stopPropagation()}')
    expect(confirm).toContain('if (e.target === e.currentTarget) resolve(false)')
    expect(director).toContain('onPointerDown={(event) => event.stopPropagation()}')
    expect(director).toContain('if (event.target === event.currentTarget) onClose()')
    expect(director).toContain('previousFocusRef.current?.isConnected')
  })

  it('媒体预览与图像/视频工作台关闭背景点击且不把指针事件交给画布', () => {
    const media = read('src/renderer/src/canvas/NodeCardView.tsx')
    const imageEdit = read('src/renderer/src/nodes/specs/bodies/image-edit.tsx')
    const video = read('src/renderer/src/nodes/specs/bodies/video-transforms.tsx')
    expect(media).toContain('if (event.target === event.currentTarget) setPreview(null)')
    for (const source of [imageEdit, video]) {
      expect(source).toContain('onPointerDown={(event) => stopEventPropagation(event)}')
      expect(source).toContain('stopEventPropagation(event)')
      expect(source).toContain('if (event.target === event.currentTarget) onClose()')
    }
  })
})
