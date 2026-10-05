// @vitest-environment jsdom
import type { Editor } from 'tldraw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeCanvasWheel } from '../src/renderer/src/canvas/canvas-wheel-routing'

function setScrollRange(element: HTMLElement, contentHeight: number, viewportHeight: number): void {
  element.style.overflowY = 'auto'
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => contentHeight },
    clientHeight: { configurable: true, get: () => viewportHeight }
  })
}

function harness(initialSelection: string[] = []) {
  const host = document.createElement('div')
  const container = document.createElement('div')
  const canvas = document.createElement('div')
  const card = document.createElement('div')
  const header = document.createElement('div')
  const body = document.createElement('div')
  const panel = document.createElement('div')
  const selectedIds = initialSelection
  let camera = { x: 0, y: 0, z: 1 }

  canvas.className = 'tl-canvas'
  card.className = 'node-card-wrap'
  card.dataset.nodeId = 'shape:first'
  header.className = 'node-header'
  body.className = 'node-body'
  card.append(header, body)
  canvas.append(card)
  container.append(canvas, panel)
  host.append(container)
  document.body.append(host)
  setScrollRange(container, 600, 600)

  const editor = {
    getContainer: () => container,
    getSelectedShapes: () => selectedIds.map((id) => ({ id, type: 'node-card' })),
    getCamera: () => camera,
    getCameraOptions: () => ({ panSpeed: 1, isLocked: false, zoomSteps: [0.1, 1, 4] }),
    getBaseZoom: () => 1,
    stopCameraAnimation: vi.fn(),
    setCamera: (next: typeof camera) => {
      camera = next
    }
  } as unknown as Editor
  host.addEventListener('wheel', (event) => routeCanvasWheel(event, editor), {
    capture: true,
    passive: false
  })

  return {
    canvas,
    header,
    body,
    panel,
    camera: () => camera
  }
}

function wheel(target: Element, deltaY: number, options: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY,
    ...options
  })
  target.dispatchEvent(event)
  return event
}

afterEach(() => document.body.replaceChildren())

describe('画布滚轮的实际事件分流', () => {
  it('未选中节点时，悬停空白画布或未选中节点都平移画布', () => {
    const view = harness()
    setScrollRange(view.body, 400, 100)

    expect(wheel(view.body, 40).defaultPrevented).toBe(true)
    expect(view.camera().y).toBe(-40)
    expect(view.body.scrollTop).toBe(0)

    wheel(view.canvas, 30)
    expect(view.camera().y).toBe(-70)
  })

  it('选中且可滚动时，在标题或空白画布上滚轮也只推动节点', () => {
    const view = harness(['shape:first'])
    setScrollRange(view.body, 300, 100)

    wheel(view.header, 40)
    wheel(view.canvas, 30)
    expect(view.body.scrollTop).toBe(70)
    expect(view.camera().y).toBe(0)
  })

  it('节点到达上下边界后仍拦住滚轮，不带动画布', () => {
    const view = harness(['shape:first'])
    setScrollRange(view.body, 300, 100)
    view.body.scrollTop = 200

    wheel(view.body, 50)
    expect(view.body.scrollTop).toBe(200)
    expect(view.camera().y).toBe(0)

    wheel(view.body, -250)
    wheel(view.body, -50)
    expect(view.body.scrollTop).toBe(0)
    expect(view.camera().y).toBe(0)
  })

  it('嵌套滚动区可在节点标题处使用，剩余距离只传给节点正文', () => {
    const view = harness(['shape:first'])
    setScrollRange(view.body, 250, 100)
    const nested = document.createElement('textarea')
    setScrollRange(nested, 200, 100)
    view.body.append(nested)

    wheel(view.header, 40)
    expect(view.body.scrollTop).toBe(40)
    expect(nested.scrollTop).toBe(0)

    nested.scrollTop = 90
    wheel(nested, 40)
    expect(nested.scrollTop).toBe(100)
    expect(view.body.scrollTop).toBe(70)
    expect(view.camera().y).toBe(0)
  })

  it('正文不溢出但内部列表溢出时，仍能滚动该列表', () => {
    const view = harness(['shape:first'])
    setScrollRange(view.body, 100, 100)
    const list = document.createElement('div')
    setScrollRange(list, 300, 100)
    view.body.append(list)

    wheel(view.header, 35)
    expect(list.scrollTop).toBe(35)
    expect(view.camera().y).toBe(0)
  })

  it('选中节点没有纵向溢出时，滚轮平移画布', () => {
    const view = harness(['shape:first'])
    setScrollRange(view.body, 100, 100)

    wheel(view.body, 40)
    expect(view.camera().y).toBe(-40)
  })

  it('公共正文外壳包在 Body 外侧时，选中后的滚轮推动外壳而非画布', () => {
    const view = harness(['shape:first'])
    const scroll = document.createElement('div')
    scroll.className = 'node-standard-scroll'
    view.body.before(scroll)
    scroll.append(view.body)
    setScrollRange(scroll, 900, 300)
    wheel(view.body, 120)
    expect(scroll.scrollTop).toBe(120)
    expect(view.camera().y).toBe(0)
    wheel(view.header, 60)
    expect(scroll.scrollTop).toBe(180)
  })

  it('保留 Ctrl 缩放，并且不抢画布外面板的滚轮', () => {
    const view = harness()

    wheel(view.canvas, -20, { ctrlKey: true, clientX: 100, clientY: 50 })
    expect(view.camera().z).toBeCloseTo(1.2)

    expect(wheel(view.panel, 60).defaultPrevented).toBe(false)
    expect(view.camera().z).toBeCloseTo(1.2)
  })
})
