import {
  TldrawSelectionForeground,
  useEditor,
  useValue,
  type TLSelectionForegroundProps
} from 'tldraw'

/** Single cards retain manual sizing; multi-selection uses the canvas group controls. */
export function NodeSelectionForeground(
  props: TLSelectionForegroundProps
): React.JSX.Element | null {
  const editor = useEditor()
  const singleCard = useValue(
    'single resizable node',
    () => {
      const shapes = editor.getSelectedShapes()
      return shapes.length === 1 && shapes[0].type === 'node-card'
    },
    [editor]
  )
  return singleCard ? <TldrawSelectionForeground {...props} /> : null
}
