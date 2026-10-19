# 46 包：素材分类操作诊断

2026-10-19 同步状态：本包随当前工作区改动一并提交线上，详见 [统一交接备注](HANDOFF_2026_10_19_DIAGNOSTICS_SYNC.md)。下方未提交状态保留为分包当时记录。

2026-10-19。接续日志覆盖清单 L04 的“分类操作失败事件未接”。保留工作区已有源码诊断修复和 45 包导出环境改动。本包修改素材分类 IPC 和事件注册表，不修改分类仓库、版本冲突规则、节点协议或 UI。

## 用户路径与实现

用户打开素材分类列表，或保存分类的新版本。两条公共 IPC 分别创建独立 trace/span，并通过现有诊断入口记录 `library.category.started` → 唯一 `completed` / `failed`。`operation=list/save` 区分操作，成功仅在原仓库调用返回后记录；失败时记录 `phase=repository` 与固定 `READ_FAILED/SAVE_FAILED`。分类输入与返回值、原有错误 envelope 及提示保持。

日志不包含分类 ID、名称、描述、槽位、完整配置、原始异常、路径或密钥。错误对象由固定模板构造，原始仓库异常只沿既有 IPC 错误返回路径处理，不复制到诊断。当前稳定码只定位读/写仓库边界，不根据中文错误消息推断校验失败、版本冲突或底层设备故障；更细原因仍需仓库提供受控错误类型。

## 日志检查模板

- 影响：分类列表读取（仓库也可能初始化内置分类）和分类保存；复用 emitDomainEvent/gateway producer/诊断 service，无第二个 logger。
- 事件职责：IPC 拥有开始和唯一终态，仓库不重复发事件；每次调用新 trace/span，不伪造节点或项目关联。
- 字段：三个新事件均登记白名单；operation 固定为 list/save，失败 phase 固定为 repository，code 为原 IPC 的固定失败码。
- 失败语义：原有 success/failure envelope 保持；不重试、不重放保存、不以日志落盘作为业务成功条件。
- 隐私：固定模板和受控错误，不传入用户分类字段或原始仓库错误；实际诊断 service 序列化的 JSONL 内存文件检查私密标记排除。
- 容量/兼容：仅记录公共调用，不记录渲染或列表逐项数据；沿用公共有界队列/分片和 schema，不迁移旧记录。
- 未覆盖：其他素材操作的日志迁移、仓库细分错误类型、真实界面点击与磁盘故障组合；本包不据此宣称素材域全链路完成。

## 验证证据

`npm test -- test/observability/library-category-diagnostics.test.ts test/library-persistence.test.ts test/observability/schema.test.ts test/observability/gateway-chain.test.ts`：4 文件 **39/39** 通过。

新增 7 项覆盖 list/save 成功与失败的唯一终态、私密错误排除、logger 抛错时业务不变，以及公共 IPC 事件进入真实诊断 service 后的序列化、独立操作关联与零丢弃。IPC 测试的分类仓库使用替身；原有 13 项素材持久化测试独立验证真实 SQLite 的分类版本、冲突与资源行为，两类证据不冒充一条真实窗口端到端路径。首次测试错误引用不存在的健康字段 droppedEvents，已改为现有 droppedTotal；原失败不计通过。

`npm run typecheck:node`、三个变更文件的 ESLint、`npm run verify:logging`、`git diff --check` 均通过。上一包完整 verify `run-E3y2A7` 不作为本包新代码的全量验证证据。本包未改节点或存储算法，未重复运行完整浏览器/桌面门禁或 90 分钟压力。

本包未提交/推送。真实设备故障、物理掉电、供应商远端取消与 R11 计费验收仍按原边界处理。
