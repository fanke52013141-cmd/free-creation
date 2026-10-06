// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { nodeOwnsPointer, nodeTextField } from '../src/renderer/src/canvas/node-pointer-policy'

function element(html: string): Element {
  const root = document.createElement('div')
  root.innerHTML = html
  return root.querySelector('[data-target]')!
}

it('labels and empty containers never inherit control pointer ownership', () => {
  expect(
    nodeOwnsPointer(
      element(
        '<label><span data-target>数据类型</span><button role="combobox">任意</button></label>'
      )
    )
  ).toBe(false)
  expect(
    nodeOwnsPointer(element('<div data-target class="json-preview"><span>JSON</span></div>'))
  ).toBe(false)
})

it('double-click display buttons are node surfaces, without exempting nested real controls', () => {
  expect(
    nodeOwnsPointer(
      element('<button data-node-pointer="surface"><span data-target>镜头文本</span></button>')
    )
  ).toBe(false)
  expect(
    nodeOwnsPointer(
      element('<div data-node-pointer="surface"><button data-target>播放</button></div>')
    )
  ).toBe(true)
})

it('actual buttons, selectors, sliders and dedicated crop gestures keep ownership', () => {
  for (const html of [
    '<button><span data-target>生成</span></button>',
    '<select data-target></select>',
    '<input data-target type="checkbox">',
    '<div role="slider"><span data-target>进度</span></div>',
    '<div class="crop-inline-canvas"><span data-target>裁剪框</span></div>'
  ])
    expect(nodeOwnsPointer(element(html))).toBe(true)
})

it('editable text/number inputs use double-click policy; readonly values remain node surfaces', () => {
  for (const html of [
    '<input data-target>',
    '<input data-target type="number">',
    '<textarea data-target></textarea>'
  ]) {
    const target = element(html)
    expect(nodeTextField(target)).toBe(target)
    expect(nodeOwnsPointer(target)).toBe(false)
  }
  expect(nodeTextField(element('<input data-target readonly>'))).toBe(null)
  expect(nodeTextField(element('<textarea data-target disabled></textarea>'))).toBe(null)
})
