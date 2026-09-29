# R-47 / R-40 运行时验证报告（2026-09-29）

方式：dev:browser + Playwright 真实按键事件（`keyboard.press` 命中 window 捕获监听，可复现真实行为）。浏览器演示 profile 隐藏了 processor 节点，改用同源 AppSelect 的生图节点（Radix `Select.Trigger` 渲染为 `<button>`），结论可推广。证据：`r47-results.json`、成对截图 `r47-{a,b,c1,c2,d,e}-{before,after}.png`、驱动脚本 `r47-keyboard-verify.cjs`（BROWSER_ORIGIN 可配）。

## R-47 结论：确认为真实缺陷，已修复（捕获阶段吞键）

修复前实测（全部在按键前断言 `.is-selected` 且焦点正确）：

| 场景 | 焦点 | 按键 | 节点数 前→后 | 判定 |
|---|---|---|---|---|
| a 基线 | BODY（画布） | Delete | 1→0（toast 删除） | PASS（对照成立） |
| b 卡片内输入框 | TEXTAREA.gen-prompt | Delete | 1→1，内容只删一个字符 | PASS（既有守卫有效） |
| c1 AppSelect 触发器 | BUTTON.app-select-trigger | Delete | **1→0** | BUG |
| c2 弹层选项（Radix portal，焦点在画布容器外） | DIV.app-select-item | Delete | **1→0** | BUG |
| d 运行按钮 | BUTTON.node-run-btn | Delete | **1→0** | BUG |
| e 同 c1 | 同 c1 | Backspace | **1→0** | BUG |

涉事代码（CanvasEditor.tsx）：typing 豁免不含交互控件；`inCanvas` 第三分支「有选中形状即接管」使容器外焦点也命中；window 捕获先于 tldraw 容器级处理。

**修复**（同文件）：焦点在 `button, select, [role="listbox"], [role="option"], [role="dialog"]` 上时，Delete/Backspace 在窗口捕获阶段 `preventDefault + stopPropagation` 后返回——仅提前 return 不够，事件会继续传到 tldraw 借选中形状删除。修复后复跑同一脚本 **6/6 PASS**（基线删除行为不变、输入框守卫不变、四个误删场景全部保住节点）。

## R-40 结论：浏览器模式不可达，需桌面脚本复现

触发链需要 Electron 主进程的 `fs.watch`（src/main/ipc/project-watcher.ts:39-46）→ IPC external-change → 渲染层 reloadFromDisk；浏览器模式 `browserMock.ts:194` 的 `onExternalProjectChange` 是永久 no-op，链路第一环不存在，未做近似复现。代码层佐证审查描述属实：800ms 防抖在（CanvasEditor.tsx 约 1444 行），`reloadFromDisk` 未开 `interruptRunning`（全文件仅初始快照修复用到）。建议后续用桌面矩阵 harness 复现「运行中外部写盘」。

## 环境与产物

- dev:browser 以 `node_modules/.bin/vite --config vite.browser.config.ts --host 127.0.0.1 --port <N> --strictPort` 直启（`pnpm run dev:browser -- --port` 会把 `--` 字面传给 vite 而忽略端口），验证后已停。
- 本目录 `r47-*` 文件为本次产物；`00-prepared.png`~`08-*`、`debug-*`、`verify-r47-delete-focus.cjs` 为先前会话遗留。
