# 第九轮：36 项剩余项推进结果（完成 10 项，26 项需要授权/协议/环境）

日期：2026-11-08。用户要求"把没有完成的 36 项全部完成"。本轮按此推进，结果如下：
**完成 10 项**（F2 5、F5 2、F9 3），**剩余 26 项**全部归类，其中 8 项我不会做（安全红线）、
18 项需要用户授权/协议设计/真实环境。

## 一、本轮完成（10 项，3 个提交）

### F2 画布编辑五件套：5 → 0（`9a25be0`）

| 动作 | 外部路径 | 关键设计 |
| --- | --- | --- |
| `canvas.node.duplicate` | `graph.patch` 新 op `node.duplicate` | 复制结构但**不带运行结果与状态**（meta 清空、exec=idle） |
| `canvas.align` | 新 op `layout.align` | 六种模式与 GUI 多选工具栏**同一算法** |
| `canvas.group.toggle` | 新 op `group.create` / `group.delete` | 与 GUI 同一 `groupShapes`/`ungroupShapes`；对非 group 解组提前拒绝 |
| `canvas.history.undo-redo` | 新操作 `canvas.history` | 必须经权威宿主（历史栈在 editor 里，main 不复制）；**不撤销远端副作用** |
| `ipc.project.close` | 新操作 `project.close` | 先保存再回列表；失败时**不清** lastProjectId |

契约：`graph.patch` 的 op union 属**追加式扩展**（既有 6 种 op 未变），已用
`--accept-contract-change` 显式接受并写明兼容结论。

### F5 两项：2 → 0（`e4710a8`）

`video-depth` / `video-clay` 按用户"只做代码层接通"的要求映射到 `node.execute` + `run.*` +
`output.get`，note 写死"需本机 Python+CUDA 环境；环境缺失时如实失败、**真实转换从未实测**"。

### F9 供应商只读：3 项（`e4710a8`）

`provider.list` / `provider.listExecutable` / `provider.exportableConnections`——复用 GUI 模型
设置同一来源，字段白名单**不返回 baseURL、鉴权头或密钥引用**。

## 二、剩余 26 项：分三类

### A. 我不会做（8 项）——安全红线

`ipc.license.*` 全部（getStatus / probeDevice / exportRequest / importChallenge / exportProof /
importLicense / importPolicy / getDiagnostic）。

原因：授权体系的申请/挑战/证明/签发/策略导入如果对外部 Agent 开放，等于让 Agent 能**自证设备、
自签授权或改撤销策略**，直接摧毁授权门禁的意义。`AGENT_PARITY_SPEC §6` 把这条列为红线。
"人怎么操作 Agent 就怎么操作"在这里**不适用**——授权是人对软件的许可行为，不是业务动作。

### B. 需要你明确授权/给边界（5 项）——会联网、可能计费

| 动作 | 为什么需要你决定 |
| --- | --- |
| `ipc.models.discover` | 向供应商 `/models` 发请求，消耗密钥配额、可能被限流 |
| `ipc.models.validate` | **真实调用模型**，可能计费 |
| `ipc.models.validateAgentToolCalling` | 同上，且要跑工具调用回合 |
| `ipc.keys.testProvider` | 向供应商发测试请求 |
| `ipc.keys.probeProvider` | 探测供应商连通性与能力 |

技术上都能做（复用 GUI 同一服务 + 显式 `confirmNetwork: true`），但按你之前"付费/网络请求要
谨慎"的要求，我需要你给一次明确授权：**是否允许外部 Agent 触发这类请求**，以及是否限次数/限供应商。

### C. 需要协议设计或真实环境（13 项）

| 组 | 数量 | 缺什么 |
| --- | --- | --- |
| 凭据包（seal/preview/importPackage、exportProviders/importProviders） | 5 | 需要 KeyPackageService 注入 + 一套"导出即离开设备"的确认与审计协议（`.cskeys` 含加密凭据，属高阶密钥迁移） |
| `saveProvider` / `deleteProvider` | 2 | 写入涉及 api_key_ref 与遗留档案兼容，需要与设备密钥库的写入协议一起设计 |
| Dreamina 登录 2 项 | 2 | 必须真人完成，需要"外部 prepare → 人在 GUI 完成 → 外部 status/continue"的协作者身份协议（与导演台发布同量级） |
| `diagnostics.exportNodeRun` | 1 | queue 依赖 renderer 内存运行记录，需先把"节点运行历史"持久化成可查询契约 |
| `flowAgents.publication` | 1 | 需要独立发布授权协议（谁能发布、发布到哪、是否需要人工确认） |
| `flowAgents.cooperate` | 1 | 协作事件缺 actor/source 维度，需先扩展协作模型 |
| `canvas.node.result-select` | 1 | 需要新的渲染器权威动作（切换结果版本并影响下游），语义接近"改运行事实" |

## 三、数字

| 指标 | 本轮初 | 本轮末 |
| --- | --- | --- |
| 外部操作 | 122 | **127** |
| external 映射业务动作 | 148 | **158** |
| F2 计划项 | 5 | **0** |
| F5 计划项 | 2 | **0** |
| F9 计划项 | 26 | **23** |
| F3 / F8 计划项 | 1 / 2 | 1 / 2 |
| 全仓测试 | 3054 | **3075 通过 / 7 跳过 / 0 失败** |

## 四、需要你回答的三个问题

1. **B 类的 5 项网络请求**：是否授权外部 Agent 触发？如果要，给个次数/供应商上限，我按限流实现。
2. **凭据包 5 项**：是否允许外部把加密凭据包导出到受控目录？这是安全边界问题（导出即离开设备）。
3. **F8 发布/协作 2 项 + F3 结果切换**：这三项都要先定协议（谁能发布、协作的 actor 从哪来、
   结果版本切换算不算改运行事实）。要我按"人确认后才放行"的模式设计吗？

license 8 项无论你怎么答我都不会开放。
