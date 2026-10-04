# 优化执行台账（OPTIMIZATION_EXECUTION_PLAN_2026-10-04 配套）

状态机：待确认 → 已复现/已界定 → 方案明确 → 实现中 → 验收通过 → 已交付
每任务一条记录；验收证据存 qa/optimization-<任务号>/。

## 任务索引

| 任务 | 里程碑 | 关联 | 状态 | 验收用例 | 证据目录 |
|---|---|---|---|---|---|
| T01 类型化演示接口 | M0 | F16 | **已交付**(2026-10-04) | 演示生图/AI处理/语音三卡反馈 | qa/optimization-T01/ |
| T00 真实任务基线 | M0 | 不足A | 待确认 | REAL-TASKS.md | qa/optimization-baseline/ |
| T04 保存协调器 | M1 | F01 | 待确认 | A07/A08 | qa/optimization-T04/ |
| T05 恢复检查点 | M1 | F02 | 待确认 | A09 | qa/optimization-T05/ |
| T02 搜索与Esc | M2 | F04/F05 | 待确认 | A01/A02 | qa/optimization-T02/ |
| T03 新建分层 | M2 | F03 | 待确认 | A01 | — |
| T06 统一预检 | M2 | F06 | 待确认 | A03 | — |
| T07 运行计划 | M2 | F07 | 待确认 | A03/A04 | — |
| T08 错误指引 | M2 | F10 | 待确认 | A05 | — |
| T09 新鲜度固定 | M3 | F08 | 待确认 | A10 | — |
| T10 长期来源 | M3 | F09 | 待确认 | A10/A11 | — |
| T11 复用预览 | M3 | F11 | 待确认 | A11 | qa/optimization-T11/ |
| T12 结果分组 | M3 | F12 | 待确认 | A14 | — |
| T13 分镜专项 | M4 | F13 | 待确认(按频次) | A12 | — |
| T14 最近删除/版本启动 | M5 | F14/F15 | 待确认 | A13/A15 | — |
| T15 规范门禁收敛 | 贯穿 | F17/F18/F19 | F19已修复(2026-10-04) | 组合回归 | — |
| T16 性能证据 | M5 | F12/F18 | 待确认 | A14 | qa/optimization-T16/ |

## 已完成记录

### T01 类型化浏览器演示接口（2026-10-04 交付）
- 状态：验收通过 → 已交付。关联 F16；M0。
- 改动：browserMock 删除整体强转，改用模块级 `type WindowApi = typeof window.api` 注解 mockApi 做逐成员赋值检查；补齐 12 个缺口（资源库目录/画布结构 8 桩、models 命名空间 fixture、gateway 3 成员）；抓出并修正错误方法名 `loadPalettePreferences→getPalettePreferences`（旧强转掩盖，浏览器演示调色板偏好此前静默失效）；5 处遗留形状分歧以 F16-legacy 局部 cast 标记。
- 验证：typecheck/lint 通过；全量 vitest 1333 通过（含新增 `test/browser-mock-contract.test.ts` 9 例）；test:model 通过；浏览器实测（`qa/optimization-T01/verify-f16.cjs`）生图执行成功出图、AI 处理与语音给业务提示，三卡零裸异常，F16 复现场景（resolveBinding undefined 崩溃）消除。剩余页面错误为已知 tldraw CDN EncodingError（UX-14）与 2 次设计内的演示 fetch 降级。
- 未验证边界：模型目录面板浏览/编辑流在演示模式的完整走查（变更类桩返回 DEMO_NOT_IMPLEMENTED，属设计行为）。
- 附带发现：`as` 断言对缺失成员不报错（实测），必须赋值检查才能当类型守卫。

### F19 前置修复（2026-10-04）
- 改动：CanvasEditor.tsx 相机交互 wheel 监听移除补 capture:true。
- 验证：pnpm run typecheck 通过。行为验证（进出画布 5 次监听不增长）留 T15 回归。
- 关联：审查报告 F19 / d39eb5d 引入。
