// 弹窗统一按钮类名（规范 §2.3）：modal-btn 基类 + secondary/primary/danger 语义档。
// 独立成文件以保持 ModalShell 组件文件可被 React Fast Refresh 正常热更。
export type ModalBtnKind = 'secondary' | 'primary' | 'danger'

export function modalBtn(kind: ModalBtnKind): string {
  return `modal-btn modal-btn-${kind}`
}
