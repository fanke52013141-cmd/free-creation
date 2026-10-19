# 47 包：素材资产包导入导出诊断

2026-10-19 同步状态：本包随当前工作区改动一并提交线上，详见 [统一交接备注](HANDOFF_2026_10_19_DIAGNOSTICS_SYNC.md)。下方未提交状态保留为分包当时记录。

2026-10-19。接续 46 包，继续迁移素材库的已确认日志缺口。保留 45/46 包及本次工作区已有源码验证修复。本包不改变资产包格式、分类版本、导入事务、去重规则或媒体处理算法。

## 用户路径与行为

用户从素材库导出 `.canvaslib`，或选择资产包导入。公共 IPC 创建一次独立 trace/span，在打开文件对话框前记录 `library.transfer.started`，随后只记录一种终态：

| 路径 | 终态及业务行为 |
| --- | --- |
| 对话框仍未返回 | 只有 started，不虚构完成或失败 |
| 取消或未选文件 | cancelled，phase=dialog；返回原 CANCELLED 提示，不调用仓库 |
| 对话框异常 | failed，phase=dialog；现在返回 EXPORT_FAILED/IMPORT_FAILED envelope，避免未处理的 IPC Promise 拒绝 |
| 选择文件后仓库失败 | failed，phase=repository；保留原失败 envelope 与用户错误提示 |
| 仓库成功返回 | completed，保留导出路径或实际导入数量的原业务返回值 |

操作不自动重试，不重放导入，不自行推断回滚结果。导出范围参数原样传入仓库一次，导入文件只调用一次；完成事件表示仓库已返回，不证明物理掉电耐久。

## 日志检查模板自查

- 影响：素材库资产包 import/export 的对话框与仓库调用。IPC 为生命周期唯一负责人，仓库不重复记录。
- 事件：library.transfer.started/completed/cancelled/failed；每次新 trace/span，不伪造项目或节点关联。
- 字段：operation=import/export；取消/失败的 phase=dialog/repository；失败 code=EXPORT_FAILED/IMPORT_FAILED。全部登记事件白名单。
- 隐私：消息与诊断错误对象为固定模板；不传入文件路径/名称、资源 ID 列表、资产正文、配置或原始异常。原业务返回中的文件路径和用户错误提示仍供本地 UI 使用，不进入诊断事件。
- 失败：日志 sink 抛错时，成功、取消、对话框异常和仓库失败的业务结果均保持；不因日志写盘失败改变原事务。
- 频率：仅公共导入/导出操作，不记录文件内容或逐资产事件；复用公共队列、分片与丢弃计数。
- 兼容：只新增事件；没有资产包 schema、节点协议或 UI 改动。错误原因仅标记固定操作/边界，未解析原错误正文推断底层原因。

## 验证

命令：`npm test -- test/observability/library-transfer-diagnostics.test.ts test/observability/library-category-diagnostics.test.ts test/library-persistence.test.ts test/observability/schema.test.ts test/observability/gateway-chain.test.ts`。

5 文件 **53/53** 通过。其中新增 14 项覆盖导入/导出成功、取消、空选择、对话框异常、仓库异常、等待中的无假终态、logger 故障四类结果，以及真实诊断 service 的 JSONL 内存文件序列化、三次独立关联、唯一终态、零丢弃和私密字段排除。46 包7项与原有 SQLite/包往返/去重等持久化13项一并通过。

`npm run typecheck:node`、受影响三个文件 ESLint、`npm run verify:logging` 与 `git diff --check` 均通过。本包验证摘要与源码哈希保留于 `qa/library-transfer-20261019/validation.json`；该忽略目录不随源码提交。

## 边界与交付

IPC 测试替换对话框和资产仓库，原 SQLite/资产包测试独立验证实际持久化；不把两者组合宣称为真实窗口点击端到端验收。诊断序列化测试使用可注入内存文件系统，不冒充真实设备故障。未验证所有素材库操作、真实磁盘满/断电/导入强杀或安装包环境。

未重复完整浏览器/桌面门禁或90分钟压力，上一包完整门禁不作为本包新增代码的全量通过证据。本包未提交/推送，真实供应商与R11仍暂缓。
