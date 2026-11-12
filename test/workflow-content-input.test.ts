import { describe, expect, it } from 'vitest'
import { nodeNeedsContentInput } from '../src/renderer/src/engine/workflow-inputs'

const noSource = (): boolean => false
const sourceOf =
  (...ports: string[]) =>
  (port: string): boolean =>
    ports.includes(port)

describe('内容输入缺口判定（nodeNeedsContentInput）', () => {
  it('text 节点正文为空时需要输入', () => {
    expect(nodeNeedsContentInput('text', '   ', noSource)).toBe(true)
    expect(nodeNeedsContentInput('text', '有内容', noSource)).toBe(false)
  })

  it('ai-process 无 in-json 来源时需要输入', () => {
    expect(nodeNeedsContentInput('ai-process', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('ai-process', '', sourceOf('in-json'))).toBe(false)
  })

  it('image-gen 无正文且无 in-prompt 时需要输入', () => {
    expect(nodeNeedsContentInput('image-gen', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('image-gen', '提示词', noSource)).toBe(false)
    expect(nodeNeedsContentInput('image-gen', '', sourceOf('in-prompt'))).toBe(false)
  })

  it('speech 无正文且无 in-text 时需要输入', () => {
    expect(nodeNeedsContentInput('speech', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('speech', '朗读文本', noSource)).toBe(false)
    expect(nodeNeedsContentInput('speech', '', sourceOf('in-text'))).toBe(false)
  })

  it('chat 无 in-text 来源时需要输入', () => {
    expect(nodeNeedsContentInput('chat', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('chat', '', sourceOf('in-text'))).toBe(false)
  })

  it('其余节点不触发内容缺口', () => {
    expect(nodeNeedsContentInput('image-crop', '', noSource)).toBe(false)
    expect(nodeNeedsContentInput('processor', '', noSource)).toBe(false)
  })
})

describe('内容输入缺口判定 · 新增覆盖节点', () => {
  it('video 无正文且无 in-prompt/in-text 来源 → 需要输入', () => {
    expect(nodeNeedsContentInput('video', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('video', '提示词', noSource)).toBe(false)
    expect(nodeNeedsContentInput('video', '', sourceOf('in-prompt'))).toBe(false)
    expect(nodeNeedsContentInput('video', '', sourceOf('in-text'))).toBe(false)
  })
  it('voice-design 无正文且无 in-text 来源 → 需要输入', () => {
    expect(nodeNeedsContentInput('voice-design', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('voice-design', '描述', noSource)).toBe(false)
    expect(nodeNeedsContentInput('voice-design', '', sourceOf('in-text'))).toBe(false)
  })
  it('json 无正文且无 in-json/in-text 来源 → 需要输入', () => {
    expect(nodeNeedsContentInput('json', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('json', '{"a":1}', noSource)).toBe(false)
    expect(nodeNeedsContentInput('json', '', sourceOf('in-json'))).toBe(false)
  })
  it('storyboard 无正文且无 in-json/in-text 来源 → 需要输入', () => {
    expect(nodeNeedsContentInput('storyboard', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('storyboard', '{"shots":[]}', noSource)).toBe(false)
    expect(nodeNeedsContentInput('storyboard', '', sourceOf('in-json'))).toBe(false)
  })
  it('structured 正文模板为空 → 需要输入', () => {
    expect(nodeNeedsContentInput('structured', '', noSource)).toBe(true)
    expect(nodeNeedsContentInput('structured', '{"name":"x"}', noSource)).toBe(false)
  })
})
