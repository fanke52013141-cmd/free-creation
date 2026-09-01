# 文本节点输入修复交接（2026-09-02）

## 背景

用户反馈文本节点无法输入内容：双击进入编辑态后，textarea 拿不到焦点，键盘输入无效。
修复落地在 `main` 的最新提交 `c214d45` 中，并已推送至
`origin/main`（本地与远程哈希一致，无需再次推送）。

## 根因

编辑态下创建的 `<textarea>` 本质是 tldraw 画布内的一个 HTML 节点，而 tldraw 会拦截
键盘事件来响应快捷键。存在两个隐患：

1. **事件监听器闭包过期**：进入编辑态的展示 div 会在「展示态 → 编辑态」来回切换时重建，
   监听器依赖数组之前只写 `[editing]`，导致每次重建都重新注册 `canvas:edit-text-node`
   监听器；同时 `textRef` 在渲染期同步，可能与实际 `shape.props.text` 出现偏差。
2. **编辑器打开时读到旧值**：`enterEditing` 读取的是渲染期写入的旧 `textRef`，若外部
   （如 I/O 面板）刚改过文本，打开的编辑器会显示过期内容。

## 改动（`src/renderer/src/nodes/specs/bodies/text.tsx`）

- `textRef.current` 不再在渲染期同步，改为在 `useEffect` 中随 `shape.props.text` 更新，
  保证事件监听器始终读到最新值，避免闭包过期。
- `enterEditing` 用 `useCallback` 包裹，依赖收敛到 `[editor, shape.id]`，使监听器引用稳定，
  不会因重复注册而失效；`useEffect` 的监听器依赖从 `[editing]` 改为 `[editing, enterEditing]`。
- 删除旧的在编辑态下同步 draft 的 `useEffect`（由 `enterEditing` 里读取 `textRef.current`
  统一承担），避免编辑器打开瞬间被外部 text 覆盖。

核心流程保持不变：双击 → `canvas:edit-text-node` → `enterEditing()` 设置 `draft`、
`setEditing(true)` 并调用 `editor.setEditingShape(shape.id)`，以此来告知 tldraw 当前 shape
正在被编辑，编辑期间不再拦截键盘事件；textarea 的 `onPointerDown`/`onMouseDown` 等仅
`stopPropagation()` 阻止冒泡到画布层，**不做** `preventDefault()`（否则浏览器无法执行
pointerdown 默认聚焦行为，导致无法输入）。

## 涉及文件

- `src/renderer/src/nodes/specs/bodies/text.tsx`

## 建议验证路径

在桌面端手工冒烟以下场景：

1. 双击文本节点进入编辑，输入若干字符，按 `Ctrl+Enter` 或失焦提交，确认内容落盘。
2. 编辑态点住文本拖拽，确认不会误触发画布平移或选中。
3. 在右侧 I/O/设置面板修改文本，重新双击节点，确认编辑器显示最新值而非旧值。
4. `Escape` 取消编辑，确认 draft 回退到原始文本且退出编辑态。
5. 连续多次双击进入/退出，确认不会出现监听器叠加导致「一次双击进入编辑、再次双击失效」。

## 备注

- 该提交 `c214d45` 同时包含 Agent 生产执行硬化等其他改动，文本输入修复是其子集；
  完整上下文见 [docs/HANDOFF_2026_09_01_AGENT_PRODUCTION.md](./HANDOFF_2026_09_01_AGENT_PRODUCTION.md)。
- 根 `HANDOFF.md` 顶部已新增本条交付入口。
