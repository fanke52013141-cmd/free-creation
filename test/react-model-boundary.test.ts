// React 组件只能编辑节点状态或调用统一运行器；模型调用必须留在 executor 内。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(process.cwd(), 'src/renderer/src')
const guardedFiles = [
  'canvas/ChatSidePanel.tsx',
  'nodes/specs/bodies/audio.tsx',
  'nodes/specs/bodies/code.tsx',
  'nodes/specs/bodies/image-gen.tsx',
  'nodes/specs/bodies/script.tsx',
  'nodes/specs/bodies/storyboard.tsx',
  'nodes/specs/bodies/video.tsx'
]

const forbiddenModelCalls =
  /window\.api\.gateway\.(chatStart|chatCancel|imageGenerate|videoSubmit|videoTask|videoCancel|audioGenerate)|\bwaitFor(Chat|Video)\b/

describe('React 与模型执行边界', () => {
  it('节点 UI 和聊天面板不直接调用网关或执行器等待函数', () => {
    for (const relativePath of guardedFiles) {
      const source = readFileSync(resolve(rendererRoot, relativePath), 'utf8')
      expect(source, `${relativePath} 绕过统一 executor`).not.toMatch(forbiddenModelCalls)
    }
  })
})
