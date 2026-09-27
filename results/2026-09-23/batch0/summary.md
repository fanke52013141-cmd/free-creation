# Canvas Studio 测试基线报告（batch0 · 自动门禁）

- 候选版本：53c738e（`53c738e fix(assets): persist media names and stabilize cards`）
- 客户端版本（package.json）：1.0.0
- 系统：Windows（Electron 39.8.10）
- 日期：2026-09-23
- 状态：基线自动门禁 **未通过**（存在 lint 与单测失败），见 defects.md。

## 自动门禁结果

| 门禁 | 命令 | 结果 | 说明 |
|---|---|---|---|
| lint | `npm run lint` | **FAIL** | 7 errors / 348 warnings |
| typecheck | `npm run typecheck` | PASS | |
| build | `npm run build`（typecheck + electron-vite build） | PASS | 完整打包成功 |
| 契约测试 | `npm run test:contract` | PASS | 3 文件 / 282 用例 |
| 全量单测 | `npm run test` | **FAIL** | 5 文件失败 / 88；13 失败 / 1123 通过 / 1 跳过 |
| 节点操作审计 | `npm run test:node-matrix` | **FAIL** | 浏览器驱动 UI 审计：多个节点“创建入口”超时 |

## 结论

按 TEST_PLAN §9.1「最后运行仓库统一门禁 pnpm verify」要求，verify 门禁应串联 lint/typecheck/test/build。
当前 verify 在 **lint 阶段即失败（退出码 1）**，后续阶段未在 verify 内执行；故「全量门禁通过」不成立。
计划 §9.1 明确：已知旧失败必须报告来源与影响，解决前不能自动豁免发布。

## 远程付费模型预算

- 环境变量发现：`MINIMAX_API_KEY`、`MINIMAX_VOICE_ID`（语音/克隆可能可用）。
- 未发现图片/视频/文本（OpenAI/ARK/Gemini/DashScope 等）的现成凭据（环境变量与 .env 均无）。
- 按 AGENT_RUNBOOK：没有给定预算/次数/模型时，远程付费用例应保持 BLOCKED，不无限重试；本地与 mock 先行。

## 下一步需求（见与用户的确认项）

- 证据输出目录、测试数据目录、夹具清单与哈希。
- 供应商/模型在限与调用次数总预算。
- 是否允许启动受控测试实例（CANVAS_DATA_DIR 隔离）驱动真实桌面 UI。