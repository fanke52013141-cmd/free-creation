# 画布连线与节点交互优化交接（2026-09-06）

## 本次目标

解决缩放或反向排布时数据连线变形的问题，并完善节点级运行入口与“两节点靠近即可连线”的操作：

- 连线在任意缩放比例下保持同一几何比例；反向连线不再向画布外侧翻折为大 S 弯。
- 节点被放入 tldraw 分组后，连线仍准确贴到卡片端口。
- 框选两个节点后，既可以把其中一个节点拖近另一个节点自动连接，也可以把连接线释放在已选目标的附近完成吸附连接。
- 运行按钮置于节点标题行最右侧、与标题垂直居中；移除冗余的“执行成功可运行”标签。

## 实现摘要

| 位置 | 改动 |
| --- | --- |
| `src/renderer/src/canvas/edge-geometry.ts` | 新增可复用的屏幕坐标贝塞尔路径生成器。控制柄仅由两端的水平距离按比例计算。 |
| `DataEdgeLayer.tsx`、`ConnectionLayer.tsx` | 正式数据线和拖拽预览统一使用相同几何规则，避免两种状态视觉不一致。 |
| `graph.ts` | 创建边和端口命中统一改为页面坐标；修复分组后 `shape.x/y` 变为局部坐标导致的连线偏移。建边失败会向上返回错误，不再伪报成功。 |
| `CanvasEditor.tsx` | 双选节点仅在相对位置改变时检测自动连接；连接线释放到另一个已选节点周边时按固定屏幕半径吸附。所有连接仍通过 `tryConnect`，受端口类型、单值输入、重复边和环路校验约束。 |
| `NodeCardView.tsx`、`ui-surfaces.css` | 标题栏扩展为节点全宽布局，运行入口在最右侧；删除 readiness 文案。 |
| `test/edge-geometry.test.ts` | 覆盖反向线控制点不外翻、等比缩放不变形。 |
| `test/canvas-interaction.test.ts`、`scripts/test-browser-node-ui.cjs` | 补充交互入口的回归覆盖；浏览器冒烟覆盖端口连线、编组、导入/预览、浅色详情、序号样式与运行按钮定位。 |

## 已验证

自动化命令均在 `C:\Users\Administrator\Desktop\无限画布` 执行：

```powershell
npm run lint
npm run typecheck
npm run test
npx electron-vite build
node scripts/test-browser-node-ui.cjs
```

- 全量 Vitest：69 个测试文件、860 个测试全部通过。
- 定向几何/交互测试：6 项通过。
- 生产构建通过。
- 浏览器冒烟通过：图片导入与预览、图片拆分入口、底栏文本导入、端口连接、节点编组、浅色检查器、红色序号、移除 readiness 标签。
- 人工浏览器验收通过：100% 与 200% 缩放下连线控制柄比例相同；反向节点间连线无外翻；分组子节点连线端点与端口对齐；两个已选节点的近距释放出现“已吸附连接到已选节点”且新边成功创建。

`npm run lint` 没有 error；仍有 3 条既有 Prettier warning，位于本切片未改动的 `src/preload/index.ts`、`src/renderer/src/engine/executors/shared.ts`、`test/agent/concurrent-write-lock.test.ts`。生产构建仍有既有的 `shared.tsx` 同时动/静态导入提示，不阻断构建。

## 审查结论

已按代码质量门禁审查本切片的正确性、契约边界、状态回收、性能和安全性，未发现阻塞合并的 P0/P1 问题。

- 自动连接不绕过既有图契约；它最终调用同一个 `tryConnect`。
- 吸附半径以 `56 / zoom` 计算，表示固定屏幕像素范围，缩放不会改变手感。
- 未增加节点类型、端口或 Agent 能力，因此不需要运行 `npm run agent:generate`，也不会造成 MCP/CLI 契约变更。
- 不新增密钥、媒体文件或运行日志持久化内容。

## 已知边界与下一步

1. 自动化浏览器脚本稳定覆盖普通端口连线与编组。多选后近距释放的吸附连线已人工验收；由于 headless 环境的 tldraw 多选覆盖层不稳定，尚未将这一路径纳入该脚本。建议后续为 Electron 端补一个稳定的多选拖拽 E2E fixture。
2. 当前工作树已有多项并行 UI、媒体和对话功能修改。它们不是本切片单独产生的内容，提交前必须按既有变更归属分批暂存，不能把整个脏工作树不加审查地一次提交。
