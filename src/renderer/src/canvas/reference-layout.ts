import { NODE_UI } from './node-ui-tokens'

/** Fit complete references into one row, reserving the actual +N label width. */
export function referenceLayout(
  media: boolean[],
  available: number
): { widths: number[]; hidden: number } {
  const token = NODE_UI.reference
  const preferred = media.map((item) => (item ? token.imageWidth : token.textMaxWidth))
  if (media.length === 1)
    return available < (media[0] ? token.imageWidth : token.textMinWidth)
      ? { widths: [], hidden: 1 }
      : { widths: [media[0] ? token.imageWidth : available], hidden: 0 }
  for (let count = media.length; count >= 0; count--) {
    const hidden = media.length - count
    const more = hidden ? Math.max(token.moreMinWidth, 20 + String(hidden).length * 8) : 0
    const gaps = Math.max(0, count + (hidden ? 1 : 0) - 1) * token.gap
    const room = Math.max(0, available - more - gaps)
    const minimum = media
      .slice(0, count)
      .reduce((sum, item) => sum + (item ? token.imageWidth : token.textMinWidth), 0)
    if (minimum > room) continue
    const textCount = media.slice(0, count).filter((item) => !item).length
    const textRoom = room - media.slice(0, count).filter(Boolean).length * token.imageWidth
    const textWidth = textCount ? Math.min(token.textMaxWidth, textRoom / textCount) : 0
    return {
      widths: preferred.slice(0, count).map((width, index) => (media[index] ? width : textWidth)),
      hidden
    }
  }
  return { widths: [], hidden: media.length }
}
