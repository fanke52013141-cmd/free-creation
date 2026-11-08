# 可修复项与优化方案（第 10 轮）

日期：2026-11-08。基于 58/59/60 号验收与优化轮次的实际发现整理。
当前状态：**140 项外部操作 / F9 剩 11 项 / excluded 30 / 全仓 3106 测试通过**；
工作区另有 **92 个未提交文件，其中 19 个属并行在途范围**（gateway、ipc、contracts、package.json 等）。

排序原则：先修**不依赖并行改动**的、再修**需要等**的、最后是**需要你决策/预算**的。
每项都写清「影响 / 工作量 / 风险 / 依赖 / 怎么验收」。

---

## 一、可立即修复（文件干净，不依赖并行）

### P0-1 补最后一项可做 F9：`diagnostics.exportNodeRun`

- **现状**：唯一还卡着的非 license 非阻塞项。GUI 走原生保存对话框 + renderer 内存运行记录，
  外部没有等价入口。
- **方案**：
  1. 桌面协议加动作 `read-node-runs`（`projectId` + `nodeId`）→ renderer 从节点
     `meta.nodeRun` / `nodeRunHistory` 返回最近 ≤13 次运行记录（只给结构化字段，不带正文）；
  2. 从 `src/main/ipc/diagnostics.ipc.ts`（**当前干净**）把"构造 NodeRunDiagnosticRecord +
     脱敏 + 落盘"抽成 `src/main/diagnostics/node-run-export.ts` 共享函数，IPC 与外部都调它；
  3. 新操作 `diagnostics.exportNodeRun`：写受控导出目录，回执 fileName/sha256/字节数/runCount。
- **影响**：F9 计划项 11 → 10；外部可导出单节点运行诊断（排障闭环）。
- **工作量**：中（约 1 个包）。**风险**：中（桌面动作 + 抽取共享函数，需保证 IPC 行为不变）。
- **验证**：真实桌面造一次节点执行 → 导出 → 校验文件/指纹/脱敏（不含提示词、密钥、绝对路径）；
  另加单测断言"脱敏白名单"。

### P0-2 修过期验收脚本（现在跑必红）

- **现状**：`scripts/test-local-agent-access.cjs` 硬编码 `tools.length===34`（现为 140）、
  `nodes.length===32`。任何人跑它都会失败，形成"狼来了"。
- **方案**：改为**从门禁读真值**——先跑 `check-agent-access.cjs` 的 `contracts` 输出拿操作数，
  再断言 `tools.length === 操作数`；节点数同样读 `node.type.list` 的长度而不是写死。
- **影响**：恢复一个可用的端到端脚本。**工作量**：小。**风险**：无。
- **验证**：脚本自跑通过；再故意改一个数字确认它会红。

### P0-3 `provider.list` 的 `hasApiKey` 读侧校正

- **现状**：`providers.repo.toSummary()` 用 `decryptSecret(api_key_ref)` 判断，但 P2 起密钥写在
  设备 vault、`api_key_ref` 是 `vault:provider:<id>` 指针 → **有密钥却报 false**。
  这是既有缺陷（GUI 的遗留供应商列表同样受影响）。
- **方案（两步走，先不动脏文件）**：
  1. 在 `src/main/agent-access/providers-ops.ts`（干净）里对每个条目用 `getProvider(id)` 校正
     `hasApiKey`——外部看到的立刻正确；
  2. 等 `providers.repo.ts` 收敛后，把 `toSummary` 改成 `Boolean(decryptSecret(ref)) || Boolean(parseVaultRef(ref))`，
     GUI 与外部同时修正。
- **影响**：避免 Agent 误判"还需要补密钥"而重复写入凭据。
- **工作量**：小（读侧）/ 小（根因，需等）。**风险**：低。
- **验证**：保存带密钥的供应商 → `provider.list`/`provider.listExecutable` 的 `hasApiKey` 为 true；
  更新时留空密钥仍为 true；删除密钥后变 false。

### P0-4 `provider.probe` 空结果要给出原因

- **现状**：对没有免费探测项的 spec（如 toapis）返回 `items: []` + 空 summary，
  调用方无法区分"探测通过但没项目"和"压根不支持探测"。
- **方案**：`items` 为空时 summary 明确写「该供应商无可用免费探测项」，
  并新增字段 `probeSupported: boolean`（输出 Schema 追加，兼容）。
- **影响**：消除"看起来成功但什么都没验"的歧义。**工作量**：小。**风险**：低。
- **验证**：对 toapis 供应商断言 `probeSupported: false` 且 summary 非空。

### P0-5 验收证据归档（`qa/` 被 gitignore）

- **现状**：所有验收报告写在 `qa/local-agent-access/*/report.json`，**不入库**，
  换台机器或清目录就没了，与"证据要可追溯"冲突。
- **方案**：验收脚本结束前把 `report.json` 复制到
  `docs/local-agent-access/evidence/<批次>-<日期>.json`（入库，体积小），
  并保留一行摘要到对应台账。
- **影响**：验收可追溯、可复核。**工作量**：小。**风险**：无。
- **验证**：跑任一批验收后，docs 下出现证据文件且内容与 qa 一致。

### P1-6 保存不再无谓推进版本（降噪，收益最大的一条）

- **现状**：每次桌面握手前的保存屏障都会 `graphVersion + 1`（即使画布没改）。
  后果：Agent 的"读版本→写"几乎必然冲突；本轮已通过"版本降为建议值 + 结构化 current"缓解，
  但**根因还在**，且每次保存都产生新版本、.bak 轮转与磁盘写。
- **方案**：在 `src/main/store/projects.repo.ts`（**当前干净**）的 `saveProjectUnlocked` 里做
  **no-op 检测**：把入参 `graph` 与已存文件的 `graph` 规范化后比较，
  tldraw 快照只比较 shape/binding/asset 记录（**忽略 camera/selection 等易变状态**）；
  完全相同则**不写盘、不推进版本**，直接返回当前版本。IPC 层已有写锁，语义安全。
- **影响**：版本噪声大幅下降、冲突重试减少、磁盘写减少；对 GUI 无可见变化。
- **工作量**：中。**风险**：中（保存是核心路径）——必须有针对性测试：
  ①未改动的重复保存不推进版本；②改了节点必须推进；③只移动相机不推进（避免无意义版本）；
  ④并发保存仍串行（既有锁不变）。
- **验证**：新增单测 + 真实桌面：连续 5 次 flush 后版本只 +1（首次）或不增；
  改一个节点后 +1；`canvas.history`/`graph.patch` 不再频繁 REVISION_CONFLICT。

### P1-7 `library` 字段命名统一（分两阶段，避免破坏）

- **现状**：`media.list` 用 `mediaId`（已加 `id` 别名）、`library` 用 `resourceId/folderId/collectionId`、
  `project.list` 用 `id`。跨族写 Agent 逻辑极易写错。
- **方案**：
  - 阶段 A（兼容，立即可做）：给 library 各 DTO **追加 `id` 别名**（=主键），
    与 media 一致；描述里注明"`id` 为主键别名，原字段继续有效"。
  - 阶段 B（破坏性，需版本）：下一个大版本把 `xxxId` 标为 deprecated，外部只读 `id`；
    契约快照走 `--accept-contract-change` 并给迁移说明。
- **影响**：Agent 侧寻址统一，减少一类低级错误。**工作量**：小（A）/ 中（B）。
- **风险**：低（A，纯追加）；中（B，需公告）。**验证**：断言每个 DTO 的 `id` 与主键相等。

### P1-8 验收脚本纳入命令入口

- **现状**：5 个验收脚本只能手动 `node scripts/...`，容易忘跑。
- **方案**：`package.json`（**当前脏，等落定**）加：
  `verify:acceptance`（跑全部，串行）、`verify:acceptance:family1` 等分项；
  再加一个 `verify:acceptance:fast`（只跑协议层 + 优化验证，约 2 分钟）。
- **影响**：验收从"我记得跑"变成"一条命令"。**工作量**：小。**依赖**：package.json 落定。
- **验证**：新命令跑通并把汇总写到 `qa/.../summary.json`。

### P2-9 非官方 MCP 客户端（SSE/HTTP 传输）适配

- **现状**：只验证了官方 SDK 的 stdio 传输。若你要用只支持 SSE/HTTP 的客户端，接不上。
- **方案**：在 `src/local-agent/index.ts` 增加 `mcp serve --transport sse --port <n>`，
  复用同一 `Server` 与工具注册；绑定 127.0.0.1、随机端口写回 `connection.json` 供客户端发现；
  加令牌校验（沿用 desktop token）。
- **影响**：扩大客户端兼容面。**工作量**：中大。**风险**：中（新增监听面，必须限 loopback + 鉴权）。
- **验证**：用 SSE 客户端跑通 tools/list + 3 个只读操作；未带令牌必须拒绝。

### P2-10 人工步骤 runbook（把"必须人做"的路径写成清单）

- **现状**：凭据包导入的确认、即梦完整登录、付费生成这 3 条**只能人做**，目前散在报告里。
- **方案**：写 `docs/local-agent-access/62-manual-runbook.md`：每步给出
  "外部调用 → 界面会看到什么 → 人点什么 → 外部预期回执 → 失败怎么查"，
  并附一次性手测脚本（调用外部 prepare 后暂停，等人操作，再 continue）。
- **影响**：这些路径不再"没人验过"。**工作量**：小。**风险**：无。
- **验证**：按 runbook 走一遍，把结果记进台账。

---

## 二、等并行改动落定后才能做（现在改必冲突）

| 项 | 依赖文件 | 说明 |
| --- | --- | --- |
| `models.discover`、`models.validateAgentToolCalling` | `src/main/ipc/models.ipc.ts`（脏） | 抽取共享函数后开放（2 项）。落定即可做，预计半天 |
| `providers.repo.toSummary` 的 `hasApiKey` 根因修复 | `src/main/gateway/providers.repo.ts`（脏） | 见 P0-3 第 2 步；修完 GUI 与外部一致 |
| `verify:acceptance` 命令 | `package.json`（脏） | 见 P1-8 |
| 版本语义（保存/推进）最终口径 | `src/main/ipc/project.ipc.ts`（脏） | P1-6 若需改 IPC 侧判断则等 |
| 版式/可见节点口径 | `src/shared/edition.ts`（未跟踪新文件） | `DISTRIBUTION_HIDDEN_NODE_TYPES` 隐藏了 13 类节点，与你"完整版"的预期冲突，**需要你拍板**是否保留 |

---

## 三、需要你决策或预算（不是技术问题）

1. **license 8 项**：建议保持永不开放（授权签发/挑战/证明/策略导入对外开放 = 门禁失效）。
2. **付费生成真实调用**（生图/P图/视频/语音/音色）：需要预算授权。我只做了接线与"未配置时正确拒绝"。
3. **真实联网安装**（`environment.videoEngine.install`）：需要 CUDA 环境 + 数 GB 下载。
4. **F10 打包**：干净克隆构建、安装包、真实 MCP 客户端在打包态的验收。当前 `dist/` 有产物但未验证打包态。

---

## 四、建议执行顺序

| 批次 | 内容 | 预估 | 说明 |
| --- | --- | --- | --- |
| **批 1**（推荐立刻） | P0-1 ~ P0-5 | 半天~1 天 | 全部基于干净文件，互不依赖，可独立验收；完成后 F9 只剩 10 项且全为 license/阻塞 |
| **批 2** | P1-6（保存降噪）、P1-7 阶段 A | 1 天 | 收益最大但也最需谨慎的是 P1-6，需先补测试再改 |
| **批 3** | P2-10 runbook、P2-9 SSE 传输 | 1 天 | 前者解锁"人工路径可验"，后者扩客户端兼容 |
| **批 4** | 等并行落定后：discover 2 项 + hasApiKey 根因 + `verify:acceptance` | 半天 | 依赖解除即可做 |

每批结束时统一跑：`npm run typecheck` / `verify:agent-access` / `audit-business-actions` /
`verify:logging` / 全仓测试 / 相关验收脚本，并提交带兼容结论的契约刷新。

---

## 五、我不会做的事（重申）

- 不开放 `license.*` 8 项；
- 不做"看起来完成"的假验收（人工确认路径不会被自动化冒充通过）；
- 不在 `git` 脏文件里做不可回退的修改（需要等并行落定）。

---

## 六、如果你只想让我做一件事

**做批 1**。它把 F9 里最后一项非 license 可做项关掉（`exportNodeRun`），
同时修掉一个"现在跑必红"的验收脚本和一个会误导 Agent 的 `hasApiKey` 缺陷，
风险低、收益直接，且完全不碰并行在途文件。
