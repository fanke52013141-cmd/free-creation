# 第七轮交付汇总：F9 剩余收敛 + F5/F4 路由 + 安装诊断事件

日期：2026-11-08。承接 [47 号汇总](47-batch-6-delivery.md)。用户指定顺序：**F9 剩余 → F5/F4 剩余 →
安装后台诊断事件**。三项均已完成并提交。用户此前边界继续生效：语音克隆/音色设计/视频生成只做
代码层接通（真实测试由用户自测）；F10 客户端/安装包暂不启动。

## 一、数字

| 指标 | 上轮末 | 本轮末 |
| --- | --- | --- |
| 外部操作 | 113 | **117** |
| external 映射业务动作 | 116 | **139** |
| F4/F5 计划项 | 26 | **2**（均需 CUDA 且未实测，刻意不开放） |
| F9 计划项 | 30 | **26**（全部写明不可开放原因） |
| 新增测试 | — | 25 项（F9 剩余 13 + 路由 7 + 安装诊断 5） |

本轮提交：
`d996d97`（F9 剩余收敛 + 补提交遗漏挂载）、`1757ac1`（F5/F4 路由）、`38071d8`（安装诊断事件）。

## 二、F9 剩余收敛（`d996d97`）

开放 4 项，其余 26 项逐组写明为何不可开放（台账 48）：

- `workspace.palettePreferences.get/save`：调色板分类顺序与名称覆盖；与 GUI 同一归一化，
  未知分类由严格 Schema 拒绝，重复保存 `changed=false`；
- `diagnostics.exportBundle`：诊断包导出到**受控导出目录**，范围必填（不允许导"全部事件"），
  回执给文件名/sha256/字节数/事件数，**不返回绝对路径**；
- `model.definition.deleteMany`：与 GUI 多选删除同一 `deleteModels`，不存在 ID 计入 `notFound`
  而不让整批失败。

**顺带修一个会炸干净检出的问题**：上一轮 F9（四）提交漏掉了 `registry.ts` 里
`MODEL_ADMIN_*` 的挂载——工作区能跑但没入库，干净克隆会编译失败。本次补提交。

不开放的 26 项：keys.* 12（凭据包属高阶密钥迁移协议、provider 测试会真实请求）、
Dreamina 登录 2（必须真人，需协作者身份协议）、models.discover/validate 3（会向供应商发请求，
validate 可能计费）、license.* 8（安全红线：不得绕过或代签授权）、diagnostics.exportNodeRun 1
（依赖 renderer 内存运行记录，需先把运行历史持久化成契约）。

## 三、F5/F4 路由（`1757ac1`）

不新增操作，只把"GUI 入口就是某类节点执行"的动作映射到既有外部路径：
- 本地确定性 6 项 → `node.execute`+`output.get`（**真实桌面里程碑已逐动作验收**）
- 付费生成 7 项 → `node.execute`+`run.*`+`output.get`（**仅接线级，从未实测**，note 逐条写死）
- 任务控制 4 项 → `run.get`/`run.wait`/`run.cancel`（取消请求与确认分离）
- 环境/导入 2 项 → `environment.local` / `media.import`
- 纯预览/维护 5 项 → 排除并写理由（缩略图/波形不产生正式产物；元数据探测导入时已完成）
- **video-depth / video-clay 刻意留在 F5**：需本机 CUDA 且从未实测，环境未就绪时 execute 只会
  如实失败，不标成已开放

新增 `test/media-family-routing.test.ts`（7 项）**专门抓不诚实映射**：nodeType 必须是 Active、
可创建、有契约快照；映射到 execute 的类型必须"要么执行已验收，要么明确声明未实测"；
付费族 note 必须含未实测字样。**该测试实际抓出 3 个问题**（depth/clay 误标、付费 note 缺声明、
历史 excluded 用 reason 字段），全部已修。

## 四、安装后台诊断事件（`38071d8`）

补齐 45 号台账登记过的盲区：`installVideoEngine()` 后台阶段此前只有内存状态、诊断里没有任何
安装生命周期。新增 5 个事件（started/phase/completed/failed/skipped，owner =
`main/media/video-conversion.ts`），记录阶段名、稳定错误码、GPU 是否可用与耗时；
**不含本机路径、pip 输出、下载 URL**。只加观测不改安装行为；已就绪记 `skipped`、
已在安装记 `skipped`，绝不写第二个 `started`。

测试 5 项，**mock 掉 `child_process.spawn` 确保绝不触发真实安装与 3.3GB 下载**（本机装有 Python 3.12，
不 mock 就会真的装起来——这是本轮踩到的真实风险）。同时覆盖"诊断 sink 同步抛错/异步拒绝都不影响
安装流程"。

## 五、真实门禁

- `npm run typecheck` → 0 错误
- `npm run verify:logging` → 通过（新增网络路径均已接入诊断）
- `node scripts/audit-business-actions.cjs` → 171 IPC + 42 画布动作；**external ops 117**
- `npm run verify:agent-access` → **117 operations；32 planned nodes**
- 本轮相关套件 → 32 项通过；全仓结果见提交说明

## 六、仍未完成（诚实清单）

1. **video-depth / video-clay**：需 `environment.videoEngine.install` 装好 CUDA 环境后专项验收；
2. **付费生成真实路径**（生图/P图/视频/语音/音色）：需预算授权，且**语音克隆/音色设计/视频生成
   由用户自测**；
3. **F9 剩余 26 项**：见第 2 节，多数需要网络授权、凭据协议或安全红线外的人工步骤；
4. **真实联网安装**：成功路径/失败恢复/耗时未验收（需 CUDA 环境 + 数 GB 下载）；
5. **F10**：干净克隆构建、安装包、真实 MCP 客户端——按用户要求暂不启动。

## 七、用户环境问题（本轮同时处理，非代码交付）

用户的"打不开项目"已定位并解决：当前构建的数据目录（`AppData\Roaming\canvas-studio\data`）
是空的，旧项目在 `canvas-studio-nodepointer`；且当前构建强制授权门禁而机器上从未有授权凭证。
已按用户授权完成数据迁移（原数据保留 + 备份）与开发机协作激活，验证可正常打开画布。
复用脚本留在 `source/qa/`：`migrate-userdata.cjs`、`activate-dev-license.cjs`、`verify-activation.cjs`。
