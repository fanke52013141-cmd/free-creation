# 第十一轮：36 项剩余项 — 完成 23 项，剩 23 项

日期：2026-11-08 更新。用户要求"把没有完成的 36 项全部完成"，并就三个边界问题给了明确授权。
本文件记录**已完成、剩余、以及授权后的实施口径**。

## 一、已完明：23 项

| 批次 | 项数 | 提交 | 内容 |
| --- | --- | --- | --- |
| F7 收尾 | 6 | `0d8190d` | 结构包导出、产物谱系读取、素材批量导出、资源捕获×2（+saveRecipe 明确不开放） |
| F6 收尾 | 3 | `77930aa` | chatStart/chatCancel 映射、director.edit 映射 |
| F3 收尾 | 2 | `77930aa` + `cd6643b` | storyboard.edit 映射；结果版本切换（`node.select-result` op） |
| F2 收官 | 5 | `9a25be0` | 节点复制、对齐均分、组合解组（4 个 graph.patch 新 op）、撤销重做、关闭项目 |
| F5 收尾 | 2 | `e4710a8` | video-depth/video-clay 代码层接通 |
| F9 只读 | 3 | `e4710a8` | provider.list / listExecutable / exportableConnections |
| F9 网络 | 2 | `1db4d7b` | provider.testConnection、model.validate（显式确认才执行） |

当前：**129 项外部操作**，external 映射业务动作 **161 / 213**，全仓 **3086 通过 / 0 失败**。

**F2 / F3 / F5 / F6 / F7 计划项全部清零。**

## 二、用户已授权的三个边界（已记录）

1. **网络/计费请求**：开放但必须显式确认、默认不执行 → **已落地**（`confirmNetwork` / `confirmCost`）。
2. **凭据包**：允许导出与预览到受控目录；导入必须人工确认 → **待实施**。
3. **发布/协作/结果切换**：人工确认后放行 → 结果切换**已完成**（`cd6643b`）；发布/协作待实施。

## 三、剩余 23 项

### A. 永不开放（8 项）— 安全红线

`ipc.license.*` 全部。授权签发/挑战/证明/策略导入对外开放 = Agent 可自证设备、自签授权、
改撤销策略，授权门禁失去意义（`AGENT_PARITY_SPEC §6`）。用户三项授权未涵盖，长期 excluded。

### B. 卡在 IPC 并行改动（4 项）— 需先抽共享函数

| 项 | 阻塞 |
| --- | --- |
| `models.discover` / `validateAgentToolCalling` | 逻辑内联在 `models.ipc.ts`（该文件有并行未提交改动） |
| `flowAgents.publication` / `cooperate` | 人工确认协议内联在 `flow-agents.ipc.ts`（webContents.send + 快照轮询） |

这 4 项的**正确做法**都是"把 IPC 里的实现抽成 main 侧共享函数，IPC 与 agent-access 都调用它"，
但现在直接改会与并行未提交的 auth/keystore/edition 工作冲突。等那批落定即可继续。

### C. 需注入服务或新增队列（5 项）

| 项 | 缺什么 |
| --- | --- |
| 凭据包导出/预览 3（sealPackage / previewPackage / exportProviders） | 需把 `KeyPackageService`（在 `index.ts` 构造）注入 `LocalAccessService`；导出改走受控目录 + 包指纹回执 |
| 凭据包导入 2（importPackage / importProviders） | 需新增"待确认导入"队列 + 渲染器确认界面（人工确认后放行） |

### D. 需真人或专项（6 项）

`dreaminaLoginStart` / `dreaminaLoginCheck`（必须真人）、`saveProvider` / `deleteProvider`
（与设备密钥库写入协议一起设计）、`probeProvider`（需收窄成"只对已保存供应商探测"）、
`diagnostics.exportNodeRun`（先把节点运行历史持久化成契约）。

## 四、数字汇总

| 指标 | 值 |
| --- | --- |
| 外部操作 | **129** |
| external 映射业务动作 | **161 / 213** |
| 全仓测试 | **3086 通过 / 7 跳过 / 0 失败** |
| 36 项完成度 | **23 完成 / 8 永不开放 / 4 待 IPC 抽取 / 5 待服务注入 / 6 待真人或专项** |
