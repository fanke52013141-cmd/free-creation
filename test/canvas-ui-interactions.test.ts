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
const readinessSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/node-readiness.ts'),
  'utf8'
)

describe('canvas interaction details', () => {
  it('shows the minimap from its own trigger or panel, then dismisses it on pointer leave', () => {
    expect(minimapSource).toContain('onPointerEnter={revealMinimap}')
    expect(minimapSource).toContain('onPointerLeave={hideMinimapSoon}')
    expect(minimapSource).toContain('}, 100)')
    expect(minimapSource).not.toContain('setShowMap((v) => !v)')
  })

  it('keeps connection previews and visible port dots on the same fixed center', () => {
    expect(nodeCardSource).toContain('x: rect.left + rect.width / 2')
    expect(nodeCardSource).toContain('y: rect.top + rect.height / 2')
    expect(nodeCardSource).not.toContain('portFollow')
    expect(foundationSource).not.toContain('var(--port-follow-')
  })

  it('removes the canvas focus rule and the default multi-selection handles', () => {
    expect(foundationSource).toContain('border-bottom: 0 !important;')
    expect(foundationSource).toContain('.canvas-host .tl-container,')
    expect(canvasEditorSource).toContain('SelectionForeground: () => null')
  })

  it('retains the dashed outline only for a required input that is still missing', () => {
    expect(readinessSource).toContain("port.required ? 'missing' : 'optional'")
    expect(foundationSource).toContain('.port-dot.input-missing::after')
    expect(foundationSource).toContain('.port-dot.input-missing.ok::after')
  })
})
