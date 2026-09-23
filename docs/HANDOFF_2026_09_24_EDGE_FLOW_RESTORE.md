# 节点数据连线流光恢复（2026-09-24）

## 背景

提交 `7a13911` 移除了正式数据连线的流光覆盖层，并停用了拖线预览上的 dash 动画。用户要求连接后的流光常驻，不能依赖节点或连线选中状态。

## 修改

- 每条真实业务数据连线持续显示彩色流光带，沿源端到目标端移动；端口类型色底线继续保留。
- 产物溯源线不属于可执行数据边，继续保持静态。
- 恢复拖线预览的移动光带，方便连接时看清流向。
- 不增加关闭开关或选中条件。

实现位于 `src/renderer/src/canvas/DataEdgeLayer.tsx`、`src/renderer/src/assets/ui-surfaces.css` 和 `src/renderer/src/assets/ui-foundation.css`。

## 验证

- `pnpm exec electron-vite build` 成功；输出渲染包包含 `data-edge-flow` 路径和 `edge-water-flow` 动画。
- 未运行自动化测试。
- 本地 `current/resources/app/out/renderer` 已更新。已启动的应用进程需要重新加载或重启后才会载入新包。
