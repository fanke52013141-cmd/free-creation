# 第五轮交付汇总：F8 收官 + N1 节点契约 + 付费族接线证据

日期：2026-11-08。承接 [39 号汇总](39-batch-4-delivery.md)。用户要求"这三块全做"：
① F8 收官；② N1 共享节点契约；③ 付费族只做接线级证据。三项均已完成并提交。
用户同时明确：**F10 的客户端/安装包阶段现在不做**；语音克隆/音色设计/视频生成只做代码层接通，
真实测试由用户自己进行。

## 一、数字

| 指标 | 上轮末 | 本轮末 |
| --- | --- | --- |
| 外部操作（CLI/MCP 同源） | 98 | **106** |
| external 映射业务动作 | 102 | **109** |
| 业务动作分母 | 171 IPC + 40 画布 | 171 IPC + **41** 画布（212） |
| 未开放动作 | 89 | **79**（F8 仅剩 2 项，均有明确不开放理由） |
| 全仓测试 | — | **3002 通过 / 7 跳过 / 0 失败**（进程退出码 0） |
| 真实桌面里程碑 | 45 | **49 项全绿** |

本轮提交：

| 提交 | 范围 |
| --- | --- |
| `2ab54d4` | F8（第二批）Agent 运行控制：flowAgent.run/pause/stop（共享宿主端口） |
| `820e07b` | F8 收官（一）Flow 命令账本：check/dispatch/abort + 命令主体标记 M24 |
| `50d29ee` | N1 节点类型契约目录（node.type.get）+ 矩阵 N1 升级 |
| `bcfb939` | 付费族接线级证据 + 2 处真实接线缺陷修复 |
| `1cd8086` | F8 收官（二）建图提交/审核 + renderer 保存屏障 flush 修正（里程碑 49） |
| `84da41e` | 修复基线陈旧断言（3 个测试跟上早已演进的实现） |

## 二、F8 收官：Flow 外部接入的最后一块

**关键架构决定**：内部 Agent/命令的权威宿主或账本是启动时创建的**单一实例**
（持模型端口、命令交付通道、在途运行表、owner_session）。外部入口一律通过
`flow-bridge.ts` / `flow-command-bridge.ts` 的**窄接口复用同一实例**，绝不另建——
否则就是两个权威、互相覆盖事实。运行身份（requestId/traceId/spanId/commandId）由 main 生成，
外部不能自造。

已开放（本轮新增 10 项）：
- 运行控制：`flowAgent.run` / `pause` / `stop`（start/continue 先走模型工具调用预检）
- 命令账本：`flow.command.check`（回滚事务内预演结算）/ `dispatch` / `abort`
  （`principal='external'`，abort 只对未准入命令生效；prepare 并入 dispatch）
- 建图与审核：`flowAgent.build.inspect|propose|commit`（commit 经新桌面动作 `flow-build`
  交渲染器同一 `commitFlowBuild`）、`flowAgent.review`（输入 schema 不含 passed，外部不能改结论）

仍不开放且写明原因：`cooperate`（协作事件无 actor/source 维度，外部写入与人工输入不可区分）、
`publication`（发布是 main→renderer 运行期等待/继续信号，外部替宿主回执=伪造内部身份）、
`attach/detach/grant/cancel`（渲染器命令桥内部事件，非可调用业务动作）。

付费闸门：命令派发到 video/image-gen/image-edit/speech/tts/voice-design 前必须显式确认，
否则在受理前拒绝——与 node.execute 的付费重跑确认同一原则。

## 三、N1：不创建实例就能查节点契约

节点定义在 renderer TSX 里，main 不能导入。做法：`test/node-contracts-export.test.ts`
在 jsdom 下加载真实注册表，用与 GUI 相同的 `getNodePorts()` 生成
`generated/node-contracts.generated.ts`；普通测试运行时是**漂移门禁**（不同步更新即失败）。
新操作 `node.type.get` 返回契约版本、端口（含 `voice.profile@1` 这类 Schema 引用）、
初始配置、执行方式（含 manual-publish）、输出真值来源、以及 **dynamicPorts 标记**
（true = 端口随配置变化，本记录只是默认配置结果，实例端口须用 node.get 读）。
32 类节点的矩阵 N1 全部由 planned 升级为 contract-tested。

## 四、付费族：只做接线，不做真实调用

`test/paid-family-wiring.test.ts`（15 项）用"记录入参 + 返回假结果"的间谍 gateway 驱动真实
共享执行器，逐字段验证六类（image-gen/image-edit/video/speech×3/tts/voice-design）在调用边界
收到的参数，每例断言 fetch 0 次。过程中修复两个**真实接线缺陷**：

1. image-gen 分辨率档位跨供应商外溢（即梦专属 1.5k 切到 TOAPIS 仍下发 → 供应商 400/静默忽略）；
2. speech 按功能绑定解析模型时 `emotion` 被解析阶段静默丢弃（默认模型猜测导致丢参）。

## 五、两个真实缺陷修复（不是测试妥协）

1. **renderer 保存屏障缺失**：`CanvasEditor` 没有 `flush` 分支，未匹配动作只回已保存版本；
   于是"画布有未保存编辑"时，project.save/rename/export、固定资产提交、命令派发都会读到旧版本
   或被 revision 校验拒绝。现补 flush（取消防抖、脏时强制保存、回真实版本）。
2. **日志异步失败变成未处理拒绝**：`emitGatewayEvent` 只 catch 同步异常，异步 sink 的
   Promise 拒绝会逃逸；Node 15+ 默认把未处理拒绝当致命错误 → 日志故障可能杀掉进程，
   违反 LOGGING_SPEC「日志写入失败不能改变业务结果」。现接住 thenable 并吞掉拒绝。

另有 3 个基线陈旧断言（桌面握手返回形状、滚条例外选择器、v16 并发夹具）已按实现更新——
这三项在全仓测试里长期是红的，本轮把它们修到绿并写明"新增迁移必须同步维护夹具"。

## 六、真实门禁（本轮末）

- `npm run typecheck` → 0 错误；`npm run build` → 通过
- `node scripts/audit-business-actions.cjs` → 171 IPC + 41 画布动作；**external ops 106**
- `npm run verify:agent-access` → **106 operations；32 planned nodes**
- 全仓测试（`--maxWorkers=1`，仓库默认口径）→ **3002 通过 / 7 跳过 / 0 失败，退出码 0**
- `node scripts/test-agent-graph-milestone.cjs` → **passed，checks=49**（真实 Electron）

## 七、仍未完成（诚实清单）

1. **付费族的成功路径未实测**（语音克隆、音色设计、视频生成、生图/P图真实产出）：
   用户明确自测，且当前无预算授权。本仓库只证明"接线正确 + 缺依赖时零请求"。
2. **flowAgent build/review/commit 的成功路径未实测**：需要"已验证工具调用能力"的模型连接
   （付费）；当前只验证到预检失败、零请求、零预览。
3. `flow.command` 的已派发命令**外部取消不支持**（只能在准入前 abort，准入后等待/核对）；
   `cooperate`/`publication` 需协作者身份契约与独立发布授权协议。
4. F9 剩余 36 项（凭据受控写入、登录协作、环境安装、诊断导出、面板偏好等）。
5. F5 19 / F4 7 / F7 6 / F2 5 / F6 3 / F3 2 项未开放（多为付费执行、预览呈现或需新桌面动作）。
6. **F10 客户端/安装包**：按用户要求本轮不启动。
