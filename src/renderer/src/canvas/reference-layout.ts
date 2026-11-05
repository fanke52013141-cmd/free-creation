import { NODE_UI } from './node-ui-tokens'

/** Fit complete references into one row, reserving the actual +N label width. */
export function referenceLayout(
  media: boolean[],
  available: number,
  compactWidths?: readonly number[]
): { widths: number[]; hidden: number } {
  const token = NODE_UI.reference
  const preferred = media.map((item, index) => (item ? token.imageWidth : compactWidths?.[index] ?? token.textMaxWidth))
  if (media.length === 1)
    return available < preferred[0]
      ? { widths: [], hidden: 1 }
      : { widths: [preferred[0]], hidden: 0 }
  for (let count = media.length; count >= 0; count--) {
    const hidden = media.length - count
    const more = hidden ? Math.max(token.moreMinWidth, 20 + String(hidden).length * 8) : 0
    const gaps = Math.max(0, count + (hidden ? 1 : 0) - 1) * token.gap
    const room = Math.max(0, available - more - gaps)
    const minimum = preferred.slice(0, count).reduce((sum, width) => sum + width, 0)
    if (minimum > room) continue
    return {
      widths: preferred.slice(0, count),
      hidden
    }
  }
  return { widths: [], hidden: media.length }
}
