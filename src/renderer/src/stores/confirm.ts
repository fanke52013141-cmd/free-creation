// 自绘确认弹窗状态管理：confirm() 返回 Promise<boolean>，替代 window.confirm
import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作（删除等）——确认按钮显示红色 */
  danger?: boolean
}

type PendingConfirm = {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

interface ConfirmState {
  options: ConfirmOptions | null
  resolver: ((value: boolean) => void) | null
  /** 后续确认按到达顺序排队；绝不把尚未展示的请求自动判为拒绝。 */
  queue: PendingConfirm[]
  /** 弹出确认对话框，返回 Promise 在用户操作后 resolve */
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** 用户点击确认/取消/关闭时调用 */
  resolve: (value: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  options: null,
  resolver: null,
  queue: [],

  confirm: (options) => {
    return new Promise<boolean>((resolve) => {
      const current = get()
      if (!current.resolver) {
        set({ options, resolver: resolve })
        return
      }
      set({ queue: [...current.queue, { options, resolve }] })
    })
  },

  resolve: (value) => {
    const current = get()
    current.resolver?.(value)
    const [next, ...rest] = current.queue
    if (next) {
      set({ options: next.options, resolver: next.resolve, queue: rest })
    } else {
      set({ options: null, resolver: null, queue: [] })
    }
  }
}))
