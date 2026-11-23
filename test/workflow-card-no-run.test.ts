// 节点流条目卡片动作口径（2026-11-23 用户裁决：卡片不提供「运行」入口）。
// 卡片 = 点击/拖拽铺开到画布使用 + 「编辑节点」（同一个全屏编辑页，保存即覆盖条目）
// + 「编辑名称」+「删除」；运行走画布既有路径。
// 源码级门禁：防「运行」按钮回归，防「编辑节点」退回主画布铺开方式，并锁定
// 改名/内容更新链路（IPC/域事件/preload/store）同包接入。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/CanvasSidePanel.tsx'),
  'utf8'
)
const appCssSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/app.css'), 'utf8')
const contractsSource = readFileSync(
  resolve(process.cwd(), 'src/shared/contracts/index.ts'),
  'utf8'
)
const ipcSource = readFileSync(
  resolve(process.cwd(), 'src/main/ipc/workspace-state.ipc.ts'),
  'utf8'
)
const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
const storeSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/stores/workflow.ts'), 'utf8')
const saveDialogSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/WorkflowSaveDialog.tsx'),
  'utf8'
)
const opsSchemaSource = readFileSync(
  resolve(process.cwd(), 'src/shared/agent-access/ops/node-library.ts'),
  'utf8'
)
const opsImplSource = readFileSync(
  resolve(process.cwd(), 'src/main/agent-access/node-library-ops.ts'),
  'utf8'
)
const repoSource = readFileSync(
  resolve(process.cwd(), 'src/main/store/workspace-state.repo.ts'),
  'utf8'
)
const editorSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/composite/CompositeCanvasEditor.tsx'),
  'utf8'
)

describe('节点流条目卡片：无「运行」按钮，编辑名称入口接入', () => {
  it('卡片不再有「运行」按钮（类名与 JSX 均不回归）', () => {
    expect(panelSource).not.toContain('asset-template-run')
    expect(panelSource).not.toContain('handleRun')
    expect(panelSource).not.toContain('onRun')
    expect(appCssSource).not.toContain('.asset-template-run')
  })

  it('运行执行器不再从面板直达（运行走画布既有路径）', () => {
    expect(panelSource).not.toContain('runWorkflowForNodes')
    expect(panelSource).not.toContain('requestWorkflowInput')
  })

  it('卡片动作与组合能力卡片一致：编辑名称 + 删除，点击/拖拽铺开编辑', () => {
    expect(panelSource).toContain('title="点击铺开到画布编辑，或直接拖到画布"')
    expect(panelSource).toContain('aria-label={`编辑名称 ${template.name}`}')
    expect(panelSource).toContain('className="composite-card-settings"')
    expect(panelSource).toContain('aria-label={`删除节点流条目 ${template.name}`}')
  })

  it('改名走 ModalShell 统一弹窗，空名与同名禁用保存', () => {
    expect(panelSource).toContain('function WorkflowRenameDialog')
    expect(panelSource).toContain('title="编辑节点流名称"')
    expect(panelSource).toContain('disabled={!trimmed || trimmed === template.name}')
    expect(panelSource).toContain('maxLength={120}')
  })

  it('改名链路同包接入：IPC 通道、处理器、preload、store 缺一不可', () => {
    expect(contractsSource).toContain("renameTemplate: 'workspace:templates:rename'")
    expect(ipcSource).toContain('IPC.workspace.renameTemplate')
    expect(ipcSource).toContain('renameWorkflowTemplate')
    expect(preloadSource).toContain('renameTemplate: (id: string, name: string)')
    expect(storeSource).toContain('rename: async (id, name) => {')
    expect(storeSource).toContain('window.api.workspace.renameTemplate(id, name)')
  })

  it('改名域事件齐全，只记条目 ID 不记名称正文（脱敏口径同 project-rename）', () => {
    expect(ipcSource).toContain("'workspace.template.rename.started'")
    expect(ipcSource).toContain("'workspace.template.rename.completed'")
    expect(ipcSource).toContain("'workspace.template.rename.failed'")
    expect(ipcSource).toContain("operation: 'node-library-rename'")
  })

  it('条目删除无二次确认（2026-11-23 用户裁决）：无论画布有无对应实例都直接删除', () => {
    const start = panelSource.indexOf('const handleRemoveTemplate')
    const end = panelSource.indexOf('const handleRenameTemplate')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = panelSource.slice(start, end)
    expect(body).toContain('wfRemove(tmpl.id)')
    expect(body).not.toContain('useConfirmStore')
    expect(body).not.toContain('confirm(')
  })

  it('卡片「编辑节点」打开同一个全屏编辑页（不在主画布上铺开改）', () => {
    expect(panelSource).toContain('aria-label={`编辑节点 ${template.name}`}')
    expect(panelSource).toContain('className="composite-card-edit"')
    expect(panelSource).toContain('onEditNodes={() => onEditTemplateNodes(tmpl)}')
    expect(panelSource).toContain('onEditTemplateNodes={setTemplateEdit}')
    // 条目与组合节点共用同一个编辑页组件，只是 target.kind 不同。
    expect(panelSource).toContain("target={{ kind: 'template', template: templateEdit }}")
    // 上一轮「铺到主画布 + 保存弹窗更新模式」的做法不得回归。
    expect(panelSource).not.toContain('handleEditTemplateNodes')
    expect(panelSource).not.toContain('useWorkflowEditSession')
    expect(saveDialogSource).not.toContain("'template-update'")
    expect(saveDialogSource).not.toContain('useWorkflowEditSession')
    // 主画布铺开只剩卡片点击/拖拽这一处。
    expect(panelSource.match(/handleApply\(/g)?.length).toBe(1)
  })

  it('编辑页条目模式：载入走画布同一路径（老连线端口可推断），保存原位覆盖条目', () => {
    // 载入必须走 addNodeLibraryEntry（与铺到画布同一路径）：照搬 manifest 载入时
    // createEdge 对不上端口会静默不建线，老条目打开即丢线。
    expect(editorSource).toContain('addNodeLibraryEntry(editor, target.template, false)')
    const templateBranch = editorSource.indexOf("if (target.kind === 'template') {")
    const manifestLoad = editorSource.indexOf('loadManifestIntoEditor(editor, base)')
    expect(templateBranch).toBeGreaterThan(-1)
    expect(manifestLoad).toBeGreaterThan(templateBranch)
    // 保存：原位覆盖条目内容，没有草稿/版本。
    expect(editorSource).toContain('const saveTemplateEntry = async')
    expect(editorSource).toContain('useWorkflowStore.getState().update(target.template.id')
    expect(editorSource).toContain('templatePayloadFromGraph(deriveGraph(editor))')
    // 条目没有历史版本与发布：动作栏与版本弹层都以 capability 为门槛。
    expect(editorSource).toContain('onClick={() => void (capability ? saveDraft() : saveTemplateEntry())}')
    expect(editorSource).toContain('{capability && showVersions && (')
  })

  it('原位更新链路同包接入：repo/IPC/preload/store 缺一不可', () => {
    expect(repoSource).toContain('export function updateWorkflowTemplateContent')
    expect(contractsSource).toContain("updateTemplate: 'workspace:templates:update'")
    expect(ipcSource).toContain('IPC.workspace.updateTemplate')
    expect(ipcSource).toContain('updateWorkflowTemplateContent')
    expect(preloadSource).toContain('updateTemplate: (')
    expect(storeSource).toContain('update: async (id, data) => {')
    expect(storeSource).toContain('window.api.workspace.updateTemplate(id, {')
  })

  it('外部等价操作 node.library.replace 已登记并实现（与 GUI 同一写口）', () => {
    expect(opsSchemaSource).toContain("'node.library.replace'")
    expect(opsImplSource).toContain('function replaceEntry')
    expect(opsImplSource).toContain("case 'node.library.replace':")
    // 提取与 compose 同源：不另写提取器。
    expect(opsImplSource).toContain('function collectEntryPayload')
  })

  it('内容更新域事件齐全，只记条目 ID 不记节点内容（脱敏口径同 rename）', () => {
    expect(ipcSource).toContain("'workspace.template.update.started'")
    expect(ipcSource).toContain("'workspace.template.update.completed'")
    expect(ipcSource).toContain("'workspace.template.update.failed'")
    expect(ipcSource).toContain("operation: 'node-library-replace'")
  })
})
