import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

const crop = read('src/renderer/src/nodes/specs/bodies/image-crop.tsx')
const imageGen = read('src/renderer/src/nodes/specs/bodies/image-gen.tsx')
const imageEdit = read('src/renderer/src/nodes/specs/bodies/image-edit.tsx')
const video = read('src/renderer/src/nodes/specs/bodies/video-transforms.tsx')
const styles = read('src/renderer/src/nodes/specs/bodies/node-workbench.css')

describe('处理工作台交互', () => {
  it('裁剪预览填满可用区域，且指针和选区都映射回原图归一化坐标', () => {
    expect(crop).toContain('const cropPreviewMapping')
    expect(crop).toContain('cropPreviewMapping.offsetX')
    expect(crop).toContain('cropPreviewMapping.scaleX')
    expect(crop).not.toContain('height: `${containerSize.h}px`')
    expect(styles).toContain('.crop-inline-preview .crop-inline-canvas')
    expect(styles).toContain('width: 100%;')
    expect(styles).toContain('height: 100%;')
    expect(styles).toContain('overflow: hidden;')
  })

  it('生图画幅优先展示竖屏和横屏常用比例，其余能力仍保留', () => {
    const priority = imageGen.indexOf("'9:16'")
    expect(priority).toBeGreaterThan(-1)
    expect(priority).toBeLessThan(imageGen.indexOf("'16:9'"))
    expect(imageGen.indexOf("'16:9'")).toBeLessThan(imageGen.indexOf("'1:1'"))
    expect(imageGen).toContain('function orderedImageRatios')
    expect(imageGen).toContain('orderedRatios.map')
  })

  it('P 图提交后关闭工作台，视频工作台先保存配置再交给统一运行器', () => {
    expect(imageEdit).toContain('if (workbench) onRunSubmitted?.()')
    expect(imageEdit).toContain('onRunSubmitted={onClose}')
    expect(video).toContain('const submitAndRun')
    expect(video).toContain('commit()')
    expect(video).toContain('window.setTimeout(() =>')
    expect(video).toContain('void runNodeManually(editor, project.id, providers, shape.id)')
    expect(video).toContain('onRunSubmitted={onClose}')
    expect(video).toContain("isFrame ? '开始抽帧' : isClip ? '截取视频'")
  })

  it('两个工作台均允许点击遮罩背景关闭', () => {
    for (const source of [imageEdit, video]) {
      expect(source).toContain('if (event.target === event.currentTarget) onClose()')
      expect(source).toContain('onPointerDown={(event) => stopEventPropagation(event)}')
    }
  })
})
