import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'

const demoPath = resolve(process.cwd(), 'resources/demo/canvas-studio-demo.canvasbundle')

describe('固定演示项目', () => {
  it('保留完整的端口化创作链路与真实媒体样本', () => {
    const zip = new AdmZip(demoPath)
    const projectEntry = zip.getEntry('project.json')
    expect(projectEntry).toBeTruthy()
    const project = JSON.parse(projectEntry!.getData().toString('utf-8')) as {
      meta: { name: string }
      nodes: Array<{ type: string }>
      edges: Array<{ from: { portId: string }; to: { portId: string } }>
      tldrawSnapshot: {
        store: Record<string, { type?: string; props?: { config?: unknown } }>
      }
    }

    expect(project.meta.name).toBe('Canvas Studio 创作链路演示')
    expect(project.nodes.map((node) => node.type).sort()).toEqual(
      [
        'ai-process',
        'director',
        'image',
        'image-gen',
        'iterate',
        'storyboard',
        'text',
        'video'
      ].sort()
    )
    expect(project.edges).toHaveLength(7)
    expect(project.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: expect.objectContaining({ portId: 'out-text' }),
          to: expect.objectContaining({ portId: 'in-text' })
        }),
        expect.objectContaining({
          from: expect.objectContaining({ portId: 'out-json' }),
          to: expect.objectContaining({ portId: 'in-storyboard' })
        }),
        expect.objectContaining({
          from: expect.objectContaining({ portId: 'out-image' }),
          to: expect.objectContaining({ portId: 'in-reference-images' })
        })
      ])
    )
    for (const record of Object.values(project.tldrawSnapshot.store)) {
      if (record.type !== 'node-card') continue
      expect(typeof record.props.config).toBe('string')
    }
    expect(zip.getEntry('media/demo-reference-image.png')?.getData().byteLength).toBeGreaterThan(0)
  })
})
