# 画布连接点与连线比例更新（2026-09-27）

## 更新内容

- 默认连接点按端口类型合并显示：同类型端口共用锚点，不同类型端口平分节点高度；节点无连接时各侧使用单个代表端口。
- 基础连线宽度为 3 px，流动线宽度为 4.5 px。
- 流动线段长度按整条线的六分之一计算，长度变化不再改变线宽。
- 拖动连线预览使用同样的六分之一流动段比例。
- 连线主体、流动线和光晕随画布缩放补偿，缩小时保持视觉宽度稳定。
- 连线颜色跟随输出端口类型，拖动连线预览沿用相同的类型色和流动效果。
- 多选框与批量操作指示样式已同步整理。
- 增加桌面快捷方式安装入口；启动器每次先构建当前本地源码，构建失败时不启动旧版本。

## 主要实现位置

- `src/renderer/src/canvas/node-port-layout.ts`：按端口类型合并连接点并计算垂直布局。
- `src/renderer/src/canvas/DataEdgeLayer.tsx`：数据连线、流动段长度及缩放补偿。
- `src/renderer/src/canvas/ConnectionLayer.tsx`：拖线预览颜色与流动表现。
- `src/renderer/src/assets/ui-surfaces.css`：正式连线宽度、流光长度与动画样式。
- `src/renderer/src/assets/ui-foundation.css`：拖线预览的流光长度。
- `src/renderer/src/assets/app.css`：多选边框和数字指示器样式。
- `scripts/install-latest-desktop-shortcut.ps1` 与 `scripts/launch-latest-desktop.ps1`：桌面快捷方式安装及本地最新版本启动。

## 本次交付附注

- 同步更新节点 UI 决策测试，断言当前实际空态、详情侧栏和控件行为。
- 修正对话面板设置状态与下拉框关闭逻辑的 lint 问题。
- 生成的截图、临时 QA 结果和本地运行数据不属于代码提交。

## 验证

- `npm run verify` 通过：lint、Node/Web 类型检查、103 个测试文件（1,234 项通过、1 项跳过）和 Electron 构建。
