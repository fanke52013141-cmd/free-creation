/** Pointer ownership is decided by the actual control, never its surrounding container. */
export function nodeTextField(target: Element): HTMLInputElement | HTMLTextAreaElement | null {
  const field = target.closest('input, textarea')
  if (field instanceof HTMLTextAreaElement) return field.disabled || field.readOnly ? null : field
  if (!(field instanceof HTMLInputElement) || field.disabled || field.readOnly) return null
  return ['text', 'number', 'search', 'url', 'email', 'password', 'tel'].includes(field.type)
    ? field
    : null
}

export function nodeOwnsPointer(target: Element): boolean {
  const control = target.closest(
    'button, select, a, input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"], input[type="color"], [role="slider"], [role="combobox"], [contenteditable="true"], .port-dot, .crop-inline-canvas, [data-node-pointer="control"]'
  )
  return Boolean(control && control.getAttribute('data-node-pointer') !== 'surface')
}
