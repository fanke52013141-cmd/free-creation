# F6 收尾 + F7 批次交付汇总（2026-11-08 第二轮）

基线：`150a841`（上一轮交接文档所在提交）→ 本轮 7 个提交。目标与验收口径仍以
[AGENT_PARITY_SPEC.md](../../AGENT_PARITY_SPEC.md)、[15 号计划](15-gui-cli-mcp-parity-plan.md)、
[16 号节点动作表](16-node-action-coverage.md) 为准；本文只记录**真实做了什么、证据是什么、还差什么**。

## 一、一眼看懂的现状

| 指标 | 本轮前 | 本轮后 |
| --- | --- | --- |
| 外部操作（CLI/MCP 由同一 Registry 生成） | 37 | **77** |
| 业务动作分母（IPC + 画布动作） | 171 + 35 | 171 + 35（不变） |
| external 映射的动作 | 41 | **76** |
| 接入测试 | 73 | **116** |
| 真实桌面里程碑检查 | 20 | **28**（真实 Electron + 授权协作激活） |
| 契约兼容 | — | 既有 37 项 inputSchema/outputSchema **逐字节未变**（纯追加，未用 `--accept-contract-change`） |

本轮提交：

| 提交 | 范围 |
| --- | --- |
| `3cd884c` | 修复继承缺陷：F6 第三批遗留的受保护源码哈希声明假红（仅补正声明，契约无变化） |
| `94c8bbb` | 重构：Registry 按业务族拆分挂载点（对外契约逐字节不变，契约快照可证） |
| `6b045f6` | F6 收尾（一）：导演台外部发布授权协议（prepare/status/continue）+ 全批聚合产物刷新 |
| `1ce695e` | F7（一）：资源库 20 项操作（全类型 CRUD/分类/集合/文件夹/批量/物化） |
| `76a1248` | F7（二）：包传输 4 项（项目/结构/资源包）+ 导入黑名单解禁（keys/workspace 仍阻断） |
| `80a4c36` | F7（三）：节点库 6 项 + 历史与恢复 7 项 |
| `a7f5e60` | F6 收尾（二）：chat.patch 真实画布桌面端到端 + 附件注入实测 + 两个真实缺陷修复 |

逐包台账：[22](22-f6-closeout-delivery.md)（F6 桌面）、[23](23-library-delivery.md)（资源库）、
[24](24-transfer-delivery.md)（包传输）、[25](25-node-library-history-delivery.md)（节点库/历史）、
[26](26-publish-authorization-delivery.md)（发布授权）。

## 二、本轮的三个架构决定（会影响后续包）

1. **Registry 按业务族拆分**：`src/shared/agent-access/ops/*.ts` 每族一个文件，
   `registry.ts` 只做组装；`audit-business-actions.cjs` 扫描全部族文件并拒绝重复登记。
   目的：避免所有维护者并发改同一个 800 行文件（本轮四个包并行开发验证了这个决定）。
   新增操作的方法写在 `ops/common.ts` 与 `ops/publish.ts` 的文件头注释里。
2. **交互式桌面通道 `ask()`**：需要人亲眼确认的动作（导演台发布授权）不再占用唯一
   写入槽、不再受 10 秒编辑窗口限制；仍走同一条 sender/frame 受控回复通道，
   按 requestId 路由。后续 F9 的第三方登录/凭据确认可以复用。
3. **人工门禁不由外部伪造**：`director.publish.prepare` 只登记待授权请求并发起 GUI
   确认；`node.execute` 对 director 仍只读"最近一次一致发布记录"。授权绑定画布版本，
   申请后画布变化必须重新申请。

## 三、逐包验证证据（真实输出）

统一的批次门禁（本轮最后一次真实运行）：

- `npm run typecheck`（node/web/license-protocol/issuer）→ 0 错误
- `node scripts/audit-business-actions.cjs` → `171 IPC channels + 35 canvas actions; external ops 77`
- `npm run verify:agent-access` → `Agent access gate passed: 77 operations; 32 planned nodes`
- `npm run verify:logging` → 通过（无日志旁路）
- 11 个接入测试文件 → **116 passed / 116**
- `npm run build` → 通过
- `node scripts/test-agent-graph-milestone.cjs` → **passed，checks=28**（真实 Electron、
  独立数据目录、授权协作激活）；证据 `qa/local-agent-access/milestone-a-b-c/report.json`
  与截图 `milestone-f6-chat-dialog.png`（`qa/` 目录不入库，证据为本机产物）

本轮**修复的真实缺陷**（都不是"顺手重构"）：

1. `deleteResource` 删除资源后磁盘残留孤儿文件（blob 路径按相对 cwd 解析）；集成时
   再补"只允许删除数据目录内 blob"的越界保护——它同时影响 GUI 删除路径。
2. chat 附件注入断裂：main 已解析 `mediaResolutions`，但宿主 chat 分支未透传、
   `planChatPatch` 也无参数，`images` 被写成空 `mediaPath`/`mime`，`parseChat` 在
   落盘/重开时丢弃空路径附件——**GUI 静默丢附件而回执 completed**。现缺少解析事实即
   整批 `MEDIA_NOT_RESOLVED`。
3. chat.patch 与几何 op 混批会被宿主会话分支静默丢弃其余 op 却回执 ok；main 准入前
   以 `MIXED_PATCH_UNSUPPORTED` 拒绝。
4. 审计脚本操作 ID 正则漏掉 camelCase（如 `project.importStructure`），会悄悄缩小
   外部映射分母；已修正并复核。
5. 上一轮 F6 第三批的 `change-impact.json` 哈希声明早于文件最终编辑，导致干净工作区
   门禁假红；补正并在提交信息里写明"逐操作 Schema 无差异"的核对结论。

## 四、仍然不支持 / 只在服务级验证（不得算作已验收）

1. **付费供应商执行从未实测**（无预算授权）：video/image-gen/image-edit/speech/tts/
   voice-design 的执行契约存在，但只有本地/模拟验证。真实桌面只验证了"无已验证模型时
   与 GUI 同因如实失败"。
2. **F7 三包的真实桌面端到端未跑**：资源库物化、节点库组合保存→插入另一画布、
   历史恢复与检查点回退，目前都是服务级 + 受控宿主替身证据。里程碑新增的 5 项只覆盖
   chat.patch/附件；这三条的桌面段仍待补。
3. ~~导演台发布授权的真实桌面段未跑~~ **已跑（6.9 段，checks 28）**：含人在 GUI 点「允许发布」/
   「拒绝」两条真实路径；该段抓到一个真实缺陷（核对读错存储位置），已修并改测试替身。
4. 3D 白模发布未对外开放（需已挂载 WebGL 视口）；整段序列导出未纳入协议。
5. 打开中的画布无法外部恢复（需 F9 `project.close` 或新桌面动作），当前如实拒绝。
6. `keys.importProviders` / `workspace.import` 仍阻断；`project.exportStructure` 外部
   触发未开放（读 renderer 未保存快照，无等价权威视图）。
7. 物化不写 `meta.librarySource`、不建 tldraw 分组；GUI 插入节点库条目仍按纯结构预设
   清空媒体（既有行为）。
8. 多画布并发仍是串行口径（单 mutating 标志 + 活动画布唯一宿主）；F8 才放宽。
9. `npm run verify`（全仓完整验证，含大量 Electron 桌面脚本）本轮**未跑**：
   工作区存在他人进行中的未提交修改（授权/密钥库/发行版），全仓验证不在本批可判定范围内。

## 五、下一包（按计划顺序）

1. **F7 收尾**：补三条真实桌面段（资源库物化 / 节点库插入 / 历史恢复）+ 导演台发布
   授权桌面段；补资源捕获族（画布→资源库）。
2. **F8**：Flow 建图预览/提交、角色绑定、运行控制、协作输入、固定资产、审核返工、
   状态机事件开放为外部命令（复用现有账本/租约/审核）；把 `LocalAccessService` 的
   单 mutating 标志改成按项目锁，目标 ≥2 画布并行。
3. **F9**：模型连接/受控凭据/环境探测/设置/诊断 + 三入口目录一致性机器门禁。
4. **F10**：干净克隆构建、真实安装包、真实 MCP 客户端逐动作一致性、故障恢复全量；
   付费供应商分组验收需预算授权。
