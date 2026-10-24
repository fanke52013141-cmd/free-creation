# A1.2 复制与预检确认删除交付台账

日期：2026-10-24。授权：用户确认继续后续开发。前包基线见[A1.1](06-a1-1-desktop-projects.md)。本包不改变 A1.1 已验收边界。

## 1. 用户路径与支持范围

Agent读取源项目权威版本 → `project.clone` 固定源版本复制（活动源先保存握手）→ 桌面可独立打开克隆 → `project.delete.precheck` 读取影响摘要与占用阻塞项并领取短期确认令牌 → 凭令牌 `project.delete` 硬删除隔离副本 → 同 key 重试返回原回执，同名新项目不受影响。

| 操作                     | 当前实现                                                                 | 边界                                                                                       |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `project.clone`          | 新增；复用仓库 `cloneProject` 的媒体 ID/结构化引用/固定资产重映射与事务   | 必传源 `expectedGraphVersion` 与新名称（≤120 字符）；克隆 graphVersion 归零，不继承运行任务 |
| `project.delete.precheck`| 新增（只读）；返回节点/边/组/媒体数量与字节数、资源使用计数、阻塞项与令牌 | 活动画布、恢复副本或任务占用时列为 blocker，不签发令牌；令牌 10 分钟有效                    |
| `project.delete`         | 新增；校验令牌后复用仓库现有硬删除（DB 行 + 项目目录清除）                | 无令牌、伪造、过期或事实漂移（修订/影响变化）拒绝且需重新预检；活动画布与占用拒绝           |

CLI/MCP 共用 14 项操作（effect 新增 `delete` 类别，仍要求幂等键）。HTTP、导入、节点编辑/执行未开放，31 类节点仍为 planned。

## 2. 使用方式

```powershell
node .\out\main\local-agent.js project clone --input-file .\clone.json
node .\out\main\local-agent.js project delete precheck --input-file .\precheck.json
node .\out\main\local-agent.js project delete --input-file .\delete.json
```

克隆输入：`{"input":{"projectId":"源ID","expectedGraphVersion":7,"name":"新名称"},"idempotencyKey":"本次新key"}`。活动源先经桌面握手保存，实际克隆版本可能高于输入；冲突应重读。

删除两步：先 `project.delete.precheck` 只读预检；`blockers` 为空时返回 `impactToken`（10 分钟有效，HMAC 绑定实例、目标、权威修订与影响摘要）。删除输入携带该令牌与新的幂等键。令牌不是幂等键、不是人工授权凭据；修订或影响事实在删除时重算并比对，任何漂移返回 `IMPACT_TOKEN_INVALID`，需重新预检而不是重发。

## 3. 准入、恢复与兼容

- 克隆沿用既有非读操作准入：占用（任务/恢复副本）拒绝、串行化副作用、幂等键全生命周期回执。仓库克隆自身为 staging 目录 + 目录改名 + 单事务提交，失败清理不残留半成品。
- 删除准入顺序：占用检查 → 活动画布拒绝 → 令牌校验（缺失 `IMPACT_CONFIRM_REQUIRED`；伪造/过期/漂移 `IMPACT_TOKEN_INVALID`，阶段 `delete-admission`）→ 硬删除。删除后同 key 返回原回执；新 key 对已删项目返回 `NOT_FOUND`；同名新项目是不同身份，不受影响。
- 删除不新增回收站或软删除；与桌面现有硬删除行为一致（均不级联清理 media 表与 library_usages 孤儿行，该共享边界维持现状，未在本包扩大）。
- 兼容：v1 纯增量。既有 11 项操作 Schema 未变；`delete` 为新 effect 类别，旧客户端不感知。崩溃窗口与既有写操作一致：受理后中断按 unknown 回执处理，不重放。

## 4. 日志与接入影响检查

范围：Registry、main 公共服务；未修改仓库层、传输层、preload/renderer 与节点契约。

复用 `agent.access.started` 及唯一 `completed/failed/unknown/rejected` 终态，由 main 公共入口记录；新增失败阶段 `delete-admission`。预检只读不产生副作用终态之外的事件；令牌 HMAC 密钥沿服务既有本地密钥，不写入诊断。事件仍只含 operation/phase/code 与安全关联 ID；不记录项目名称、令牌、路径或影响明细。logger 拒写不改变业务；账本受理拒写仍阻断副作用。

影响：新增 3 个 operation 及 `delete` effect；契约快照与影响声明已按门禁刷新（14 项操作）；门禁仍为登记、生成一致性与源码影响确认，不宣称完整语义兼容自动判定。

## 5. 验证记录

定向单元 28/28 通过（前包 22 + 新增 6）：关闭项目固定版本克隆（源不变、节点 ID 重映射、幂等重放、陈旧版本/缺失项目拒绝）、活动源先握手后克隆且正文不入日志、预检影响与占用扣发令牌、删除无令牌/伪造令牌/事实漂移拒绝且每次 started 恰一终态、确认删除后文件清除与回执保留及同名保护、活动项目删除在任何令牌下拒绝。

源码真实桌面闭环通过：CLI 克隆当前活动项目（含最新未保存文本经握手落盘）、预检令牌守卫（无确认/伪造拒绝）、确认删除、同 key 回执重放、已删项目 `NOT_FOUND`、源项目完好；MCP 工具目录 14 项；实际 JSONL 生命周期配对与脱敏（含克隆名称）通过。证据 `qa/local-agent-access/vertical-slice/report.json`。

完整验证`qa/verification/run-ZfT4VL/`退出0（2026-10-24 17:28–17:52本地）：单元2499通过/5既有跳过（含本包新增6项）、模型2、类型/lint/日志/接入/浏览器门禁、构建、接入桌面验收（含克隆/删除腿）、全部桌面专项及R09通过。基于该run源码的独立目录包`dist/local-agent-access-a12-20261024/win-unpacked/`构建并通过安装版真实CLI/MCP闭环（含14项工具目录），入口哈希与源码构建一致、官方MCP SDK及依赖随包，证据`qa/local-agent-access/a12-package-manifest.json`与`a12-package/installed-vertical-slice/`；未做安装器发布与签名。A1.2（复制与预检确认删除）就此关闭；HTTP、导入、节点编辑/执行与第三方MCP客户端仍按计划推进。
