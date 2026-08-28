import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('demo bundle', () => {
  it('contains a contract-shaped workflow graph and tldraw bindings', () => {
    const zip = new AdmZip('resources/demo/canvas-studio-demo.canvasbundle')
    const project = JSON.parse(zip.readAsText('project.json')) as {
      nodes: Array<{ id: string; type: string }>
      edges: Array<{ from: { portId: string }; to: { portId: string } }>
      tldrawSnapshot: {
        store: Record<string, { typeName?: string; type?: string; props?: Record<string, unknown> }>
        schema: { sequences: Record<string, number> }
      }
    }

    expect(project.nodes.map((node) => node.type)).toEqual([
      'text',
      'ai-process',
      'storyboard',
      'json',
      'iterate',
      'image'
    ])
    expect(project.edges).toEqual([
      expect.objectContaining({
        from: { nodeId: 'shape:text', portId: 'out-text' },
        to: { nodeId: 'shape:ai', portId: 'in-text' }
      }),
      expect.objectContaining({
        from: { nodeId: 'shape:ai', portId: 'out-json' },
        to: { nodeId: 'shape:storyboard', portId: 'in-json' }
      }),
      expect.objectContaining({
        from: { nodeId: 'shape:list', portId: 'out-json' },
        to: { nodeId: 'shape:iterate', portId: 'in-list' }
      })
    ])

    const records = Object.values(project.tldrawSnapshot.store)
    expect(records.filter((record) => record.type === 'node-card')).toHaveLength(6)
    expect(
      records.filter((record) => record.typeName === 'shape' && record.type === 'arrow')
    ).toHaveLength(3)
    expect(records.filter((record) => record.typeName === 'binding')).toHaveLength(6)
    expect(project.tldrawSnapshot.schema.sequences['com.tldraw.shape.node-card']).toBe(1)
    expect(zip.getEntry('media/demo-image.png')).toBeTruthy()

    const rawBundle = readFileSync('resources/demo/canvas-studio-demo.canvasbundle')
    expect(rawBundle.length).toBeGreaterThan(0)
  })
})
