# F8（三）多画布按项目锁并发

日期：2026-11-08。基线：`49179a8`（F6 收尾 + F7 批次）。本包只改 `LocalAccessService`
的写入互斥粒度，不新增外部操作、不改任何回执字段。

## 1. 改造前的问题

`LocalAccessService` 用**一个布尔标志**表示"有写操作在跑"：

```ts
if (this.mutating) throw new AccessFailure('RESOURCE_BUSY', 'operation-occupancy')
this.mutating = ownsMutation = true
```

后果：给项目 B 导入一个媒体，会被项目 A 的一次保存挡住并返回 `RESOURCE_BUSY`——
两个项目之间不可能并行，批量作业只能串行。这与 F8 要求的"多个独立画布按项目隔离、
不互相偷走上下文"不符。

## 2. 现在的锁语义

| 写入类型 | 锁键 | 并发行为 |
| --- | --- | --- |
| 输入含 `projectId` 的写操作（媒体导入/删除、project.save/rename/update/clone/export、history.*、flow.* 写、node.library.insert、library.resource.materialize…） | 该项目 ID | 同项目严格串行（`RESOURCE_BUSY` 不变）；**不同项目可并行** |
| 输入不含 `projectId` 的写操作（skill.install、project.import/importStructure、library.import/export、资源库/节点库全局写） | 全局锁 `*` | 与其他任何写操作互斥，语义与改造前一致（全局存储在项目之间是共享事实） |
| 改变应用级活动画布的写操作（`project.open`） | 全局锁 `*` | 与其他任何写操作互斥（两个项目同时 open 会互抢活动画布） |

实现要点：

- 锁是同步获取（`acquireMutationLock` 在第一个 `await` 之前完成），单线程 JS 下不存在
  检查-获取竞态；
- 全局锁在飞时，项目写入一律拒绝；反过来，任意项目写入在飞时全局写入也拒绝；
- **异常路径必须释放**：`finally` 里按锁键释放，否则一次失败的保存会把该项目永久堵死；
- 释放按锁键而不是布尔，`run.cancel` / `history.recovery.resolve` 等既有豁免逻辑保持不变。

## 3. 真实验证证据

`test/local-agent-concurrency.test.ts`（4 项，确定性手法：用可控桌面宿主把
`project.save`/`project.open` 的握手**悬住**，在"写操作确实在飞"的时刻发起其他写入，
不依赖时间竞态）：

1. A 的保存卡在桌面 flush 时：同项目 `media.import` → `RESOURCE_BUSY`；无 projectId 的
   `skill.install` → `RESOURCE_BUSY`；**项目 B 的 `media.import` 正常完成**，且媒体只落在 B
   （A 仍为 0 条）；
2. `project.open`（全局锁）在飞时，项目写入被挡住；打开完成后项目写入恢复正常；
3. 写操作失败（宿主拒绝）后锁被释放，同项目下一次写入成功且媒体归属正确；
4. 两个项目并发导入媒体：两条都完成，各自目录归属正确（无锁泄漏、无跨项目串用）。

批次门禁（真实运行）：`npm run typecheck` 通过；12 个接入测试文件 **120 项通过**
（含本包 4 项，既有 116 项语义未变）。

## 4. 边界（如实登记，不得据此宣称"两画布并行运行"已完成）

- 本包只放开**服务层互斥**。当前应用是"单窗口权威宿主"：`node.execute`、`graph.patch`、
  `project.open` 都要求目标是活动画布，桌面握手本身也只有一个 pending 槽。
  因此**"两张画布同时执行节点"仍然不可能**——它需要多宿主（多个后台宿主或等价会话）
  与按项目隔离的编辑器/保存协调器/诊断，属 F9/F10 专项，不在本包。
- 桌面侧并发写入仍会在宿主 pending 槽上得到 `RESOURCE_BUSY`（这是正确行为，不是抖动）。
- 全局存储在项目之间仍是串行事实（资源库/节点库/包导入），未做分库或行级锁。
