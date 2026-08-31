import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/NodeContractPanel.tsx'),
  'utf8'
)
const surfaceSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/ui-surfaces.css'),
  'utf8'
)

describe('节点详情面板', () => {
  it('对话节点不再被排除，所有有 Spec 的节点都可查看真实输入输出', () => {
    expect(panelSource).not.toContain("shape.props.nodeType === 'chat'")
    expect(panelSource).toContain('const ports = getNodePorts(spec, shape)')
  })

  it('在输入输出页提供未连线测试，而不是把测试入口藏在运行页', () => {
    const ioStart = panelSource.indexOf("{tab === 'io' &&")
    const runStart = panelSource.indexOf("{tab === 'run' &&")
    expect(ioStart).toBeGreaterThan(-1)
    expect(runStart).toBeGreaterThan(ioStart)
    expect(panelSource.slice(ioStart, runStart)).toContain('<TestHarness')
    expect(panelSource.slice(runStart)).not.toContain('<TestHarness')
  })

  it('文本测试输入失焦后会回写文本节点，面板本身固定在底部工具条上方滚动', () => {
    expect(panelSource).toContain('onTextInputCommit?.(port, type, event.target.value)')
    expect(panelSource).toContain("markUndoPoint(editor, 'contract-text-input')")
    expect(surfaceSource).toContain('bottom: var(--canvas-bottom-utility-h, 82px)')
    expect(surfaceSource).toContain('flex: 1 1 auto')
  })
})
