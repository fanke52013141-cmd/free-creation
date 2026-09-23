import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const canvasPage = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/pages/CanvasPage.tsx'),
  'utf8'
)
const canvasEditor = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/CanvasEditor.tsx'),
  'utf8'
)

describe('canvas theme', () => {
  it('keeps the canvas on dark mode and removes the theme-switch control', () => {
    expect(canvasPage).toContain('className="canvas-page canvas-theme-dark"')
    expect(canvasPage).not.toContain('onThemeChange')
    expect(canvasEditor).toContain('canvas-theme-dark')
    expect(canvasEditor).not.toContain('切换为浅色画布')
    expect(canvasEditor).not.toContain("const next = canvasTheme === 'dark' ? 'light' : 'dark'")
  })
})
