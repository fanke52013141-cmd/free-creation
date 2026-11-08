# 第四轮交付汇总：F9 读取/配置批 + 逐节点动作矩阵

日期：2026-11-08。承接 [35 号汇总](35-batch-3-delivery.md)。按用户指定顺序推进：
先做 F9 的读取/配置类（零付费风险），再做逐节点动作矩阵机器化。
用户同时明确：**语音克隆、音色设计、视频生成只做代码层接通，不做真实调用/产物，测试由用户自己进行**；
图片生成可测但保持最小。

## 一、数字

| 指标 | 上轮末 | 本轮末 |
| --- | --- | --- |
| 外部操作（CLI/MCP 同源） | 86 | **95** |
| external 映射业务动作 | 91 | **99** |
| 未开放动作 | 97 | **89**（其中有 19 项属付费族，见第四节） |
| 接入测试 | 157 | **178** |
| 逐节点动作矩阵 | 全部占位 `planned` | **32 类 × 8 动作 = 256 格带状态与证据** |

本轮提交：

| 提交 | 范围 |
| --- | --- |
| `d0a1d2b` | F9（二）模型目录与本地环境读取 6 项（只读、零联网、零付费） |
| `bf1db25` | F9（三）诊断查询 + 项目节点可见集读写 3 项 |
| `eb364c3` | F9（一）逐节点动作矩阵（N1–N8）机器化 + 门禁工作区路径解析 |
| `381de00` | F9（二）收尾：台账/注释修订 + 受保护源码哈希声明 |

## 二、本轮开放的 9 项能力

1. **模型目录（4 项只读）**：`model.connection.list` / `model.definition.list` /
   `model.binding.list` / `model.binding.resolve`。
   **去敏是字段白名单**：连接只回 id/名称/协议/启用状态/时间（不返回 apiKey、密文、
   鉴权头、完整端点）；定义不回 controls/metadata/验证原文；resolve 逐字段构造。
2. **本机环境（2 项只读）**：`environment.local`（ffmpeg/python/GPU/IndexTTS 就绪状态）、
   `environment.videoEngine.status`。只读、不安装、不下载，不泄漏本机绝对路径。
3. **诊断查询（1 项只读）**：`diagnostics.query`，复用 GUI 运行详情的同一服务；
   分页有界、事件白名单投影 + 二次脱敏 + 截断；服务不可用如实报错，不拿空数组冒充成功。
4. **项目节点可见集（读 + 写）**：`project.nodeVisibility.get/set`。这是"人能改调色板、
   Agent 也能改"的直接落点（背景见台账 34 的可见集缺陷）；写只接受可创建类型，
   经正式保存路径落盘、不推进图版本、幂等重放不重复写。

**明确不开放**（逐项写在台账 36/37）：`models.discover`/`validate`/`validateAgentToolCalling`
（联网/可能计费）、连接与定义的 save/delete（受控凭据需独立凭据包）、`keys.*`/`license.*`
（不得绕过密钥库与授权）、视频引擎安装、节点运行诊断导出（需先定受控导出契约）。

## 三、逐节点动作矩阵（本轮的结构性交付）

`node.type.list` 不再对 32 类节点一律报 `planned`，而是返回 **N1–N8 逐动作状态 + 可复核证据**：

- 五档状态：`desktop-tested`（真实桌面里程碑有对应检查）/ `contract-tested`（服务级或契约级）/
  `implemented`（有实现但无证据，**门禁直接拒绝**）/ `planned` / `not-applicable`（必须给理由）；
- 门禁 `validateAccessRegistry()` 现在同时校验矩阵自洽性：缺类型、缺动作、非法状态、
  空证据、悬挂 `implemented` 都阻断；
- 填格时坚守边界：服务级测试不写成桌面级；付费族统一 `planned` 并写明"从未实测"；
  Agent/状态机/审核的 N2/N5/N7 因不能伪造内部身份标 `planned`，N8 标 `not-applicable` 带理由。

**矩阵暴露出的最大空白**：N1（查询某类节点的默认值、字段、端口、依赖）仍全部 `planned`——
外部目前只能通过创建实例再 `node.get` 间接得知端口，而不创建实例就无法查询。
根因是 main 不能 import renderer 的 TSX 节点规格（F1 遗留项）。下一包建议先做这件事。

## 四、本轮真实门禁

- `npm run typecheck` → 0 错误（node/web/license-protocol/issuer）
- `node scripts/audit-business-actions.cjs` → 171 IPC + 40 画布动作；**external ops 95**；
  按阶段 external 99 / F9 36 / F8 11 / F5 19 / F4 7 / F7 6 / F2 5 / F6 3 / F3 2 / excluded 23
- `npm run verify:agent-access` → **95 operations；32 planned nodes**（矩阵自洽校验通过）
- 18 个接入测试文件 → **178 项通过**
- 契约：新增 9 项为纯追加；`node.type.list` 输出结构变更已用 `--accept-contract-change`
  显式接受并写明兼容结论（无已发布第三方客户端；CLI/MCP 同源生成无需迁移）

## 五、仍未完成（按用户指定顺序的下一步）

1. **F8 剩余 11 项**（下一步）：Flow `run/pause/stop/review/build/publication` 需要 main 注入
   **共享宿主句柄**；`flow.command.dispatch/prepare/check/abort` 需要**外部主体 + 租约协议**
   （含 DB 迁移）——两件都是架构性改动，不能靠伪造内部身份绕过。
2. **N1 共享节点契约抽取**（矩阵最大空白，建议紧随 F8）：esbuild 打包 specs →
   `node-contracts.json` → 新操作 `node.type.get`，让 Agent 不创建实例也能查到端口/默认值/依赖。
3. **付费族只做代码层接通**（用户要求）：image-gen/image-edit/video/speech/tts/voice-design
   的外部参数→执行器映射已存在，需补"接线级"证据（不产生真实调用/产物），
   **真实生成测试由用户自己进行**。
4. **F10**：干净克隆构建、真实安装包、真实 MCP 客户端逐动作一致性。
5. 已开放项的桌面补验：外部 set 可见集 → GUI 重开调色板一致；诊断查询与 GUI 运行详情一致。
