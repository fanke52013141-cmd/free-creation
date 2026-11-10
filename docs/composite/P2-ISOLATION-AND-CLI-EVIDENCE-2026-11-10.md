# P2 隔离执行与 CLI 发布证据（2026-11-10）

基线：`a164b7e`（独立 store 隔离执行）
本轮补充：真实 CLI 调用与证据记录；无新增产品代码（仅验证）。

## 1. 隔离执行确定性验证（浏览器）

- 固定媒体组合运行：`status:"done"`，组合节点 `meta.nodeResult` 含正确 mediaId/path；
  运行前后 `editor.getPages().length === 1`，无页面切换。
- 两个组合并发、不同 mediaId：
  - 两者均 done；
  - A 的结果只含 `qa-media-a`，B 只含 `qa-media-b`（onlyA=true / onlyB=true）；
  - 无实例/产物串写。

## 2. 真实 CLI 调用（app 以 `--local-agent-access` 启动）

写操作必须携带 idempotencyKey（格式 `13位时间戳:uuid`）；缺少会被 `toolInputSchema` 拒绝，
这是既有协议约束，不是 P1/P2 缺陷。

```text
$ node out/main/local-agent.js composite.validate --input-file qa/composite-cli-input.json
→ status completed, data: { ok: true, issues: [] }

$ node out/main/local-agent.js composite.draft.save --input-file qa/composite-cli-input.json
→ status completed, data: { capabilityId: "cli-media-composite", revision: 1, updatedAt: 1794322671230 }

$ node out/main/local-agent.js composite.publish --input-file qa/composite-cli-input.json
→ status completed, data: {
    capabilityId: "cli-media-composite",
    version: "1.0.0",
    contentHash: "5d49df47577ed5d4d5ced613e4790dca853f1445ad5908cb4c12301ed93f33b7",
    created: true
  }

$ node out/main/local-agent.js composite.search
→ status completed, total 1, latestVersion "1.0.0"

$ node out/main/local-agent.js composite.get --input-file qa/composite-cli-get.json
→ status completed，返回固定版本 manifest 与 contentHash
```

说明：
- 同一次调用重复使用同一个 idempotencyKey 会得到 `IDEMPOTENCY_CONFLICT`（发布幂等由
  `capabilityId+version+contentHash` 保证，幂等键属于操作层防重）；
- 本轮 CLI 证据覆盖 P1 发布/查询路径；`composite` 节点的按名称运行仍需 P2 真实模型链路。

## 3. 待完成

- Electron 真实人物设计链路（文本→AI→生图→公开输出图片→下游消费）；
- CLI/MCP 对组合节点的真实运行与产物读取；
- P3 持久等待/恢复、P4 嵌套、P5 画布 Agent。
