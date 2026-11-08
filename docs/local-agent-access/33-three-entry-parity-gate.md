# F9（一）三入口目录一致性门禁 + 反向覆盖检查

日期：2026-11-08。基线：`cf84a25`。对应 [AGENT_PARITY_SPEC](../../AGENT_PARITY_SPEC.md) §8
「自动检查与发布条件」表的第 2 行（三入口目录）与第 1 行（功能清单完整性）的一部分。

## 1. 先说这个门禁堵的是什么洞

CLI 与 MCP 都由同一个 Operation Registry 派生，看起来"自动一致"，但实测仍有四类真实风险，
此前的审计脚本一个都没查：

| 风险 | 实际后果 |
| --- | --- |
| **孤儿操作**：登记在 Registry、但没有任何业务动作引用 | 外部做了 GUI 根本没有对应入口的事（违反 §1.7），或登记了没人需要的能力；实测一次查出 **11 个** |
| **CLI 保留字遮蔽**：操作 ID 首段为 `key`/`contracts`/`mcp` | 命令永远走不到业务实现，而是进了保留子命令 |
| **MCP 撞名**：`a.b_c` 与 `a_b.c` 都派生为 `a_b_c` | 其中一个工具永远无法被真实客户端调用 |
| **外部动作没有 GUI 入口说明**（`gui` 为空） | 三个入口的"同一业务动作"缺少可审查依据 |

## 2. 实现范围

### 2.1 `scripts/audit-business-actions.cjs`（门禁加强）

新增检查（任一失败即阻断）：

- `ORPHAN_EXTERNAL_OP:<op>`：每个已登记操作必须被至少一个业务动作的 `external` 引用；
- `STALE_EXCEPTION` / `STALE_EXCEPTION_MAPPED`：例外清单不得腐化（写进清单的操作若已不存在
  或已被正常映射，都要报错），避免"例外变成永久豁免"；
- `EXTERNAL_WITHOUT_GUI:<action>`：标为已开放的动作必须写清 GUI 入口（空串不算）；
- `MCP_NAME_INVALID` / `MCP_NAME_DUPLICATE`：MCP 工具名必须符合 `[a-zA-Z0-9_-]{1,64}` 且唯一；
- `CLI_TOKEN_EMPTY` / `CLI_RESERVED_TOKEN` / `CLI_STATUS_ALIAS_CONFLICT`：CLI 令牌不得为空、
  不得撞保留子命令、`status` 别名只能指向 `app.status`。

显式例外（带原因，写在脚本里，可审计）：

| 操作 | 类别 | 原因 |
| --- | --- | --- |
| `capability.list` | META | 协议自省：列出当前已开放操作，无对应 GUI 业务动作 |
| `node.type.list` | META | 协议自省：列出节点接入状态，GUI 通过节点注册表直接读取 |
| `node.library.update` | EXTERNAL_ONLY | GUI 节点库面板当前没有重命名入口；外部重命名复用同一 store 写口，待 GUI 补同入口或下线该操作 |

### 2.2 分母补齐（`docs/local-agent-access/action-coverage.json` + `CANVAS_ACTIONS`）

孤儿检查一次查出 11 个"登记了但分母里没有来源"的操作。逐个核实 GUI 是否真有对应入口后处理：

| 操作 | 处置 |
| --- | --- |
| `chat.read` / `chat.messages` | 新增分母 `canvas.chat.read-messages`（对话面板读取会话目录与消息正文） |
| `chat.skill.list` / `chat.skill.bind` | 新增分母 `canvas.chat.skill-bind`（对话节点绑定/查看已安装技能版本） |
| `run.get` / `run.wait` | 新增分母 `canvas.run.observe`（运行时间线/任务状态查询） |
| `model.list` | 新增分母 `canvas.model.catalog`（模型设置页读取本地模型与验证状态） |
| `project.get` | 新增分母 `canvas.project.read-summary`（项目页/打开项目时读取项目摘要） |
| `capability.list` / `node.type.list` | 协议自省，进 META 例外（有原因） |
| `node.library.update` | GUI 无重命名入口，进 EXTERNAL_ONLY 例外（写明后续处置） |

说明：**新增分母不是给通过找台阶**——这五个动作都是 GUI 里真实存在的读取入口，此前只是
没有独立登记；登记后它们也受 `EXTERNAL_WITHOUT_GUI` 与反向覆盖检查约束。

### 2.3 `test/local-agent-parity.test.ts`（运行时一致性，6 项）

自动派生只能证明"规则一致"，不能证明"运行时真的这样"。这组测试直接启动
`LocalAccessService`（隔离数据目录）验证：

1. 全部操作的 MCP 工具名唯一且合法；
2. CLI 命令不被 `key`/`contracts`/`mcp` 遮蔽，`status` 别名只指向 `app.status`，无空令牌；
3. 每个操作都有合法 effect 与人可读描述（不是把 ID 抄一遍）；
4. `capability.list` 返回的操作目录与 Registry **完全相同（含顺序）**，限制项非空且包含
   `DESKTOP_HANDSHAKE_REQUIRED` / `DIRECTOR_PUBLISH_REQUIRES_HUMAN_AUTHORIZATION`；
5. `node.type.list` 与 `nodeAccessDirectory()` 相同，覆盖全部 32 类 Active 节点并如实标 planned；
6. `app.status` 的实例身份与请求校验一致（dataStoreId / apiVersion / 幂等键格式）。

## 3. 真实验证

- `test/local-agent-parity.test.ts` → 6 项通过；
- `node scripts/audit-business-actions.cjs` → 通过（含新检查；孤儿/例外/命名三类均已清零）；
- 反向覆盖检查在落地瞬间就抓到**正在并行开发的 Flow 操作**（flowAgent.catalog 等 8 项）
  尚未映射业务动作，证明它不是空转检查；这些由对应包在收口时补映射。

## 4. 边界（还没做到的）

1. 门禁没有覆盖"GUI 有动作、外部完全没有表达方式"的方向——那需要从 IPC/画布动作
   到外部操作的**正向**覆盖统计；目前只做到"登记的操作都有来源"（反向）与
   `external` 映射存在性。正向缺口仍靠 `02-capability-matrix.md` 与人工审查。
2. 持久化一致性与故障恢复两类门禁（§8 第 4、5 行）仍未自动化，本轮未做。
3. 安装包/真实 MCP 客户端（§8 第 6 行）属 F10。
4. 例外清单是"有原因的临时状态"，`node.library.update` 要么补 GUI 入口，要么在后续包下线。
