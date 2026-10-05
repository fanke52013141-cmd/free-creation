import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const minimapSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/CanvasMinimap.tsx'),
  'utf8'
)
const nodeCardSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/NodeCardView.tsx'),
  'utf8'
)
const nodePortLayoutSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/node-port-layout.ts'),
  'utf8'
)
const canvasEditorSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/CanvasEditor.tsx'),
  'utf8'
)
const foundationSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/ui-foundation.css'),
  'utf8'
)
describe('canvas interaction details', () => {
  it('shows the minimap from its own trigger or panel, then dismisses it on pointer leave', () => {
    expect(minimapSource).toContain('onPointerEnter={revealMinimap}')
    expect(minimapSource).toContain('onPointerLeave={hideMinimapSoon}')
    expect(minimapSource).toContain('}, 100)')
    expect(minimapSource).not.toContain('setShowMap((v) => !v)')
  })

  it('lets connector dots follow the pointer within a bounded outer semicircle', () => {
    expect(nodeCardSource).toContain('const radius = 16')
    expect(nodeCardSource).toContain('portFollowRef.current')
    expect(nodeCardSource).toContain('portCenter(e, portKey)')
    expect(foundationSource).toContain(
      'translate(var(--port-follow-x, 0), var(--port-follow-y, 0))'
    )
  })

  it('removes the canvas focus rule and the default multi-selection handles', () => {
    expect(foundationSource).toContain('border-bottom: 0 !important;')
    expect(foundationSource).toContain('.canvas-host .tl-container,')
    // Single-node manual sizing is required; the custom foreground keeps multi-select controls off.
    expect(canvasEditorSource).toContain('SelectionForeground: NodeSelectionForeground')
  })

  it('shows one connector per distinct input/output type and merges repeated same-type ports', () => {
    expect(nodeCardSource).toContain('const visibleInPorts = inLayout.ports')
    expect(nodeCardSource).toContain('const visibleOutPorts = outLayout.ports')
    // 动态端口（forced）先行剔除，其余按类型合并；forced 各自独立锚点（见 node-ui-decisions）。
    expect(nodePortLayoutSource).toContain(
      'const groupTypes = [...new Set(grouped.map((port) => port.type))]'
    )
    expect(nodePortLayoutSource).toContain(
      'const sameType = grouped.filter((port) => port.type === type)'
    )
    expect(nodeCardSource).toContain("['--pc' as string]: inputColor")
    expect(nodeCardSource).toContain("['--node-port-color' as string]: inputColor")
    expect(foundationSource).toContain('.port-dot.unconnected {\n  opacity: 1;')
    expect(foundationSource).not.toContain('.port-dot.input-missing::after')
  })
})
