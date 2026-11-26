// GUI 本地运行占用：renderer 通过既有 task-report 通道上报，main 在外部写/导出/open 准入时 fail-closed。
// 这里只保存受控项目 ID 与忙状态，不保存节点标题、运行正文或供应商错误。
const busyProjects = new Set<string>()

export function setGuiRunBusy(projectId: string, busy: boolean): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) return
  if (busy) busyProjects.add(projectId)
  else busyProjects.delete(projectId)
}

export function isGuiRunBusy(projectId: string): boolean {
  return busyProjects.has(projectId)
}

export function clearGuiRunBusy(): void {
  busyProjects.clear()
}
