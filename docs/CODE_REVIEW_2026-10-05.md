# Canvas Studio 代码审查报告

**审查对象**：`D:/Program Files (x86)/canvas-studio/source`（git 仓库根，`main@ee85e43`）
**规模**：322 个 TS/TSX 源文件，约 6.1 万行（`src/`）+ 8700 行（`packages/`）
**审查日期**：2026-10-05
**审查维度**：正确性 / 死代码 / 矛盾代码 / 文档偏差 / 工程化配置

## 静态检查基线

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查（主进程） | `tsc --noEmit -p tsconfig.node.json` | ✅ 通过，0 错误 |
| 类型检查（渲染进程） | `tsc --noEmit -p tsconfig.web.json` | ✅ 通过，0 错误 |
| ESLint | `eslint . --quiet` | ✅ 通过，0 错误 |

> **关键结论**：这个项目的「错误」全部是**静态检查抓不到的那一类** —— 类型层面完全合法，逻辑层面自相矛盾。`tsc` 和 `eslint` 全绿不代表代码是对的，只代表代码是"整齐的错误"。

---

## 一、正确性缺陷

### 🔴 B1. SQLite `LIKE` 未转义 `_`，导致跨项目媒体越权读取 / 克隆 / 导出

**位置**（5 处）：
- `src/main/store/media.repo.ts:206` — `listMedia()`
- `src/main/store/projects.repo.ts:321` — `cloneProject()`
- `src/main/store/library.repo.ts:549`
- `src/main/store/library.repo.ts:621`
- `src/main/store/transfer.ts:46` — `exportProject()`

**代码**（`media.repo.ts:202-208`）：
```typescript
export function listMedia(projectId: string): MediaAsset[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, mime, path, size_bytes, created_at, name FROM media
       WHERE path LIKE ? ORDER BY created_at DESC`
    )
    .all(`projects/${projectId}/media/%`) as ...
```

**为什么是错的**：

SQL `LIKE` 的 `_` 是「匹配任意单个字符」的单字符通配符，不是字面量下划线。项目 id 由 `nanoid(12)` 生成，默认字母表含 `_`。

**实测验证**（本机跑 50000次采样）：
```
含 _ 的 projectId 占比: 17.02%
样例: raaHVa6uHenN, XotyoF4GA-fD, GevW128FzMfN, xMJhggfQicve, GeGAALArq0n1
```

于是当项目 A 的 id 为 `ab_cdefghijk`、项目 B 的 id 为 `abXcdefghijk`（X 为任意字符）：
- `listMedia(A)` 会命中 `projects/abXcdefghijk/media/%` → **把 B 的媒体返回给 A**
- `cloneProject(A)` 同理 → **克隆 A 时把 B 的媒体一并复制进副本，并重写 path**
- `exportProject(A)` 同理 → **导出包混入其他项目素材**

**影响链**：`useMediaStore`（资产面板列出别的项目素材）→ `checkProjectFiles`（把 B 的缺失文件报成 A 缺失）→ `batchExportMedia`（A 可以把 B 的素材导出到任意目录）。这既是**数据泄漏**也是**数据错写**。

**仓库内已有正确范式**（`video-transform.ts:495`、`image-edit.ts:28`、`image-transform.ts:72`、`video-conversion.ts:353` 共 5 处）：
```sql
WHERE id = ? AND substr(path, 1, length(?)) = ?
```
这 5 处做对了，但 `store/` 下的 5 处漏改—— 说明团队知道这个坑，只是没统一。

**建议**：把这 5 处 `path LIKE ?` 换成上述 `substr` 前缀比对；或保留 LIKE 但加 `ESCAPE` 并转义 `id` 中的 `[\\%_]`。补一条回归测试：用含 `_` 的 projectId 断言 `listMedia` 不返回邻居项目资产。

---

### 🔴 B2. `handleMount` 的 5 个监听器从不注销 → 切换项目后旧画布持续触发保存

**位置**：`src/renderer/src/canvas/CanvasEditor.tsx:1512-1632`

**代码**：
```typescript
editor.store.listen(
  () => {
    if (restoreFailedRef.current) return
    useSaveCoordinator.getState().markDirty()
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushSave, 800)
  },
  { scope: 'document' }
)
```

**已确认的注册点**（grep 验证）：
```
1512:  editor.store.listen(...)              ← 保存触发
1527:  editor.store.listen(...)              ← 双节点自动连接
1577:  editor.sideEffects.registerAfterDeleteHandler('shape', ...)
1600:  editor.store.listen(...)              ← 第三条
1630:  editor.sideEffects.registerAfterCreateHandler('shape', ...)
```

**为什么是错的**：

`Tldraw` 的 `onMount` 只在挂载时调一次，`handleMount` 内**所有 `listen()` 返回的取消函数都被丢弃**，3 个 `store.listen` + 2 个 `sideEffects` 永久存活。

最严重的是 `:1512` 那条（`scope: 'document'`）：它持有 `saveTimerRef`。当用户离开画布再进入**另一个项目**时，tldraw 的 `Editor` 实例被重建（`App.tsx` 的 `view==='canvas'` 切换会卸载 `<CanvasPage>`），**旧 Editor 的 document 监听仍然活着**。任何对旧 store 的残留变更都会 `markDirty()` 并在 800ms 后 `flushSave()`，而 `collectSaveInput()` 读的是新的 `editorRef.current`——

**于是旧项目的变更会触发新项目的保存，把新项目快照写进新项目（版本号错乱），反之亦然。**

另外 `autoConnectFrame`（`:1526`）同样没有 unmount 时 `cancelAnimationFrame`。

**对照组**：`DataEdgeLayer.tsx:313-314` 正确调用了 `offDocument()` / `offSession()`—— 可见这是团队已知模式，`handleMount` 是遗漏。

**建议**：收集所有 disposers 并注册卸载清理；更彻底的做法是把 `handleMount` 的副作用部分抽成 `useEffect(() => { ...; return () => disposers.forEach(d => d()) }, [editor])`，与 `DataEdgeLayer` 保持一致。

---

### 🟡 S1. `waitForVideo` 轮询无重入保护 + 未捕获 rejection

**位置**：`src/shared/engine/helpers.ts:247-268`

**代码**：
```typescript
const timer = setInterval(async () => {
  if (signal.cancelled) { stop(); void gateway.videoCancel(taskId); reject(new Error('已取消')); return }
  const result = await gateway.videoTask(taskId)
  ...
}, 3_000)
```

**三个问题叠加**：
1. **无 reentrancy 保护** —— `setInterval` 不等待上次回调结束。若 `videoTask` IPC 往返超 3 秒（`CONTROL_TIMEOUT_MS` 是 **60 秒**，见 `upstream-fetch.ts:8`），会堆积多个请求。超时 `setTimeout(600_000)` 与在途 `await` 之间**没有 `stopped` 后置检查** —— `stop()` 只清定时器，不阻止已进入的 `await` 恢复后继续 `resolve`。
2. **`await gateway.videoTask()` 无 `.catch`** —— IPC 层 reject 时（主进程 handler 抛错、窗口关闭），rejected promise 无人处理 → **unhandled rejection**，且视频任务永远不会 reject，节点挂到 10 分钟超时。
3. `if (!result.ok || !result.data) return` —— 连续失败**永不 reject**，无失败计数，只靠 10 分钟兜底。

**参照**：`waitForChat`（`:196`）的 `cancelTimer` 有 `done` 幂等闩锁，是安全写法。

**建议**：加 `polling` 闸门 + `stopped` 双重检查 + `try/catch/finally`。

---

### 🟡 S2. 代码节点「固定时钟」随时区漂移，违背确定性承诺

**位置**：`src/renderer/src/engine/codeRuntime.ts:45-49, 72-91`；承诺在 `src/renderer/src/nodes/specs/bodies/code.tsx:246-247`

**代码**：
```typescript
class FixedDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [0])); }
  static now() { return 0; }
}
...
format: (pattern = 'YYYY-MM-DD HH:mm:ss') => pattern
  .replace('YYYY', String(date.getFullYear()))     // ← 本地时区
  .replace('MM', pad(date.getMonth() + 1))
```

**三个问题**：
1. `FixedDate` 无参时确实得到 epoch 0，但 `format` 用的是 **`getFullYear/getMonth/getDate/getHours`（本地时区）**。UTC+8 时 `dayjs().format()` 返回 `1970-01-01 08:00:00`，UTC-5 时返回 `1969-12-31 19:00:00`。`code.tsx:246-247` 告诉用户「固定为 1970-01-01」，但实际输出随时区漂移—— **同一份代码在不同机器上跑出不同结果**，直接违背 `CODE_RUNTIME_POLICY.clock: 'fixed-epoch'` 的确定性承诺。
2. `Date.parse` / `Date.UTC` 仍是原生实现，**「固定时钟」可被 `new Date(2024, 0, 1)` 绕过**。
3. `add()` 的单位表（`:87`）**缺 `week`/`month`/`year`/`quarter`**，且 `ms` 查表用 `|| 1` 兜底 —— `dayjs().add(1, 'month')` 会静默变成 **+1 毫秒**而非报错。

**建议**：`format` 改用 `getUTC*` getter；`add`/`subtract` 补全单位表，未知单位**抛错**而非静默按毫秒处理。

---

### 🟡 S3. `runWorkflow` 在确认弹窗期间未复查 `phase` → 可并发两个 workflow

**位置**：`src/renderer/src/engine/executor.ts:1290-1317` 与 `:1374-1436`

**代码**：
```typescript
export async function runWorkflow(editor, projectId, providers): Promise<void> {
  const store = useEngineStore.getState()
  if (store.phase !== 'idle') return          // ← 检查
  ...
  if (plan.willGenerate.length > 0) {
    const proceed = await useConfirmStore.getState().confirm({ ... })   // ← await，可能数秒
    if (!proceed) return
  }
  const token = createRunControl()
  registerRunControls(token)
  store.beginRun(executableOrder.length)     // ← 没有复查 phase
```

**为什么是错的**：`phase` 检查与 `beginRun()` 之间存在一个**任意长的 await 窗口**（确认弹窗）。期间顶栏「运行」按钮仍可点（`CanvasPage.tsx:337` 只看 `enginePhase !== 'idle'`），用户再点一次会**通过第二次的 phase 检查**（第一次还没 beginRun）→两个 workflow 同时进入执行循环。

后果：`beginRun` 被调两次（`done` 计数器重置两次），`registerRunControls` 的控制器被后一次覆盖 → **用户点「停止」只能停掉后一个**，前一个继续跑并继续产生费用（生图/生视频）。先结束的那个会调 `clearRunControls()` 清空仍在运行的那个的控制器，**导致第二次点「停止」时 `store.stop` 已是 `null` 而无法停止**。

另外 `runNodeTest`（`:206`）**完全不检查 `phase` 也不检查 `isolatedImageRuns`**，测试运行与正式运行可并发写同一节点的 `meta.nodeResult`。

**建议**：在 `beginRun()` 前加同步占位（`EnginePhase` 加 `'starting'`）。

---

### 🟡 S4. `discardMaterialization` 逐个删除无错误隔离 → 孤儿文件 + 永久脏 usage 记录

**位置**：`src/main/store/library-materialization.repo.ts:135-140`

**代码**：
```typescript
for (const mediaId of JSON.parse(row.project_media_ids_json) as string[])
  await deleteMedia(mediaId)
getDb().prepare('DELETE FROM library_usages WHERE id = ? AND project_id = ?').run(input.usageId, input.projectId)
```

**三个风险**：
1. **循环中途抛异常**（`JSON.parse` 遇脏数据、DB 已关闭、`mkdirSync` 失败）→ 循环中断，**已删除的行不回滚，`library_usages` 也不删**。剩余素材文件成为磁盘孤儿（DB 无记录，永不清扫），且 `library_usages` 仍指向一批不存在的 mediaId —— 同一 usageId 再次 discard 会**静默返回 `true` 却什么都没删**。
2. `JSON.parse` **无 try/catch 也无类型校验**。该列是 `TEXT NOT NULL DEFAULT '[]'`，但 `cloneProject`（`projects.repo.ts:465`）的 `remapJsonIds` 的 `catch { return value }` 分支会把**非法的原始字符串原样写回** —— 这就把非 JSON 字符串持久化进 DB，之后 `JSON.parse` 必抛。
3. `deleteMedia` 返回 `false`（mediaId 不存在）时被静默忽略，调用方无法区分「删掉了」和「本来就没有」。

**对照**：同文件 `materializeResource:118-122` 有补偿写法（注释标"best-effort compensation"），这里的反向操作完全没有对称保护。

---

### 🟡 S5. `library.repo.ts` 的 `storeBlob` 并发写竞争留下 `.tmp` 残骸

**位置**：`src/main/store/library.repo.ts:222-249`

**代码**：
```typescript
const temporary = `${absolutePath}.${nanoid(6)}.tmp`
writeFileSync(temporary, bytes, { flag: 'wx' })
try {
  renameSync(temporary, absolutePath)
} catch (error) {
  if (existsSync(temporary)) {
    const current = getDb().prepare('SELECT id, path FROM library_blobs WHERE sha256 = ?').get(hash)
    if (!current) throw error        // ← 抛错前没有 unlinkSync(temporary)
  }
}
```

**问题**：
- `catch` 分支只在「DB 里已有该 hash 记录」时才吞掉 rename 失败；`!current` 时**抛错但没有 `unlinkSync(temporary)`** —— 一次 rename 失败（Windows 上文件被占用是常见现象）就在 `library/blobs/` 下留下孤儿 `.tmp`（**最大 128MB**）。这类残骸无任何清扫机制（`workspace-health.ts` 只扫 `tmp-video-*`）。
- `insert OR IGNORE` 后取 `row` 却不检查存在性（`:246-248` 直接 return）。虽然 `sha256` 有 UNIQUE 约束使概率极低，但这是**缺少防御的必然崩溃路径** —— `prepareComponentBlob` 的 `storeBlob(...).id`（`:339`）会抛 `Cannot read properties of undefined`。

---

### 🟡 S6. `NodeCardView` 的 `useValue` 依赖含每次新建的数组 → 订阅抖动 + 端口位置抖动

**位置**：`src/renderer/src/canvas/NodeCardView.tsx:585-671`

**代码**：
```typescript
const readinessState = useValue('node readiness', () => { ... }, [editor, shape, spec, inPorts, modelAvailable])
```

`inPorts` 来自 `getNodePorts(spec, shape)`（`:339-341`），**每次调用返回全新数组**（内含 `new Set`、`.map`）→ 依赖数组永远变化 → 每次渲染都重算整个 readiness（内含遍历所有 arrow、`projectNodeOutputs` 投影每个上游输出）。

**不只是性能问题**：`readinessState.incomingPortIds` / `outgoingPortIds` 每次都是新 `Set`，被喂给 `createNodePortLayout(..., readinessState.incomingPortIds, ...)`（`:697-710`）计算端口 Y 坐标。React 重渲染与 tldraw store 更新交错时，**端口布局可能用上一轮的 connection 集合计算**，产生可见的端口位置抖动 —— 用户正在拖的连线会脱锚。

同文件 `:717-767` 的 `occludedPortKeys` 依赖 `visibleInPorts/visibleOutPorts/visibleInY/visibleOutY`（同样每次新建），问题相同。

---

### 🟡 S7. `NodeCardView` 的 `modelCheck` 在保存供应商瞬间让全画布运行按钮变禁用

**位置**：`src/renderer/src/canvas/NodeCardView.tsx:110-155`

`modelCheckKey` 包含 `providers` 数组**引用**。只要 store 里 providers 被任何操作（`listProviders()` 后 `set({providers})`）产生**内容相同但新引用**，就会触发**画布上每一个节点卡片**重跑 `resolveFeatureOption`（100 个节点 = 100 次 IPC 风暴）。期间 `modelAvailable` 因`modelCheck.providers !== providers` 短暂变 `undefined` → **节点运行按钮在保存供应商的瞬间变为禁用**。

**建议**：providers 比较改为内容比较（`providers.map(p => p.id + p.baseURL + p.specId).join('|')` 存入 key），并加 in-flight 去重与超时。

---

### 🟡 S8. `publishRevision` 乐观锁 UPDATE 静默失败仍返回成功

**位置**：`src/main/store/library.repo.ts:710-717`

函数在 `:674` 已检查 `resource.latest_revision_id !== input.baseRevisionId` 并抛错，但那是**事务外**的读。事务内这条 UPDATE 带了 `AND latest_revision_id = ?` 条件却**不检查 `result.changes`**。若将来引入并发（多窗口、独立 Electron 进程），UPDATE 影响 0 行时**新 revision 已插入但没有任何资源指向它** —— 成为永久孤儿，且占用 `UNIQUE(resource_id, revision_number)` 槽位。用户以为保存成功但内容没变。

---

## 二、矛盾代码

### 🔴 M1. `executor-types.ts` 双份定义，形状已分叉

**位置**：
- **权威版**：`src/shared/engine/executor-types.ts`（176 行）
- **副本**：`src/renderer/src/engine/executor-types.ts`（157 行）

| 字段 | shared 版 | renderer 版 |
|---|---|---|
| `shape` 类型 | `NodeShape`（`:111`，自定义结构 `:16-39`） | `NodeCardShape`（`:74`，tldraw `TLBaseShape`） |
| `inputs` 来源 | `./inputs`（`:10`） | `./contracts`（`:13`） |
| `waitForResume` 注释 | `:49` 与 `CancelSignal` 声明**挤在同一行** | `:104-108` 独立注释块 |

**关键矛盾**：renderer 版 `:15-21` 从 shared 版导入 `NodeExecutionPhase / NodeExecutionTarget / ProducedArtifact / NodeMetaPatch / NodeDiagnosticsContext`，**但没有导入 `NodeShape`**，`NodeExecutionContext` 仍用 `NodeCardShape`。于是**同一个 `NodeExecutionContext` 名字在两个文件里指向两个结构上不兼容的类型**。

**消费方是分裂的**：`src/shared/engine/executors/*.ts`（24 个文件）用 shared 版；`src/renderer/src/engine/executor.ts:24` 与 `nodes/registry.tsx:14` 用 renderer 版；`test/` 里 9 个文件用 renderer 版、6 个用 shared 版 —— **同一批测试对同一次运行断言的是两个不同类型**。

**文档已承认但没解决**：`docs/LOGGING_DEV_PLAN_2026-10-04.md:36` 写"shared 是权威精简版，renderer 是带注释的超集副本"；`:396` 更明确列为风险"两份 executor-types 漂移 | renderer 副本**只re-export/同步**"。但 renderer 副本实际是**全量重复手写**，不是 re-export。

**建议**：把 renderer 版改为纯 re-export，`shape` 的类型差异用 `NodeShape & Record<string, unknown>` 或让 `NodeCardShape` 显式 `implements NodeShape` 解决。

---

### 🔴 M2. `deriveNodeReadiness` 与执行器矛盾：`ai-process` 只连 JSON 时 UI 阻断但能跑

**位置**：
- UI 判定：`src/renderer/src/canvas/node-readiness.ts:15-20, 114-129`
- 执行器真值：`src/shared/engine/executors/aiProcess.ts:94-107`

**UI 侧**：
```typescript
const TEXT_REQUIRED_NODES = { 'image-gen': '提示词', text: '文本内容', speech: '朗读文本', 'ai-process': '任务说明' }
// ...
if (textRequirement && !text.trim() && !count('in-text') && !count('in-prompt')) {
  return { kind: 'blocked', reason: 'config-missing', label: `待补充：${textRequirement}` }
}
```

**执行器侧**：
```typescript
const textInput = inputText(ctx.inputs, 'in-text').trim()
const jsonInputs = inputJson(ctx.inputs, 'in-json')
const userContent = [textInput, ...(jsonInputs.length > 0 ? [`上下文 JSON：…`] : [])].filter(Boolean).join('\n\n')
if (!userContent) return { status: 'skipped', reason: 'AI 处理节点没有输入文本或 JSON' }
```

**矛盾分支**：`ai-process` 节点有 `in-json`（`json.any@1`，非必填）端口。**只连 `in-json`、不连 `in-text`、正文为空**时：
- UI：判定 `in-text` 与 `in-prompt` 计数均为 0 → **阻断**，显示"待补充：任务说明"，运行按钮置灰
- 执行器：`jsonInputs.length > 0` → `userContent` 非空 → **正常执行**

**用户看到"无法运行"的灰按钮，实际却能跑。** `node-readiness.ts:14` 的注释自称"与执行器分支同步维护"—— 但同步漏了 `in-json` 这一条通路。

---

### 🔴 M3. `sound-adjust` 的"恰好连接一种"互斥规则在契约层与UI 层都缺失

**位置**：
- 规范：`NODE_CONTRACT_SPEC.md:188-189` — "运行时必须恰好连接其中一种"
- 执行器（正确）：`src/shared/engine/executors/soundAdjust.ts:11-13`
- 契约（缺失）：`src/renderer/src/nodes/specs/index.tsx:663-671` — 两个端口都是 `required: false`
- 就绪判定（缺失）：`src/renderer/src/canvas/node-readiness.ts:80-90` 只检查 `port.required`

**矛盾分支**：一个 `sound-adjust` 节点**什么都没连**时，标题行显示"可运行"、按钮可点；点了之后执行器返回 `failed`。**同时连了音频和视频**时，UI 同样显示"可运行"，点击后失败。

这条规则**只存在于执行器**，UI 的三套判断（readiness / NodeContractPanel / 契约声明）都不知情。

---

### 🟡 M4. 文本分隔符 `$$$` vs `---`：3 处硬编码旧值，测试门禁覆盖不全

**真值**：`src/shared/engine/helpers.ts:118-119`
```typescript
export const TEXT_MERGE_DELIMITER = '$$$'
export const TEXT_MERGE_SEPARATOR = `\n${TEXT_MERGE_DELIMITER}\n`
```

**已确认的3 处硬编码 `\n\n---\n\n`**：
```
src/shared/engine/executors/chat.ts:17         .join('\n\n---\n\n')
src/renderer/src/canvas/ChatSidePanel.tsx:304  `${upstream}\n\n---\n\n${draft.trim()}`
scripts/audit-text-node.cjs:232                断言值也还是 ---
```

**规范自身也矛盾**：`NODE_CONTRACT_SPEC.md:290` 写 `\n$$$\n`，而 `:557` 写 `\n\n---\n\n` —— **同一份规范里两个分隔符**，会让后续实现者按 P2 章节写回 `---`。

**测试门禁有漏洞**：`test/node-ui-decisions.test.ts:387-395` 断言"`$$$` 是唯一真值"，但只检查了 `contracts.ts`、`inputs.ts`、`graph.ts` 三个文件文本不含 `---`，**没覆盖 `chat.ts` 和 `ChatSidePanel.tsx`** —— 测试全绿但实现已违反规范。

`ChatSidePanel.tsx:304` 尤其可疑：它上游 `gatherUpstreamText`（`graph.ts:1089`）刚用 `TEXT_MERGE_SEPARATOR` 拼好，同一行又用 `---` 二次拼接，**同一份数据用了两套分隔符**。

**旁证**：`docs/HANDOFF_2026_09_18...md:303` 明确写"`$$$` **不许变回** `---`"；但 `docs/NODE_FULL_AUDIT_2026_09_12.md:51` 仍记录 `---` 的"实测输出"并声称"与代码一致"（结论已失效未标注）。

---

### 🟡 M5. 日志门禁 `NETWORK_RULE` 正则漏掉最常见的 fetch 写法

**位置**：`scripts/check-logging-bypass.mjs:36`

**代码**：
```javascript
const NETWORK_RULE = /\b(fetch\(|axios|XMLHttpRequest|http\.request|https\.request)\b/
```

**实测验证**：
```
"const r = await fetch(url)"   => true
"const r = fetch()"            => false   ← 漏
"await fetch( )"               => false   ← 漏
"fetch(`${base}/x`)"           => false   ← 漏（模板字面量）
"new XMLHttpRequest()"         => true
"https.request(opt)"           => true
```

`\b` 是词边界，而 `fetch(` 末尾的 `(` 是非单词字符；当 `(` 后紧跟非单词字符（`)`、`` ` ``、空格）时 `\b` 不成立。整个 A18 门禁（`LOGGING_COVERAGE.md:28` 声称"已验收"）会**静默放过 `fetch()` 和模板字面量两种最常见写法**。

**建议**：改为 `/\b(?:fetch|axios|XMLHttpRequest)\b|\bhttps?\.request\b/`，并在 `test/observability/logging-gate.test.ts` 补这两条用例。

---

### 🟡 M6. `check-logging-bypass.mjs` 恒假死代码 + A18 规则名不副实

**位置**：`scripts/check-logging-bypass.mjs:104-105`

**代码**（已确认原样存在）：
```javascript
const fileIsNew = /^diff --git a\/(.+?) b\/(.+)$/.exec('') || false
void fileIsNew
```

`.exec('')` 对一个要求 `diff --git a/x b/y` 的正则传入空串 → 必然 `null` → `|| false` → **恒为 `false`**，第 105 行 `void` 显式丢弃。

**更深矛盾**：注释说 A18 是"**新增网络调用所在的『新文件』**必须有诊断事件接入"，但代码只统计 `parseDiff` 拆出的**新增行**，而 `parseDiff` 对**任何** diff 的新增行都产出 `addedLines` —— 包括修改已有文件。**规则语义是"新增行"，注释说的是"新文件"**。

**建议**：删除 104-105 两行；把注释与实现对齐。

---

### 🟡 M7. `NodeValuePacket` 等 5 个契约类型双份，且实现只收敛了 1/5

**位置**：
- `src/renderer/src/engine/contracts.ts:7-27`
- `src/shared/engine/inputs.ts:11-26`

两边**都**定义了 `NodeValuePacket`、`ContractOutputs`、`ContractInputMap`、`ContractInputInjection`，且**都**各自实现了 `inputPackets`/`inputJson`/`inputMedia`/`inputValue` 四个函数（`contracts.ts:210-238` 与 `inputs.ts:28-59`），实现逐行相同。

`contracts.ts:214-218` 的 `inputText` **已**转发到 `@shared/engine/inputs`，注释明确写"分隔符是共享层的单一真值…否则同一次运行里画布预览与执行器会拼出不同的文本"。但**其余 4 个函数仍各留一份** —— 注释说的"单一真值"只兑现了 1/5。

---

### 💭 M8. `EDITOR_COLORS` 是假抽象：9 个条目值全是 `'grey'`

**位置**：`src/renderer/src/canvas/graph.ts:89-102`

```typescript
export const EDGE_COLORS: Record<string, ArrowColor> = {
  text:'grey', markdown:'grey', json:'grey', image:'grey',
  video:'grey', audio:'grey', file:'grey', any:'grey'
}
export function edgeColorFor(portType: string): ArrowColor { return EDGE_COLORS[portType] ?? 'grey' }
```

9 个条目值完全相同，引用数 1。这是一层没有承载任何信息的映射 —— 要么补上区分色，要么简化为常量 `'grey'`。

---

### 💭 M9. `node-readiness.ts:132` 硬编码端口名 `'out-project'`

这是就绪判定里唯一按 **portId 字符串**判断的地方，其余分支全部走契约派生量。若新增第二个 `manual-publish` 节点或 `director` 改端口名，此处静默失效。

---

### 💭 M10. 端口布局：规范说"禁止出现多次"，布局代码却在积极支持"合并"

`NODE_CONTRACT_SPEC.md:40` 说"一般节点同一方向的同一种 `PortType` **至多出现一次**"，而 `node-port-layout.ts:80-104` `createNodePortLayout` 按类型分组、同类型端口**共用一个锚点**。规范措辞（禁止）与实现策略（合并）方向相反。代码节点正是靠这个机制支持多个同类型动态端口的 —— 规范该改为"确需多个同类端口时必须走 `many` 合并，或声明为受控例外"。

---

## 三、死代码与旧代码

### 1. 整个文件零引用（可直接删除）

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/shared/engine/index.ts` | 59 | barrel 文件零引用，26 个成员全部已从源文件直接 import |
| `src/shared/observability/legacy-adapter.ts` | 28 | `adaptLegacyTrace` 零调用，但 `observability/index.ts:10` 仍在 re-export。**且 `AGENTS.md:15` 与 `LOGGING_DEV_PLAN_2026_10_04.md:105` 都把它写成"当前接入"** |
| `src/renderer/src/gateway/FeatureProfileSelect.tsx` | 13 | 零引用，而 `docs/UNIVERSAL_MODEL_MODULE_PLAYBOOK.md:131` 声称"AI 处理节点已经使用" |

### 2. 重复实现（会静默分叉的那种）

#### 🔴 `nodeValues.ts` 与 `shared/engine/values.ts` 逐字复制 5 个函数（87 行）

| `src/renderer/src/nodes/nodeValues.ts` | `src/shared/engine/values.ts` | 函数 |
|---|---|---|
| `:85` | `:177` | `parseStoredNodeValue` |
| `:122` | `:214` | `parseNodeRecord` |
| `:149` | `:226` | `parseStoredAiResult` |
| `:169` | `:246` | `parseStoredIterateResult` |
| `:180` | `:257` | `storyboardSummary` |

**`nodeValues.ts:40-45` 的注释本身就记录了这个模式及其危害**：
> 媒体结果集合的类型与「解析 / 追加」口径只保留一份实现。执行器写它，资产索引与节点卡片读它；**此前这里逐字复制了一份，于是给产物加溯源字段必须同步改两处，漏一处就是「执行器写进去了、UI 永远读不到」的静默丢失。**

团队修过一次（搬走了媒体结果集合），**却漏了这 5 个函数**。当前 `outputProjections.ts:11-18` 从 renderer 副本导入，而 `shared/engine/index.ts:20-24` re-export 的是 shared 版 —— **两份都在编译期存在，谁先被改就 diverge**。

**建议**：`nodeValues.ts:85-192` 改为 `export { ... } from '@shared/engine/values'`（沿用同文件 `:46-52` 已有的 re-export 写法）。**零行为变更，-87 行**。

#### 其他值得抽的重复

| 重复内容 | 位置 | 量级 |
|---|---|---|
| `inputMedia`/`inputJson`/`inputValue` | `renderer/engine/contracts.ts:226-234` vs `shared/engine/inputs.ts:47-55` | 见 M7 |
| `formatTime` | `CanvasSidePanel.tsx:67-70` vs `side-panel/AssetsPanel.tsx:60-63` | 4 行 × 2 |
| `assertMiniMaxOk` + `MiniMaxEnvelope` | `main/gateway/audio.ts:323-335` vs `voice.ts:38-50` | 12 行 × 2 |
| 进度百分比夹取 | `image-generation-progress.ts:44-53` vs `node-execution-progress.ts:52-58` | 同一"不许显示 100%"规则写两遍 |
| `togglePlay` + `generate` | `speech.tsx:223-253` vs `voice-design.tsx:102-132` | 30 行逐字相同 |
| `save(partial, reason)` | `image-split.tsx:54-62` vs `:226-234` | 同文件内写两遍 |
| `launchBrowser` 驱动 | `scripts/audit-*.cjs` × 6 + `test-browser-*.cjs` × 4 + `qa/.../_lib.cjs` | **11 份独立实现，约 380 行** |

### 3. 临时调试残留

**好消息**：`src/` + `packages/` 中 `debugger` / `TODO` / `FIXME` / `HACK` / `XXX` **全部为 0**。`console.*` 仅 13 处。这在本项目中是很干净的一维。

**但 `CanvasEditor.tsx`（2132 行，最大文件）完全没有接入统一诊断底座** —— grep 确认该文件 `emitDiagnosticsEvent` / `DiagnosticsProducer` / `observability` **零命中**，而它恰好包含 4 条数据安全路径：

| 位置 | 代码 | 风险 |
|---|---|---|
| `:618` | `console.error('冲突重载失败', e)` | 冲突重载失败无留痕 |
| `:627` | `console.error('项目保存失败', reason)` | `:624` 注释自认把正式诊断降级成了 console |
| `:661, 663` | `console.error('关窗冲突且恢复副本写入失败', ...)` | 关窗路径，console 是唯一留痕 |
| `:1458` | `console.error('快照恢复失败', e)` | 恢复失败会暂停自动保存，属关键数据路径 |

同目录 `CanvasSidePanel.tsx:28`、`NodeCardView.tsx:25`、`storyboard-batch-flow.ts:2` 都已正确接入 —— **是遗漏而非设计**。

其他违规：`src/renderer/src/App.tsx:20` 直接 `log.error(error)` 传原始 Error 对象，违反 LOGGING_SPEC.md:50；`project.ipc.ts:304`、`media.repo.ts:90`、`preload/index.ts:464`、`document-text.ts:176,191` 用裸 console。

### 4. QA 探针污染源码树

**确认应清理**（无人引用的一次性脚本）：
```
qa/ux-walkthrough-2026-09-29/_lib.cjs      87 行，11 个 helper 的完整驱动库，require 零命中
qa/ux-walkthrough-2026-09-29/_explore.cjs   一次性探索脚本
qa/ux-walkthrough-2026-09-29/_explore2.cjs  同上
```

`_lib.cjs` 内还有一段自认失败的死代码（`:76-82`）：`edgeCount()` 永远 `return -1` 且 `doc` 取了不用，且未出现在 `:87` 的 `module.exports` 里。

**规模**：`qa/` 下 93 个已追踪文件（含 **31 个 `.cjs`**、34 个 `.png`）+ 104 个未追踪（约 **17 MB**）。**31 个 QA 脚本中 0 个有 npm 入口** —— 既没进 CI 也没人知道怎么跑。

**`.gitignore` 与 `eslint.config.mjs` 意图冲突**：
- `eslint.config.mjs:10` 注释写"`qa/` 是验证证据暂存区：一次性走查/验证脚本与截图，**不承担生产质量约束**"
- 但 `.gitignore` **完全没有 `qa/` 条目**，所以 `qa/` 下所有内容默认入库

### 5. 被注释掉的整块代码

**未发现。** 逐行扫描 474 个文件，检测连续 ≥10 行的注释块：宽松判据 13 命中，逐一阅读后**全部是文件头设计说明文档**，无一行是废弃代码。反而有几处注释质量很高（如 `CanvasEditor.tsx:721-732` 解释双击事件捕获的必要性，删掉会导致后人"优化"回错误实现）。

---

## 四、过期文档（会误导后续开发）

| 文档 | 大小 | 问题 |
|---|---|---|
| `HANDOFF.md` | 74 KB | 2026-09-18 快照，**未声明过期**。第 17 行仍在描述 headless vm 沙箱、`generated/agent-contracts.json`、`test/agent/save-transaction-rollback.test.ts` —— **这些对象已全部不存在**（`AGENTS.md:36-44` 记录于 2026-09-17 下线）；第 13 行描述的豆包 `doubao` 语音通道也已被移除 |
| `ROADMAP.md` | 18 KB | 2026-08-24。§1 推荐的"拆分节点执行器""建立自动化测试门禁"**均已完成**；§2 基线遗漏 15 个现行节点 |
| `UI_PLAN.md` | 8 KB | 2026-08-31。诊断表第 2 行的病根（CSS 加载顺序）已被 `NODE_UI_STANDARD.md` §13.1 三层模型解决；第 6 行"NodeCreateMenu 无分组"已由 T03 交付 |
| `R0_PLAN.md` | 22 KB | 2026-08-27。引用的所有行号已漂移（`graph.ts` 从 307-331 移到别处，`CanvasEditor.tsx` 现 2132 行） |

**建议**：这 4 份都在顶部加一行"本文已过期，仅供历史参考，现状以 XXX 为准"。

**文档卫生最好的一份**：`docs/optimization-ledger.md` 与 `docs/OPTIMIZATION_PROGRESS_2026-10-04.md` —— 头部声明"以下记录为历史状态"+ 标注核查日期，当前状态表与 `ee85e43` 提交内容一致。

---

## 五、工程化配置

### 🔴 P0-1 `electron-builder.yml` 的 `files` 未排除测试产物 —— 253MB 截图会进安装包

**位置**：`electron-builder.yml:9-21`

`files` 是纯否定列表，**完全没有提及 `test/`、`qa/`、`artifacts/`、`docs/`、`scripts/`、`packages/`**。实测体积：

| 目录 | 磁盘占用 | git 跟踪文件数 |
|---|---|---|
| `artifacts/` | **253 MB** | 696（647 个 `.png`） |
| `qa/` | 23 MB | 93 |
| `qa-fixtures/` | 12 MB | 27 |
| `docs/` | 2.7 MB | 68 |
| `results/` | 1.6 MB | 19 |

**装一个 Windows 包要下载 250MB+ 的PNG 截图。** 这是本报告最严重的工程化问题。

注意 `resources/` **不能**排除 —— 它含 `resources/icon.png`、`resources/video-conversion/runner.py`，是运行时依赖。

**建议**：`files` 补 `!test{,s}/**`、`!qa/**`、`!qa-fixtures/**`、`!artifacts/**`、`!docs/**`、`!results/**`、`!outputs/**`、`!scripts/**`、`!packages/**`、`!*.md`。

---

### 🔴 P0-2 `.gitignore` 遗漏大量产物目录 + 跟踪了运行时用户数据

`.gitignore` 只挡了 `node_modules` / `dist` / `out` / `*.tsbuildinfo` / `artifacts/*.mp4`。**完全没挡**：`qa/`、`artifacts/`、`results/`、`outputs/`、`qa-fixtures/`、`docs/`。

**直接后果**：当前工作树有 **135 个未跟踪文件**全部是这类产物；`artifacts/node-matrix-*` 已堆积 **44 个目录 / 30 个未追踪 / 约 134 MB**（单目录最大 11 MB），每次跑 `npm run test:node-matrix` 就新增一个时间戳目录，**永不清理**。

**另一条**：`.prettierignore:10` 专门排除了 `canvas-studio/data/`（说明作者知道这是运行时数据），但 `.gitignore` **漏了这条** → **54 个用户的真实项目 JSON 全部进入版本库**。

**根因**：`.gitignore:18-19` 的注释确立了"验收产物入库"约定，但该约定**没有区分"人工确认的基线"与"机器可再生的中间产物"** —— `node-matrix-*`（每次必重跑）和 `qa/**/*.png`（重跑即变）都属于后者，却被前者覆盖。

---

### 🟡 P1-1 `verify` 门禁不完整，且 CI 与 scripts 双写

`package.json:31` 的 `verify` 覆盖 7 步，但**漏掉 `test:optimization-ui`** —— 而 `.github/workflows/ci.yml` 明确把它当硬门禁在跑（`run-optimization-ui-gate.cjs:41` 失败时 `throw`）。

`ci.yml:38-66` 逐条手写 8 个步骤，与 `verify` 是**两份独立维护的门禁定义** —— 这正是漏配的实际后果。本地 `verify` 通过、CI 同commit 失败。

**建议**：把 `test:optimization-ui` 并入 `verify`，CI 改用 `pnpm verify`。

---

### 🟡 P1-2 `build:desktop-latest` 的 electron-builder 参数写法错误

`package.json:44`：
```
--config.directories.output=dist/current-source-release
```
把 `=dist/current-source-release` 粘在了 key 上。electron-builder 期望空格分隔。对照 `scripts/launch-latest-desktop.ps1:143` 的正确写法：`"--config.directories.output=$StageRoot"`。

---

### 🟡 P1-3 依赖错位

| 包 | 现状 | 应在 |
|---|---|---|
| `react` / `react-dom` | `devDependencies:97-98` | **`dependencies`** —— 渲染进程 64 个文件 `from 'react'`、10+ 处 `from 'react-dom'` |
| `@types/three` | `dependencies:61` | **`devDependencies`** —— 其他 4 个 `@types/*` 都在 dev |

---

### 💭 P2 其他

| 问题 | 位置 |
|---|---|
| `asarUnpack` 在 `asar: false` 下是**死配置**（不生成 asar，解包语义失效） | `electron-builder.yml:6` vs `:22-26` |
| `appId: com.electron.app` 是脚手架默认值，未与 `index.ts:227` 的 `com.canvas-studio.app` 对齐 | `electron-builder.yml:1` |
| `publish.url: https://example.com/auto-updates` 是占位域名 | `electron-builder.yml:56` |
| 硬编码端口 **5 套**（5173 / 3123 / 5191 / 5194 / 5202）；`audit-video-node.cjs` 与 `audit-node-ui.cjs` 用 3123，而 3123 上无服务监听，不传参必失败 | `scripts/` 9 处 |
| **9 个真孤儿脚本**（`package.json` 未引用），其中 `test-browser-library.cjs`(7.8KB) 与已被引用的 `test-library-electron.cjs`(7.1KB) 功能疑似重叠 —— 改名前的旧版本最危险 | `scripts/` |
| `tsconfig.test.json` 是孤儿配置（无任何引用），但磁盘上有 346KB 的 `tsconfig.test.tsbuildinfo` 残留 | 仓库根|
| `vitest.config.ts` 缺 `@free-creation/*` 两个别名（`electron.vite.config.ts` 有），当前靠 pnpm 软链偶然生效 | `vitest.config.ts:13-17` |
| `.prettierignore` 排除了 `scripts/` 但 ESLint 没排除 —— 19 个 `.cjs` 被 lint 但不保证格式化 | `.prettierignore:11` vs `eslint.config.mjs:10` |

**已确认健康的部分**（逐项验证）：窗口安全配置（`nodeIntegration` 未开 / `contextIsolation` 默认 / `webSecurity` 未关 / `sandbox:false` 是 preload 用 `ipcRenderer` 的必需权衡）；CSP 配置合理（`base-uri 'none'`、`object-src 'none'`、`connect-src` 无 `*`）且有测试固化；`preload` 用 `contextBridge` 未泄漏 `ipcRenderer`；127 个 IPC 通道全部注册到位、preload 与 `ipcMain` 签名逐项一致；依赖无未声明/未使用；`better-sqlite3` 三处配置配套正确；`three`/`fiber`/`drei`/`tldraw` 版本配套无误；`scripts/` 无硬编码绝对路径，`.ps1` 全部用 `Join-Path $ProjectRoot` 且有路径逃逸校验；仓库上一级的构建产物（`out/` `current/` `previous-build-*/` 等）都在 `.git` 边界外，未污染版本库。

---

## 六、优先级汇总

### 立刻修（数据安全 / 数据正确性）

| # | 项 | 位置 | 理由 |
|---|---|---|---|
| 1 | **B1** `LIKE` 未转义 `_` | `media.repo.ts:206`、`projects.repo.ts:321`、`library.repo.ts:549,621`、`transfer.ts:46` | 17.02% 概率触发；跨项目**读取 + 克隆 + 导出**他人素材。仓库内已有正确范式（`substr(...) = ?` 共 5 处），照抄即可 |
| 2 | **B2** `handleMount` 监听器从不注销 | `CanvasEditor.tsx:1512-1632` | 切项目后旧 Editor 持续 `markDirty` + `flushSave`，把**别的项目的快照写进当前项目** |
| 3 | **S1** `waitForVideo` 轮询竞态 | `shared/engine/helpers.ts:247-268` | `await` 无 reentry 闸门 + 无 `.catch` → unhandled rejection；超时后 in-flight 回调继续 resolve。视频生成是最贵的路径 |
| 4 | **S4** `discardMaterialization` 无隔离/无事务 | `library-materialization.repo.ts:135-140` | `JSON.parse` 无保护（`cloneProject` 会把非法串写回该列）+ 循环无 `.catch` → 孤儿文件 + 永久脏 usage |
| 5 | **S3** 确认弹窗期间未复查 `phase` | `executor.ts:1290-1317` | 弹窗上再点一次「运行」→ 两个并发 workflow，stop 覆盖 → 前者无法停止、继续计费 |

### 本迭代（逻辑矛盾 / 重复分叉）

| # | 项 | 位置 |
|---|---|---|
| 6 | **M1** `executor-types.ts` 双份且 `shape` 不兼容 | `shared/` vs `renderer/src/engine/` |
| 7 | **重复5 函数 87 行** `nodeValues.ts` vs `values.ts` | 注释已自认这个模式曾导致静默丢失 |
| 8 | **M2** `ai-process` 只连 JSON 时 UI 阻断但能跑 | `node-readiness.ts:15-20` vs `aiProcess.ts:94-107` |
| 9 | **M3** `sound-adjust` 互斥规则 UI 缺失 | `soundAdjust.ts:11-13` vs `node-readiness.ts:80-90` |
| 10 | **M4** 3 处硬编码 `---` + 测试门禁覆盖不全 | `chat.ts:17`、`ChatSidePanel.tsx:304`、`audit-text-node.cjs:232` |
| 11 | **M5/M6** 日志门禁正则漏 `fetch()` + 恒假死代码 | `check-logging-bypass.mjs:36,104-105` |
| 12 | **P0-1** 打包未排除产物（253MB） | `electron-builder.yml:9-21` |
| 13 | **P0-2** `.gitignore` 漏产物目录 + 跟踪了用户数据 | `.gitignore`、`canvas-studio/data/`（54 文件） |
| 14 | **CanvasEditor 5 处 console + 零诊断接入** | `CanvasEditor.tsx:618,627,661,663,1458` |

### 后续（清理 / 技术债）

- 删 3 个零引用文件（`shared/engine/index.ts`、`legacy-adapter.ts`、`FeatureProfileSelect.tsx`）+ 修正 2 份文档的失实陈述
- 删 `qa/ux-walkthrough-2026-09-29/` 下 3 个探针 + 9 个孤儿脚本 + 11 份 `launchBrowser` 合并为 1
- `M7` contracts/inputs 类型收敛（已完成 1/5，补齐剩余 4 个）
- 其余重复实现抽出（`formatTime` / `assertMiniMaxOk` / 进度百分比 / `togglePlay`）
- 4 份过期文档加废弃声明
- `verify` 补 `test:optimization-ui` + CI 改用 `pnpm verify` + `build:desktop-latest` 参数修正 + 依赖错位修正
- `EDGE_COLORS` 简化为常量、`scripts/check-logging-bypass.mjs` 死代码删除

---

## 附：审查方法说明

- **静态检查**：`tsc --noEmit`（node + web 双配置）、`eslint . --quiet` —— 均通过
- **死代码扫描**：全量提取导出符号 → 逐个跨文件引用计数（含 `@shared/` / `@renderer/` 别名与 `.js`→`.ts` 映射）→ 函数体哈希去重
- **关键结论均已交叉验证**：`LIKE` 问题实测 nanoid 采样 50000 次（17.02% 含 `_`）；`handleMount` 的 5 个注册点 grep 确认；3 处 `---` 硬编码 grep 确认；`NETWORK_RULE` 6 种写法实测；`node-readiness` 与 `aiProcess` 逻辑分支逐行比对
- **未修改任何文件**，本次为纯只读审查