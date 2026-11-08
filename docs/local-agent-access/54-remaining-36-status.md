# 第十轮：36 项剩余项 — 完成 21 项，剩 24 项（含已获授权的边界）

日期：2026-11-08 更新。用户要求"把没有完成的 36 项全部完成"，并就三个边界问题给了明确授权。
本文件记录**已完成、剩余、以及授权后的实施口径**。

## 一、本轮（第九~十轮）完成：21 项

| 批次 | 项数 | 提交 | 内容 |
| --- | --- | --- | --- |
| F7 收尾 | 6 | `0d8190d` | 结构包导出、产物谱系读取、素材批量导出、资源捕获×2（+saveRecipe 明确不开放） |
| F6 收尾 | 3 | `77930aa` | chatStart/chatCancel 映射、director.edit 映射 |
| F3 部分 | 1 | `77930aa` | storyboard.edit 映射 |
| F2 收官 | 5 | `9a25be0` | 节点复制、对齐均分、组合解组（4 个 graph.patch 新 op）、撤销重做、关闭项目 |
| F5 收尾 | 2 | `e4710a8` | video-depth/video-clay 代码层接通 |
| F9 只读 | 3 | `e4710a8` | provider.list / listExecutable / exportableConnections |
| F9 网络 | 2 | `1db4d7b` | provider.testConnection、model.validate（显式确认才执行） |

当前：**129 项外部操作**，external 映射业务动作 **160 / 213**，全仓 **3083 通过 / 0 失败**。

## 二、用户已授权的三个边界（本轮确认）

1. **网络/计费请求**：开放，但**必须显式确认且默认不执行**。
   → 已落地为 `confirmNetwork`（+`confirmCost`）闸门，测试断言"未确认时零请求"。
2. **凭据包**：允许**导出与预览**到受控目录；**导入必须人工确认**。
   → 待实施：导出/预览走受控目录 + 包指纹回执；导入走"外部 prepare → 人在 GUI 确认 → 外部继续"。
3. **发布/协作/结果切换**：按**人工确认后放行**。
   → 待实施：publication 与 result-select 复用导演台那套授权协议；cooperate 先补 actor/source 维度。

## 三、剩余 24 项与实施口径

### A. 永不开放（8 项）— 安全红线

`ipc.license.*` 全部。理由：授权签发/挑战/证明/策略导入若对外部开放，等于让 Agent 自证设备、
自签授权或改撤销策略，授权门禁失去意义。`AGENT_PARITY_SPEC §6` 列为红线，用户的三项授权
也未涵盖这一条。这 8 项将长期保留为 excluded，并在台账写明。

### B. 已授权、待实施（7 项）

| 项 | 实施口径 | 主要工作 |
| --- | --- | --- |
| `sealPackage` / `previewPackage` / `exportProviders` | 导出/预览到受控目录，回执包指纹（sha256/字节数/连接数），不返回密钥 | 注入 `KeyPackageService`，导出走受控目录而非原生对话框 |
| `importPackage` / `importProviders` | 外部 prepare → 人在 GUI 确认 → 外部 continue | 需新增"凭据包导入待确认"队列 + 渲染器确认界面 |
| `publication`（F8） | 人工确认后放行，复用导演台授权协议 | 桌面动作 + prepare/authorize/status/continue |
| `result-select`（F3） | 人工确认后放行（改结果版本会影响下游） | 新增渲染器权威动作 |
| `cooperate`（F8） | 先补 actor/source 维度再开放 | 协作事件模型扩展 |

### C. 需要重构才能做（3 项）

| 项 | 阻碍 |
| --- | --- |
| `models.discover` | 逻辑内联在 `models.ipc.ts`；该文件有并行未提交改动（auth/keystore/edition），现在抽取会冲突。需等那批工作落定后抽成共享函数 |
| `models.validateAgentToolCalling` | 同上（内联在 IPC，含多轮工具调用编排） |
| `diagnostics.exportNodeRun` | 依赖 renderer 内存里的运行记录；需先把"节点运行历史"持久化成可查询契约 |

### D. 需要真人或专项（6 项）

| 项 | 说明 |
| --- | --- |
| `dreaminaLoginStart` / `Check` | 第三方登录必须真人；按授权口径做成"外部准备 → 人登录 → 外部检查"，需要协作者身份协议 |
| `saveProvider` / `deleteProvider` | 写入涉及 api_key_ref 与遗留档案兼容，需与设备密钥库写入协议一起设计 |
| `probeProvider` | 需要 draft 配置（含候选地址）才能探测；外部传地址会开放地址探测面，需先定"只对已保存供应商探测"的收窄方案 |
| （余下为 A 类的 8 项 license） | — |

## 四、数字汇总

| 指标 | 值 |
| --- | --- |
| 外部操作 | **129** |
| external 映射业务动作 | **160 / 213** |
| 全仓测试 | **3083 通过 / 7 跳过 / 0 失败** |
| 门禁 | typecheck / audit / verify:agent-access / verify:logging 全绿 |
| 36 项完成度 | **21 完成，8 永不开放，7 已授权待实施，3 待重构，6 需真人/专项** |
