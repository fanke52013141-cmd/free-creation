# Agent Flow 历史文档归档（L3）

> status: archive
> 来源：`docs/canvas-agent-flow/` 按 `AGENT_FLOW_SPEC.md` §20 收敛；编号保留。
> 现行入口：[README](../README.md)、[AGENT_FLOW_SPEC](../../AGENT_FLOW_SPEC.md)、[05 节点协同规范](../05-node-coordination-standard.md)。
> 迁移：BL-32（2026-11-26）。本目录文档只用于追溯，不作为现行规范。文中的数量、支持状态、“当前”“最新”“未提交/推送”和“下一步”均为各文档时点的历史记录；当前状态只读 [AGENT_FLOW_SPEC](../../AGENT_FLOW_SPEC.md)、[BACKLOG](../../BACKLOG.md) 与[机器契约](../../local-agent-access/generated/contracts.json)。

| 文档 | 类别 |
| --- | --- |
| [00-approved-plan.md](./00-approved-plan.md) | 阶段交付/实施记录 |
| [01-product.md](./01-product.md) | 阶段交付/实施记录 |
| [02-architecture.md](./02-architecture.md) | 阶段交付/实施记录 |
| [06-implementation-plan.md](./06-implementation-plan.md) | 阶段交付/实施记录 |
| [08-development-ledger.md](./08-development-ledger.md) | 阶段交付/实施记录 |
| [09-model-probe-and-production-bridge-review.md](./09-model-probe-and-production-bridge-review.md) | 阶段交付/实施记录 |
| [10-c1-control-declarations.md](./10-c1-control-declarations.md) | 阶段交付/实施记录 |
| [11-c2-asset-versions.md](./11-c2-asset-versions.md) | 阶段交付/实施记录 |
| [12-c2-production-command-bridge.md](./12-c2-production-command-bridge.md) | 阶段交付/实施记录 |
| [13-c3-runtime-foundation.md](./13-c3-runtime-foundation.md) | 阶段交付/实施记录 |
| [14-c3-canvas-agent.md](./14-c3-canvas-agent.md) | 阶段交付/实施记录 |
| [15-c32-collaboration.md](./15-c32-collaboration.md) | 阶段交付/实施记录 |
| [16-c33-sequential-coordination.md](./16-c33-sequential-coordination.md) | 阶段交付/实施记录 |
| [17-c33-builder-review.md](./17-c33-builder-review.md) | 阶段交付/实施记录 |
| [18-glm-model-switch.md](./18-glm-model-switch.md) | 阶段交付/实施记录 |
| [19-c33-review-rework.md](./19-c33-review-rework.md) | 阶段交付/实施记录 |
| [20-c4-recovery-transfer.md](./20-c4-recovery-transfer.md) | 阶段交付/实施记录 |
| [21-c4-crash-network-matrix.md](./21-c4-crash-network-matrix.md) | 阶段交付/实施记录 |
| [22-c4-import-renderer-recovery.md](./22-c4-import-renderer-recovery.md) | 阶段交付/实施记录 |
| [23-c4-main-save-crash-recovery.md](./23-c4-main-save-crash-recovery.md) | 阶段交付/实施记录 |
| [24-c4-supplier-reconciliation.md](./24-c4-supplier-reconciliation.md) | 阶段交付/实施记录 |
| [25-c4-video-materialization-recovery.md](./25-c4-video-materialization-recovery.md) | 阶段交付/实施记录 |
| [26-c4-recovery-contention.md](./26-c4-recovery-contention.md) | 阶段交付/实施记录 |
| [27-c4-combined-failure-acceptance.md](./27-c4-combined-failure-acceptance.md) | 阶段交付/实施记录 |
| [28-video-agent-adapter.md](./28-video-agent-adapter.md) | 阶段交付/实施记录 |
| [29-video-first-frame-adapter.md](./29-video-first-frame-adapter.md) | 阶段交付/实施记录 |
| [30-video-first-last-frame-adapter.md](./30-video-first-last-frame-adapter.md) | 阶段交付/实施记录 |
| [31-video-reference-images-adapter.md](./31-video-reference-images-adapter.md) | 阶段交付/实施记录 |
| [32-video-motion-reference-adapter.md](./32-video-motion-reference-adapter.md) | 阶段交付/实施记录 |
| [33-fixed-media-project-transfer.md](./33-fixed-media-project-transfer.md) | 阶段交付/实施记录 |
| [34-video-audio-reference-adapter.md](./34-video-audio-reference-adapter.md) | 阶段交付/实施记录 |
| [35-sampled-video-review.md](./35-sampled-video-review.md) | 阶段交付/实施记录 |
| [36-video-review-bounded-rework.md](./36-video-review-bounded-rework.md) | 阶段交付/实施记录 |
| [37-parallel-media-stop-recovery.md](./37-parallel-media-stop-recovery.md) | 阶段交付/实施记录 |
| [38-agent-completion-plan.md](./38-agent-completion-plan.md) | 阶段交付/实施记录 |
| [39-parallel-review-rework.md](./39-parallel-review-rework.md) | 阶段交付/实施记录 |
| [40-multi-reference-prompt-bundle.md](./40-multi-reference-prompt-bundle.md) | 阶段交付/实施记录 |
| [41-reproducible-verification.md](./41-reproducible-verification.md) | 阶段交付/实施记录 |
| [42-r09-local-reliability.md](./42-r09-local-reliability.md) | 阶段交付/实施记录 |
| [43-r09-project-flush-barrier.md](./43-r09-project-flush-barrier.md) | 阶段交付/实施记录 |
| [44-r09-duration-soak-runner.md](./44-r09-duration-soak-runner.md) | 阶段交付/实施记录 |
| [45-diagnostics-bundle-environment.md](./45-diagnostics-bundle-environment.md) | 阶段交付/实施记录 |
| [46-library-category-diagnostics.md](./46-library-category-diagnostics.md) | 阶段交付/实施记录 |
| [47-library-package-transfer-diagnostics.md](./47-library-package-transfer-diagnostics.md) | 阶段交付/实施记录 |
| [48-task-specific-flow-optimization-plan-2026-11-13.md](./48-task-specific-flow-optimization-plan-2026-11-13.md) | 阶段交付/实施记录 |
| [49-af00-baseline-and-sample-2026-11-13.md](./49-af00-baseline-and-sample-2026-11-13.md) | 阶段交付/实施记录 |
| [50-af01-stage-contract-delivery-2026-11-13.md](./50-af01-stage-contract-delivery-2026-11-13.md) | 阶段交付/实施记录 |
| [51-af01-07-delivery-2026-11-13.md](./51-af01-07-delivery-2026-11-13.md) | 阶段交付/实施记录 |
| [HANDOFF_2026_10_13_C32.md](./HANDOFF_2026_10_13_C32.md) | 交接记录 |
| [HANDOFF_2026_10_13_C33.md](./HANDOFF_2026_10_13_C33.md) | 交接记录 |
| [HANDOFF_2026_10_14_C4_RELEASE.md](./HANDOFF_2026_10_14_C4_RELEASE.md) | 交接记录 |
| [HANDOFF_2026_10_14_C4_RELIABILITY_SYNC.md](./HANDOFF_2026_10_14_C4_RELIABILITY_SYNC.md) | 交接记录 |
| [HANDOFF_2026_10_14_REPOSITORY_SYNC.md](./HANDOFF_2026_10_14_REPOSITORY_SYNC.md) | 交接记录 |
| [HANDOFF_2026_10_15_MEDIA_REFERENCES_SYNC.md](./HANDOFF_2026_10_15_MEDIA_REFERENCES_SYNC.md) | 交接记录 |
| [HANDOFF_2026_10_15_VIDEO_AGENT_SYNC.md](./HANDOFF_2026_10_15_VIDEO_AGENT_SYNC.md) | 交接记录 |
| [HANDOFF_2026_10_16_AGENT_ONLINE_SYNC.md](./HANDOFF_2026_10_16_AGENT_ONLINE_SYNC.md) | 交接记录 |
| [HANDOFF_2026_10_16_AGENT_REMAINING_WIP.md](./HANDOFF_2026_10_16_AGENT_REMAINING_WIP.md) | 交接记录 |
| [HANDOFF_2026_10_16_R09_LOCAL_RELIABILITY_SYNC.md](./HANDOFF_2026_10_16_R09_LOCAL_RELIABILITY_SYNC.md) | 交接记录 |
| [HANDOFF_2026_10_19_DIAGNOSTICS_SYNC.md](./HANDOFF_2026_10_19_DIAGNOSTICS_SYNC.md) | 交接记录 |
| [HANDOFF_2026_10_19_OPTIMIZATION_CLOSURE.md](./HANDOFF_2026_10_19_OPTIMIZATION_CLOSURE.md) | 交接记录 |
| [HANDOFF_2026_11_24_BL10_CAPABILITY_CATALOG.md](./HANDOFF_2026_11_24_BL10_CAPABILITY_CATALOG.md) | 交接记录 |
| [HANDOFF_2026_11_24_BL11_FLOWGRAPH_V2.md](./HANDOFF_2026_11_24_BL11_FLOWGRAPH_V2.md) | 交接记录 |
| [HANDOFF_2026_11_24_CLIENT_INTERACTIVE_TIMEOUT.md](./HANDOFF_2026_11_24_CLIENT_INTERACTIVE_TIMEOUT.md) | 交接记录 |
| [HANDOFF_2026_11_24_HUMAN_GATE_AND_BROWSER_GATE.md](./HANDOFF_2026_11_24_HUMAN_GATE_AND_BROWSER_GATE.md) | 交接记录 |
| [code-review-2026-10-16.md](./code-review-2026-10-16.md) | 审查记录 |
