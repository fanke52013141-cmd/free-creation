# free-creation 项目长期备忘

- 产品：Canvas Studio，单用户本地 Electron 无限画布创作工具；无登录/多租户是产品约束，审查时不算缺陷。
- 工程约束：节点协议见 NODE_CONTRACT_SPEC.md；改节点能力面必须跑 `npm run agent:generate` 并提交 generated/agent-contracts.json；破坏性变更需 bump contractVersion；门禁测试会拦截漂移。
- 验证基线（2026-09-12）：npm test 950/950、npm run verify 全绿；09-15 审查时 Node 22.22.2 下 18 项因 better-sqlite3 ABI 失败，非业务缺陷。
- git 习惯：本机 origin/main 跟踪引用曾出现读旧值问题，判断推送状态一律 `git ls-remote origin refs/heads/main`；推送用 `-c http.proxy= -c https.proxy=` 直连；代理 127.0.0.1:7897 常不可用。
- 资源限制：Windows 本机并行跑多套检查会 OOM；构建/测试分开跑，vitest 用 --maxWorkers=2 --no-file-parallelism。
- 审查/审计产物：报告放本地未跟踪目录（artifacts/、outputs/），不提交；docs/ 下按日期放 handoff（如 docs/HANDOFF_2026_09_15_CODE_REVIEW.md），HANDOFF.md 头部加索引条目。
- 未修复积压：2026-09-15 审查 11 项（P1×8：F01–F08，P2×3：F09–F11），优先级 F01–F03 数据安全 → F04 VM 隔离 → F05–F07 双入口统一 → F08–F11；详见 docs/HANDOFF_2026_09_15_CODE_REVIEW.md。
