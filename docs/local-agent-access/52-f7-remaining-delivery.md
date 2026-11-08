# F7 收尾：结构包导出 / 产物谱系读取 / 素材批量导出 / 资源捕获

日期：2026-11-08。基线：117 项操作。本包把 F7 剩余 6 项全部定性：**开放 5 项，1 项明确不开放**，
F7 计划项从 6 → **0**。操作数 117 → **122**。

## 1. 开放（5 项）

| 操作 | 效果 | GUI 同一动作 | 关键边界 |
| --- | --- | --- | --- |
| `project.exportStructure` | export | 画布传输菜单导出结构包 | 导出**已保存**结构到受控目录；无画布快照时给明确码 `STRUCTURE_SNAPSHOT_MISSING`；不覆盖已有文件 |
| `media.getRecipe` | read | 产物生成来源面板 | **绝不返回提示词正文 `fullPrompt`**；媒体必须属于本项目；参数走公共 `recipeParams` 脱敏 |
| `media.batchExport` | export | 素材面板批量导出 | 只写受控目录下的**新子目录**；同名文件加序号后缀、绝不覆盖；逐项回执成功/失败 |
| `library.captureProjectMedia` | write | 画布→资源库（采集素材） | 复用 `captureProjectMedia`；媒体必须属于该项目（跨项目 `MEDIA_NOT_FOUND`） |
| `library.captureProjectNodes` | write | 画布→资源库（采集节点） | 逐个校验节点真实存在、`nodeType` 与持久化一致、引用媒体属于本项目；防伪造节点 |

## 2. 不开放（1 项）

`media.saveRecipe`：生成来源是**运行事实**，只能由执行器在真实产出时写入。外部写入等于伪造谱系，
与"不得伪造运行事实"的红线冲突。读取已由 `media.getRecipe` 开放。

## 3. 真实验证（`test/local-agent-f7-remaining-access.test.ts`，10 项通过）

结构包导出（3 项）：成功路径（回执 sha256 与落盘字节一致、nodeCount 正确、回执不含绝对路径）；
无画布快照 → `STRUCTURE_SNAPSHOT_MISSING`（不是模糊的"包内容无效"）；同名不覆盖 `OUTPUT_EXISTS`、
非法扩展名 `INVALID_INPUT`、项目不存在 `NOT_FOUND`。

产物谱系（3 项）：无谱系 `found=false`（不伪造）；有谱系返回 nodeType/runId/params，且
**断言提示词正文与 `apiKey` 都不出现在响应里**；跨项目 mediaId → `MEDIA_NOT_FOUND`。

批量导出（2 项）：逐项回执且文件真实落盘（字节数一致）、回执不含绝对路径；
指定不存在的 mediaId 时**整批拒绝**而不是静默跳过。

资源捕获（2 项）：媒体采集成功、跨项目 mediaId 拒绝、缺 mediaId 被 Schema 拒绝；
节点采集成功、幽灵节点 `NODE_NOT_FOUND`、类型谎报 `NODE_TYPE_MISMATCH`、跨项目媒体 `MEDIA_NOT_FOUND`。

## 4. 过程中发现并修的真实问题

`project.exportStructure` 最初对"没有画布快照的项目"返回 `PACKAGE_CONTENT_INVALID`——
因为公共 `cleanSnapshot` 要求快照含 document/page 记录，而只经外部 `graph.patch` 建过图、
从未在 GUI 保存过画布的项目没有 `tldrawSnapshot`。这会把"项目还没保存过画布"说成"包内容无效"，
误导排查方向。已在入口先做显式检查并返回 `STRUCTURE_SNAPSHOT_MISSING` + 可执行提示
（"先在 GUI 打开并保存一次"）。

## 5. 数字

- 外部操作：117 → **122**
- external 业务动作：139 → **144**
- F7 计划项：6 → **0**
- 新测试：10 项通过

## 6. 未完成边界

1. 结构包导出读的是**已保存**结构，renderer 未保存编辑不在范围内（需要最新编辑先 `project.save`）——
   与 GUI"导出当前文档"语义不同，已在 note 里写明；
2. 资源捕获不处理"捕获后再次发布为修订"的完整流程（`resourceId`/`baseRevisionId` 透传给既有服务，
   但外部侧没有专门编排）；
3. 真实桌面段未补（这 5 项都是 main 侧能力，不依赖桌面握手；桌面验收留给 F10 的安装包整体验收）。
