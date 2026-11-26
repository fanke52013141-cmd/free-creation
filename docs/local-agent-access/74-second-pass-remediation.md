# 第二轮代码审查与修复交付台账

日期：2026-11-27（Asia/Shanghai）。基线：先整合 `origin/main@06c3183` 的 5 个新提交，再合并此前 H01/H02/H04–H10 与真实回归工作，最后进行第二轮源码审查。未把旧基线直接覆盖到线上。

## 1. 本轮审查结论

第二轮仍发现真实缺陷，集中在图路由与目录、外部协作和 composite 契约、非 Agent 恢复、版本发布以及旧运行语义。以下问题均已实现修复并补回归，不再只记为待办。

## 2. 图、目录与版本定义

- 循环载体的体外条件汇流接受 satisfied+dead，尊重 any/all；跳过传播不再被体内回边阻断。
- human-task 缺省 `outputType=text` 与显式类型共用同一端口过滤，缺省 out-json 在编译前拒绝。
- 节点映射和 coordinator/state 派生 ID 碰撞以 `NODE_ID_COLLISION` + `FlowGraphCompileError` 返回，不再落原生 ZodError。
- 重复边和单值输入多连在 validate 阶段以 `EDGE_DUPLICATE` / `PORT_CARDINALITY` 拒绝，many 正向通过。
- `listAllCompositeVersions` 缺省真正返回全部固定版本，显式 limit 才截断；501 版本证明最旧固定 ref 不丢。
- economics 覆盖直接 AI 与嵌套 composite，未知/缺引用/循环按 possible+required 保守处理。
- 定义 diff 增加 entry/exits/roles 变化；publishGraph 与 compile 使用同一完整 composite 目录。
- 版本升级时 ref 与 carrier 不匹配 fail-closed，禁止借用当前 NODE_RECORDS 伪装旧版本载体。

## 3. 外部访问与 composite API

- `flowAgent.cooperate` 改为独立可信 envelope `{input,origin}`，strict 业务输入不再混入外部 actor；真实 Host/Store 的 note/discuss/submit/revise 均保存 external clientId，普通 GUI 调用仍记 user。
- pure headless `submitHuman/resubmit` 将桌面路由与业务 projectId 分离：无活动项目时也经真实桌面人工确认，画布操作仍要求 sender/frame 绑定。拒绝/超时/桌面丢失均 fail-closed。
- `composite.execute.wait` 公开 accepted/running/wait-input/completed/failed/cancelled/interrupted/unknown 全部持久状态；waiting-input 立即可见，客户端按 composite timeoutMs+30s 等待，不再 15s 假超时。
- resume 领取后的 interrupted 仅在已满足 wait、无未结算 running step 时恢复；completed/checkpoint 保留，未知副作用不重放。
- 输出键以固定 manifest 消歧：foo 与 out-foo 不覆盖，list/get/wait/resubmit 共用同一投影；歧义/冲突显式报错。
- 弹窗按到达顺序排队，不再把未展示请求自动判为拒绝；DESKTOP_LOST→DESKTOP_UNAVAILABLE，只有真实 expire 才记 timeout。

## 4. 协调器恢复与版本发布

- recovery 按 graph node.kind 分流：Agent 查 assignment，非 Agent 查 committed receipt、真实等待和 adoption/composite/human 事实，ready/queued 只恢复观察。
- 真实子进程 SIGKILL 验证：首个 capability committed、第二个执行中终止，恢复进程没有再次 deliver；第二副作用 unknown 且未重放。
- settled failed 人工提交可替换，running/unknown 禁止覆盖；返工 activeChildCount 排除 failed/cancelled/skipped。
- `routedInputEdgeIds` 使用最终 effective incoming，optional 无贡献边不再被账本要求资产。
- requestId replay 比较 canonical graph+sourceGraph，不同内容返回 REQUEST_ID_CONFLICT。
- composite 升级导出同步 capabilityRef/版本，身份字段不进入 params；committed 对 config 做 canonical 比较，key 顺序不再误报。
- composite-target 统一 inline/meta/flat/ref：固定 id+version，声明 hash 才核 hash，历史快照不被新版替换。

## 5. composite UI 与旧运行语义

- 运行策略可见性与持久值分离；关闭“完成”不丢草稿，保存成功同步 base，历史载入重新派生策略，连续保存不回滚。
- runtimeVersion=1 的 headless 媒体运行现在写 outputSummary/outputValues；旧 GUI outcome 不额外物化，公开读取统一为 out-<id>。

## 6. 回归证据

- 图/目录/定义相关：12 文件、214 项通过。
- 外部访问与 composite API：定向 82 项通过。
- 协调器与版本发布：208 项通过，包含真实 capability 硬杀恢复。
- composite UI/旧运行语义：8 文件、84 项通过；旧 runtime CLI/MCP 各一条真实 headless+inline 通过。
- 冲突整合专项：204 项通过。
- 全量 Vitest：4121 项通过、7 项跳过。
- `typecheck:node` / `typecheck:web`、scope ESLint、`git diff --check`、`guard:agent-parity` 通过。
- 最终 `npm run verify` **全部通过**：`qa/verification/run-OOJHML/status.json`（status=passed，exitCode=0），含全部单测、34 个浏览器脚本、构建、Agent Flow 桌面与 R09 可靠性回归。
- 真实 MCP 快速验收：protocol 34/34、optimizations 9/9；191 个操作。证据归档批次 `2026112620515`，索引已同步。

## 7. 边界与备注

- 未调用真实付费供应商；模型绑定/验证 fixture 均明确标记为测试 setup，不冒充供应商受理或媒体质量验收。
- 真实恢复使用隔离数据目录和进程硬杀，不使用真实用户项目或真实 license/security；开发授权旁路不等于授权验收。
- 纯 headless 使用主进程原生桌面确认，画布操作继续使用 renderer sender/frame 绑定；这不是跳过人工门。
- 参数桌面用例采用 Vite 源码 renderer + 真实构建 main/preload，不冒充打包 renderer 验收。
- 本轮不展开新的嵌套人工门逐层暂停/恢复协议；仍按 NF-10.4 明确拒绝。
