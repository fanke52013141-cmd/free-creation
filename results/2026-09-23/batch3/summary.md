# Canvas Studio 测试批次报告（batch3 · 本地/契约与真实媒体覆盖）

- 候选版本：53c738e
- 系统：Windows / Electron 39.8.10 / node v24.11.0 / ffmpeg+ffprobe in PATH
- 日期：2026-09-23
- 状态：本地节点契约、执行器、真实 FFmpeg 媒体、迁移与持久化类大量 PASS；远程付费/外部凭据项仍 BLOCKED/GAP。
- 未修改任何业务代码。

## 一、本地节点类契约/执行器覆盖（均 PASS）

| 测例组 | 文件 | 数量 | 状态 |
|---|---|---|---|
| 通用执行器（json/text/storyboard 回溯与非法 JSON/分镜拒绝）| executors.test.ts | 22 | PASS |
| 共享执行器逻辑（mergedPrompt/parse 等）| executors-shared.test.ts | 28 | PASS |
| 迭代 iterate | iterate.test.ts | 28 | PASS |
| 迭代取消/恢复 | iterate-cancel-resume.test.ts | ✓（并入） | PASS |
| JSON | executors.test.ts json 组 | ✓ | PASS |
| 处理/字段提取 | （覆盖于 executors 组）| — | — |
| 代码 code（精确输出/命名参数/返回类型/超时）| code-contract.test.ts, code-runtime-offline.test.ts | 4+ | PASS |
| 结构数据/占位符 | node-schemas.test.ts | 23 | PASS |
| 分镜板 | storyboard-editor.test.ts, executors storyboard 组 | 10 | PASS |
| 文件/文档正文提取（含坏 PDF 诊断）| document-text.test.ts | 10 | PASS |
| 图片裁剪 | image-crop.test.ts | 8 | PASS |
| 图片拆分 | image-split.test.ts | 6 | PASS |
| 图片编辑（P图，本地输入保护断言）| image-edit.test.ts, image-edit-media.test.ts | 10+2 | PASS |
| 3D 导演台（数据结构/预演生成）| director-data.test.ts, previs-space-generator.test.ts | 3+3 | PASS |
| AI 处理 ai-process | aiProcess.test.ts | 11 | PASS |
| 对话记忆 chat | chat-memory.test.ts | 3 | PASS |

## 二、节点契约体系（全部 PASS）

- `contracts.test.ts`（batch0 282 契约）、`node-contract-snapshot.test.ts`（155）、`node-schemas.test.ts`（23）、
  `registry.test.ts`（28）、`node-create-options.test.ts`（6）、`node-compliance.test.ts`（3）、`topology.test.ts`（3）
- 覆盖：节点注册 `ActiveNodeTypeId / NodeTypeSpec / contractVersion`、输入输出端口与 JSON Schema、运行记录与结果、拓扑。

## 三、真实媒体（本地 FFmpeg，无需远程）— PASS

- `video-transform-real-media.test.ts`（16，1 skip）：取帧首/自定义/尾帧不越界、**人声分离**居中抵消、
  时间轴缩略图数量夹取 1–12，均产出可解码文件。
- `video-transform.test.ts`（24）、`image-transform-real.test.ts`（10，真实像素断言）、`image-perspective.test.ts`（2）。

## 四、迁移与持久化 — PASS

- `migration.test.ts`（62）、`db-migrations.test.ts`（3）、`project-persistence.test.ts`、`project-save-sync.test.ts`（6）、
  `external-reload-merge.test.ts`（6）、`transfer.integration.test.ts`、`media-reference-remap.test.ts`、`media-index.test.ts`（3）。

> 说明：video-transform-real-media 的 1 个跳过项为环境/需求前尚未支持的能力，按 N/A 记录。

## 五、结论

- batch3 累计新增 PASS：约 600+ 契约与执行器用例 + 真实 FFmpeg 媒体用例，全部绿色。
- 本地支撑节点（text/JSON/processor/structured/file/code/storyboard/image-crop/image-split/image-edit/director/iterate/ai-process/chat）
  的契约、执行语义与真实媒体写入均有自动化证据。
- 仍 BLOCKED/GAP：所有远程生成（image-gen、video、speech、tts、voice-design）、模型可见性 MD01、文档真机 WORD/XLSX/PPTX
  （仅有 PDF/文本，DOCX 等由 batch0 B5 记录为字段差异）、以及需外部凭据/像素级 UI 几何的用例。
- 与 batch0-2 结论一致：全量门禁基线不绿（lint 7、单测 13、node-matrix 脚本过期），发布候选门槛不满足，均为记录项未修改。

## 六、后续

- batch4：需真实 UI 逐节点的 C01–C12 组合验证（已有受控桌面入口证据），以及资产管理面板真实交互（AS 系列）。
- 远程真实调用：等用户授权凭据/预算。