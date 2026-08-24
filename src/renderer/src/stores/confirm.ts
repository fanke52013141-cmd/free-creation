// 自绘确认弹窗状态管理：confirm() 返回 Promise<boolean>，替代 window.confirm
import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作（删除等）—— 确认按钮显示红色 */
  danger?: boolean
}

interface ConfirmState {
  options: ConfirmOptions | null
  resolver: ((value: boolean) => void) | null
  /** 弹出确认对话框，返回 Promise 在用户操作后 resolve */
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** 用户点击确认/取消/关闭时调用 */
  resolve: (value: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  options: null,
  resolver: null,

  confirm: (options) => {
    // 如果已有弹窗打开，先 resolve 旧的（防止 UI 堆叠）
    const prev = get().resolver
    if (prev) prev(false)

    return new Promise<boolean>((resolve) => {
      set({ options, resolver: resolve })
    })
  },

  resolve: (value) => {
    const r = get().resolver
    if (r) r(value)
    set({ options: null, resolver: null })
  }
}))
