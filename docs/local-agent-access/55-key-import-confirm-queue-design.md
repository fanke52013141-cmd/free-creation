# 待实施设计：凭据包导入的人工确认队列（2 项）

日期：2026-11-08。适用：`ipc.keys.importPackage`、`ipc.keys.importProviders`。

## 为什么不能只加个 `confirmImport` 标志

用户已确认的口径是：**外部 prepare → 人在 GUI 亲眼确认 → 外部 continue**。
如果只要求调用方传 `confirmImport: true`，那等于让 Agent 自己给自己确认——
与"人工门禁"的定义直接矛盾。所以必须有一个人真正在界面上点过确认的事实来源。

## 现状与阻塞

| 需要的改动 | 文件 | 状态 |
| --- | --- | --- |
| 新增 main 侧 IPC：`providerPackageImport.list / confirm / cancel` | `src/main/ipc/gateway.ipc.ts` | **该文件正被并行工作流修改（+205 行）** |
| preload 暴露三个方法 | `src/preload/index.ts` | 受保护文件，需同步改 |
| 渲染器确认界面（待确认列表 + 确认/取消） | 新组件 + 挂到模型设置页 | 新文件，无冲突 |
| 待确认队列存储 | 见下 | 新文件，无冲突 |

结论：**卡在两个正被并行修改的文件上**，现在动手会与那批工作冲突。

## 设计（可直接照做）

### 1. 队列存储：内存 + TTL，不落库

```ts
// src/main/agent-access/key-import-queue.ts（新文件）
interface PendingImport {
  id: string                 // 待确认 ID（外部持有）
  packageId: string          // 包内声明的包 ID（用于查重）
  fileName: string           // 受控导入目录内的文件名
  password: string           // 仅存内存，进程退出即消失
  preview: { ... }           // openKeyPackagePreview 的结果（去敏后）
  createdAt: number
  expiresAt: number          // now + 10 分钟
}
```

**为什么不落库**：密码不能进 SQLite（落了就是长期明文/加密密钥管理问题），
而"待确认"本来就是短时交互状态，进程重启即作废是更安全的默认。

### 2. 三个操作（外部侧）

| 操作 | 效果 | 行为 |
| --- | --- | --- |
| `provider.package.importPrepare` | write | 从受控目录读包 + 密码 → `openKeyPackagePreview` 校验 → 入队 → 返回 `importId` + 去敏预览 + `confirmationRequired: true`。**不导入**。 |
| `provider.package.importStatus` | read | 按 `importId` 查状态：`pending` / `confirmed` / `cancelled` / `expired`。**不导入**。 |
| `provider.package.importApply` | write | 仅当队列项为 `confirmed` 时才调 `applyKeyPackageImport`；否则拒绝 `IMPORT_NOT_CONFIRMED`。 |

### 3. GUI 确认路径（人的部分）

新增 IPC 三件（等 `gateway.ipc.ts` 落定后加）：

- `providerPackageImport.list` → 列出待确认项（只给 packageId/连接清单/签发设备摘要/到期，**不含密码**）
- `providerPackageImport.confirm(importId)` → 标记 `confirmed`（由渲染器按钮触发，写诊断事件）
- `providerPackageImport.cancel(importId)` → 标记 `cancelled` 并出队

渲染器：模型设置页顶部一个"待确认的凭据包导入"提示条，点开弹确认框（展示包内连接清单），
确认/取消两个按钮。**没有任何默认确认、没有回车默认值**。

### 4. 不可绕过的约束（测试要逐条断言）

1. 未确认的 `importId` 调 `importApply` → `IMPORT_NOT_CONFIRMED`，且 `applyKeyPackageImport` 零调用；
2. 确认后 10 分钟内未 apply → 自动过期，apply 报 `IMPORT_EXPIRED`；
3. `confirm` 只对存在的 `importId` 生效，重复确认幂等；
4. 队列项在 apply 成功后立即出队（不可重放）；
5. 密码不出现在任何诊断事件、IPC 列表响应或日志里；
6. 包文件只从受控导入目录读（不接受任意路径）。

### 5. `importProviders`（旧 `.cskeys` 传输）同样走这条队列

它用 `gateway/provider-transfer.importProviders(filePath, password)`，语义与凭据包一致
（解封 + 覆盖确认），因此复用同一队列与同一确认路径，只是 apply 时调不同函数。

## 实施顺序建议

1. **等** `gateway.ipc.ts` / `preload/index.ts` 的并行改动落定并提交；
2. 写 `key-import-queue.ts`（纯内存队列 + TTL + 状态机）+ 单测（这时就能测，不依赖 IPC）；
3. 加三个外部操作 + 测试（用假队列/假服务，验证"未确认不导入"）；
4. 加三个 IPC + preload + 渲染器确认条；
5. 桌面验收：外部 prepare → 界面点确认 → 外部 apply 成功；以及"不点确认就 apply 必失败"。

第 2、3 步不依赖被占用的文件，其实**现在就能做**（约等于把队列与外部契约先落地），
但为了让"确认"有真实的界面来源，最终验收必须等第 4、5 步。是否先做 2、3 步，由用户决定。
