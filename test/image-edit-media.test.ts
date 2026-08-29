import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { renderAnnotatedReference } from '../src/main/media/image-edit'

describe('图片修改标注参考图', () => {
  it('保留源图尺寸并绘制箭头、矩形和文字标注', async () => {
    const sourceCanvas = createCanvas(80, 40)
    const sourceContext = sourceCanvas.getContext('2d')
    sourceContext.fillStyle = '#336699'
    sourceContext.fillRect(0, 0, 80, 40)
    const source = await loadImage(sourceCanvas.toBuffer('image/png'))
    const output = renderAnnotatedReference(source, [
      {
        id: 'arrow',
        type: 'arrow',
        color: 'red',
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.8, y: 0.8 }
        ]
      },
      {
        id: 'rect',
        type: 'rect',
        color: 'yellow',
        points: [
          { x: 0.8, y: 0.8 },
          { x: 0.2, y: 0.2 }
        ]
      },
      {
        id: 'text',
        type: 'text',
        color: 'orange',
        points: [{ x: 0.2, y: 0.8 }],
        text: '修改'
      }
    ])
    const rendered = await loadImage(output)
    expect(rendered.width).toBe(80)
    expect(rendered.height).toBe(40)
    expect(output.byteLength).toBeGreaterThan(0)
    const outputCanvas = createCanvas(rendered.width, rendered.height)
    const outputContext = outputCanvas.getContext('2d')
    outputContext.drawImage(rendered, 0, 0)
    const pixel = outputContext.getImageData(16, 8, 1, 1).data
    expect(pixel[0]).toBeGreaterThan(pixel[2])
  })
})
