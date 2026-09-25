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
    expect(canvasEditorSource).toContain('SelectionForeground: () => null')
  })

  it('keeps every declared input and output port visible before connection', () => {
    expect(nodeCardSource).toContain('const visibleInPorts = inPorts')
    expect(nodeCardSource).toContain('const visibleOutPorts = outPorts')
    expect(nodeCardSource).not.toContain('inPorts.slice(0, 1)')
    expect(nodeCardSource).not.toContain('outPorts.slice(0, 1)')
    expect(nodeCardSource).toContain("['--node-port-color' as string]: nodePortColor")
    expect(foundationSource).toContain('.port-dot.unconnected {\n  opacity: 1;')
    expect(foundationSource).not.toContain('.port-dot.input-missing::after')
  })
})
