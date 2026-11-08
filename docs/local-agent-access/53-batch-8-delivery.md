# 第八轮交付汇总：F7 清零 + F6 清零 + 剩余计划项盘点

日期：2026-11-08。承接 [51 号汇总](51-batch-7-delivery.md)。本轮按"继续"推进，完成
**F7 剩余 6 项**（开放 5、明确不开放 1）与 **F6 剩余 3 项**（映射 2、排除/映射 1），
F7 与 F6 计划项均清零。

## 一、数字

| 指标 | 上轮末 | 本轮末 |
| --- | --- | --- |
| 外部操作 | 117 | **122** |
| external 映射业务动作 | 139 | **148** |
| F7 计划项 | 6 | **0** |
| F6 计划项 | 3 | **0** |
| F3 计划项 | 2 | **1**（result-select 需新桌面动作） |
| 全仓测试 | 3044 | **3054 通过 / 7 跳过 / 0 失败** |

本轮提交：`0d8190d`（F7 收尾 5 项）、本轮末的 F6/F3 映射（只改 action-coverage + 清单）。

## 二、F7 收尾（`0d8190d`）

开放 5 项（台账 52）：
- `project.exportStructure`：导出**已保存**结构包到受控目录；无画布快照给明确码
  `STRUCTURE_SNAPSHOT_MISSING`
- `media.getRecipe`：读产物谱系，**绝不返回提示词正文**；参数走公共脱敏；媒体必须属于本项目
- `media.batchExport`：批量导出到受控目录新子目录，逐项回执、同名不覆盖
- `library.captureProjectMedia` / `captureProjectNodes`：画布→资源库采集；节点要校验真实存在、
  类型一致、媒体归属

不开放 1 项：`media.saveRecipe` —— 生成来源是运行事实，外部写入等于伪造谱系。

## 三、F6 收尾（映射，零新增操作）

| 动作 | 外部路径 | 依据 |
| --- | --- | --- |
| `ipc.keys.chatStart` | `node.execute` + `run.*` | GUI 就是 chat/ai-process 节点执行；无凭据时与 GUI 同因失败 |
| `ipc.keys.chatCancel` | `run.cancel` | 取消请求与确认分离 |
| `canvas.director.edit` | `graph.patch` + `node.get` | 导演台工程经 config 通道编辑；发布另有授权协议，不能经 node.execute 偷渡 |
| `canvas.storyboard.edit` | `graph.patch` + `node.get` | 分镜板经 text/config 通道编辑，输出经 output.get |

## 四、过程中修复的真实问题（两次都是我自己引入的）

1. **结构包导出对无快照项目返回模糊错误**：只经 `graph.patch` 建图、从未在 GUI 保存过的项目
   没有 `tldrawSnapshot`，公共 `cleanSnapshot` 抛"画布快照无效或版本不受支持"，被映射成
   `PACKAGE_CONTENT_INVALID`。已在入口显式检查并返回 `STRUCTURE_SNAPSHOT_MISSING` + 可执行提示
   （"先打开 GUI 保存一次"）。
2. **case 组被切断**：我把 capture 的两个 `case` 插进了 library case 组中间，打断了 fall-through，
   让**整个资源库族 12 个测试**全部落到 `UNSUPPORTED_OPERATION`。已把 capture case 移到
   library 组之后，并在代码里加注释说明"必须放在组之后"，避免重犯。

## 五、剩余计划项全景（共 36 项，全部有明确原因）

| 阶段 | 数量 | 内容与原因 |
| --- | --- | --- |
| F9 | 26 | `keys.*` 12（凭据包属高阶密钥迁移协议）、Dreamina 登录 2（必须真人）、
`models.discover/validate` 3（会向供应商发请求、validate 可能计费）、`license.*` 8（安全红线）、
`diagnostics.exportNodeRun` 1（依赖 renderer 内存记录） |
| F2 | 5 | `project.close`、节点复制、组合/解组、对齐均分、撤销重做 —— **都需要新的
`graph.patch` op 类型或新的渲染器权威动作**（撤销重做尤其涉及历史栈语义），属画布编辑专项 |
| F8 | 2 | `cooperate`（协作事件缺 actor/source 维度）、`publication`（需独立发布授权协议） |
| F5 | 2 | `video-depth` / `video-clay`：需本机 CUDA 环境安装后专项验收 |
| F3 | 1 | `result-select`（结果版本切换）：需要新的渲染器权威动作 |

## 六、真实门禁

- `npm run verify:agent-access` → 122 operations；32 planned nodes
- `node scripts/audit-business-actions.cjs` → 171 IPC + 42 画布动作；**external 148 / 213**
- `npm run typecheck` → 0 错误；`npm run verify:logging` → 通过
- 全仓测试 → **3054 通过 / 7 跳过 / 0 失败，退出码 0**

## 七、下一步建议

剩余 36 项里，**F2 的 5 项（画布编辑：复制/组合/对齐/撤销重做/关闭项目）是最值得做的**——
它们是纯本地能力、不花钱、且是"人怎么操作 Agent 就怎么操作"里高频的编辑动作。做法是给
`graph.patch` 增加 `node.duplicate` / `group.create|delete` / `layout.align` 三类 op，
再为撤销重做单独设计（它涉及历史栈，不能简单做成 patch）。

其余：F8 两项需要协议设计（协作者身份 / 发布授权），F9 需要用户决策网络请求边界，
F5 需要 CUDA 环境，F3 需要新桌面动作。
