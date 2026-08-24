// 共享 editor 实例 store：让顶栏（撤销/重做）和其他组件能访问 tldraw editor
import type { Editor } from 'tldraw'
import { create } from 'zustand'

interface EditorState {
  editor: Editor | null
  setEditor: (editor: Editor | null) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  editor: null,
  setEditor: (editor) => set({ editor })
}))
