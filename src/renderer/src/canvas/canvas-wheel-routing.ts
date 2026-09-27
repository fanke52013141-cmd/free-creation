import type { Editor } from 'tldraw'

const VERTICAL_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

function wheelPixels(event: WheelEvent, pageHeight: number): { x: number; y: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1
  return { x: event.deltaX * unit, y: event.deltaY * unit }
}

function hasVerticalScroll(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight) return false
  return VERTICAL_OVERFLOW.has(window.getComputedStyle(element).overflowY)
}

function scrollTargets(body: HTMLElement, target: Element): HTMLElement[] {
  const ancestors: HTMLElement[] = []
  if (body.contains(target)) {
    for (
      let element: Element | null = target;
      element && body.contains(element);
      element = element.parentElement
    ) {
      if (element instanceof HTMLElement && hasVerticalScroll(element)) ancestors.push(element)
    }
  }
  if (ancestors.length > 0) return ancestors
  if (hasVerticalScroll(body)) return [body]

  // Some node bodies use a nested scroll area while the outer body has no overflow.
  // Keep that area reachable when the pointer is over the header or an adjacent control.
  for (const element of body.querySelectorAll<HTMLElement>('*')) {
    if (hasVerticalScroll(element)) return [element]
  }
  return []
}

function selectedScrollTargets(editor: Editor, target: Element): HTMLElement[] {
  const selectedIds = editor
    .getSelectedShapes()
    .filter((shape) => shape.type === 'node-card')
    .map((shape) => shape.id)
  if (selectedIds.length === 0) return []

  const hoveredCard = target.closest<HTMLElement>('.node-card-wrap[data-node-id]')
  const selectedId =
    selectedIds.length === 1
      ? selectedIds[0]
      : selectedIds.find((id) => id === hoveredCard?.dataset.nodeId)
  if (!selectedId) return []

  const card =
    hoveredCard?.dataset.nodeId === selectedId
      ? hoveredCard
      : Array.from(
          editor.getContainer().querySelectorAll<HTMLElement>('.node-card-wrap[data-node-id]')
        ).find((element) => element.dataset.nodeId === selectedId)
  const body = card?.querySelector<HTMLElement>('.node-body')
  return body ? scrollTargets(body, target) : []
}

function panCanvas(editor: Editor, x: number, y: number): void {
  if ((x === 0 && y === 0) || editor.getCameraOptions().isLocked) return
  const { x: cameraX, y: cameraY, z } = editor.getCamera()
  const speed = editor.getCameraOptions().panSpeed ?? 1
  editor.stopCameraAnimation()
  editor.setCamera(
    { x: cameraX - (x * speed) / z, y: cameraY - (y * speed) / z, z },
    { immediate: true }
  )
}

/** The canvas owns wheel routing so focus and tldraw input-mode preferences cannot change it. */
export function routeCanvasWheel(event: WheelEvent, editor: Editor): void {
  const target = event.target
  if (!(target instanceof Node) || !editor.getContainer().contains(target)) return
  const targetElement = target instanceof Element ? target : target.parentElement
  if (!targetElement?.closest('.tl-canvas')) return

  event.preventDefault()
  event.stopPropagation()

  if (event.ctrlKey || event.metaKey) {
    // Keep the existing cursor-anchored zoom gesture.
    const dy = Math.abs(event.deltaY) > 10 ? 10 * Math.sign(event.deltaY) : event.deltaY
    const rect = editor.getContainer().getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const { x: cameraX, y: cameraY, z } = editor.getCamera()
    const baseZoom = editor.getBaseZoom()
    const steps = editor.getCameraOptions().zoomSteps ?? [0.1, 1]
    const zoom = Math.min(
      steps[steps.length - 1] * baseZoom,
      Math.max(steps[0] * baseZoom, z * (1 - (dy / 100) * 2))
    )
    editor.setCamera(
      { x: cameraX + px / zoom - px / z, y: cameraY + py / zoom - py / z, z: zoom },
      { immediate: true }
    )
    return
  }

  const { x, y } = wheelPixels(event, editor.getContainer().clientHeight)
  const targets = selectedScrollTargets(editor, targetElement)
  if (targets.length > 0) {
    // A scrollable selected node owns the gesture even at its top or bottom edge.
    // Move remaining distance through its scrollable ancestors, never to the canvas.
    let remaining = y
    for (const element of targets) {
      const max = element.scrollHeight - element.clientHeight
      const previous = element.scrollTop
      const next = Math.max(0, Math.min(max, previous + remaining))
      element.scrollTop = next
      remaining -= next - previous
      if (Math.abs(remaining) < 0.5) break
    }
    return
  }

  // Tldraw's wheel listener requires editor focus and can switch to zoom in mouse mode.
  // Direct camera movement gives the canvas one consistent vertical scroll behavior.
  panCanvas(editor, x, y)
}
