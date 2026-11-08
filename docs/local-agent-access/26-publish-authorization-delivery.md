# F6 收尾（第二批）：导演台外部发布授权协议

日期：2026-11-08。基线：`94c8bbb`（Registry 按族拆分）。本包是 F6 收尾的「导演台发布授权」部分；chat.patch 真实画布桌面段与附件注入实测由同批桌面包交付（见 22 号台账）。

## 1. 实际完成的业务动作

GUI 原本只有一条发布路径：人打开「3D 预演台」工作区，手动点「发布帧 / 发布视频 / 导出整段」。该节点 `executionMode = 'manual-publish'`，执行器明确拒绝代替用户发布（只读取「最近一次已发布且与当前工程修订一致」的记录）。

本包新增**等待/继续协议**，把同一件业务动作开放给 CLI/MCP，但不削弱人工门禁：

| 业务动作 | GUI | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 申请发布（静帧/预演视频） | ✔ 面板里点发布 | ✔ `director.publish.prepare` | ✔ `director_publish_prepare` | `service.ts` dispatch + `main/agent-access/publish.ts` 账本 |
| 人工授权/拒绝 | ✔ GUI 确认弹窗（`useConfirmStore`），点「允许发布」才成立 | —（外部没有授权通道） | — | `CanvasEditor` 的 `publish-authorize` 交互式宿主请求 |
| 查询授权与执行状态 | ✔ 面板显示发布状态 | ✔ `director.publish.status` | ✔ `director_publish_status` | 同上账本 |
| 执行发布并写正式结果 | ✔ 面板发布 | ✔ `director.publish.continue` | ✔ `director_publish_continue` | `renderer/canvas/director-frame.ts` **与 GUI 同一发布服务** |
| 读取正式输出 | ✔ 卡片/下游节点 | ✔ `output.get`（manual-publish 门控） | ✔ | 既有共享投影 |

关键设计：

1. **外部不能伪造授权。** prepare 只创建账本行并发出一个 `publish-authorize` 交互式宿主请求；只有 renderer 里人点「允许发布」才回传授权，main 才把请求推进到 `authorized`。外部客户端没有 renderer 回复通道，也没有授权类操作。
2. **不能用 node.execute 偷渡。** `directorExecutor` 保持 `skipped`（未发布 / 发布后工程又改过），本包新增断言证明这一点。
3. **交互式请求不占用写入槽。** 原来 `createAccessDesktop.run` 只有一个 pending 槽、10 秒过期，人工确认必然超时并把画布保存全部堵成 `RESOURCE_BUSY`。新增 `ask()`：独立 pending 表、按 requestId 路由、同样校验 sender/frame、默认 10 分钟窗口；`run()` 增加可选执行窗口（导演台发布渲染/编码可能超过 10 秒，原 10 秒会得到假的 `DESKTOP_TIMEOUT`）。
4. **授权绑定画布版本。** 申请记录 `expected_graph_version`；申请后画布再变化，continue 返回 `REVISION_CONFLICT` 并要求重新申请，避免用旧授权发布新内容。
5. **正式结果核对在保存屏障之后。** continue 成功后 main 重新读取持久化节点，要求 `meta.nodeResult` 里的发布记录 `frame/video.mediaId` 与宿主回执一致，否则按 `unknown` 处理（准入后失败不谎报完成）。
6. **状态机单向**：`awaiting-authorization → authorized | denied | expired`，`authorized → executing → completed | failed`；同一节点只保留一条待处理申请，活跃请求数量有上限（8），崩溃遗留的 `executing` 在服务启动时结算为 `failed/PUBLISH_OUTCOME_UNKNOWN`（不自动重发）。

## 2. 公共实现与兼容处理

- 新增 `src/shared/agent-access/publish.ts`：发布模式、状态枚举、TTL、产物/宿主回执 Schema。
- 新增 `src/main/agent-access/publish.ts`：`director_publish_requests` 账本（DB 迁移 **M22**，`DB_SCHEMA_VERSION` 21→22，纯新增表）。
- 新增 `src/renderer/src/canvas/director-frame.ts`：把导演台 2D 画面绘制、WebM 预演录制、发布记录写入从 `DirectorStudioPanel` 抽为共享模块；面板与外部授权发布**调用同一函数**（`publishDirectorOutput` / `writeDirectorPublishRecord`）。面板原有的 3D 白模发布保留在面板内（需要已挂载 WebGL 视口）。
- `src/shared/agent-access/desktop.ts`：新增 `publish-authorize` / `director-publish` 动作与 `publishRequestId/publishMode/shotId` 载荷字段。
- `src/main/agent-access/desktop.ts`：新增 `ask()` 交互式请求通道；`run()` 增加可选执行窗口参数（默认仍 10 秒，既有调用方行为不变）。
- `capability.list.limitations`：删除已陈旧的 `NO_NODE_EXECUTION`（F3 起 node.execute 已开放），新增 `DIRECTOR_PUBLISH_REQUIRES_HUMAN_AUTHORIZATION`。
- 契约：新增 3 项操作，**既有 37 项 Schema 逐字节未变**；`action-coverage.json` 把 `canvas.director.publish` 从 `F6` 改为 `external` 并映射三条操作。

## 3. 验证证据（真实运行）

- `node scripts/run-vitest.cjs run test/local-agent-publish-access.test.ts` → **10 项全部通过**。覆盖：
  1) 无打开画布拒绝申请（`ACTIVE_PROJECT_REQUIRED`）；
  2) 非导演台节点 `DIRECTOR_NODE_REQUIRED`、缺失镜头 `SHOT_NOT_FOUND`、过期版本 `REVISION_CONFLICT`；
  3) 申请只建待授权请求：不渲染、不改画布、授权请求确实发往 GUI；
  4) 未授权 continue → `PUBLISH_NOT_AUTHORIZED` 且不调用宿主；
  5) 人拒绝 → `denied`，continue → `PUBLISH_DENIED`；
  6) 人允许 → 发布完成、正式记录落在持久化节点、**同幂等键重放与二次 continue 都不重复发布**（宿主只被调用 1 次）；
  7) 申请后画布版本前进 → continue `REVISION_CONFLICT`；
  8) 宿主回执不可核对 → `unknown` / `OUTCOME_UNKNOWN`；
  9) 跨项目读请求 `NOT_FOUND`；
  10) `directorExecutor` 未发布/修订漂移都返回 `skipped`（node.execute 不是发布路径）。
- `npm run typecheck`（node + web）通过；`node scripts/audit-business-actions.cjs` 通过（external 映射含三条新操作）。

## 4. 尚未支持 / 仅服务级验证

1. **真实 Electron 桌面端到端（授权弹窗点击 → 渲染 → 产物落盘 → GUI 卡片状态）尚未在本包跑通**：需要构建后由里程碑/桌面脚本验证，本包目前是服务级 + 共享发布实现的单元级证据。已如实登记，不计入“桌面已验收”。
2. **3D 白模发布仍未对外开放**：外部发布固定走 2D 预演渲染（`PUBLISH_VIEWPORT_UNAVAILABLE` 不会伪造文件）；3D 需要用户已打开工作区并挂载 WebGL 视口，属于 GUI 手动路径。
3. **整段序列导出（sequence）未纳入协议**：面板有「导出整段」，本包只开放 `frame` / `video` 两种模式；序列导出需要与镜头序列、时长和渲染成本一起定义，留待后续包。
4. **付费供应商链路未涉及**：导演台发布是本地渲染 + 受控媒体导入，不触发模型计费；付费模型执行仍未验收。

## 5. 下一包目标

F7 资源库/节点库/历史/包传输（同批三个包并行，见 23/24/25 号台账）；随后 F8 Flow 命令与多画布按项目锁并发。
