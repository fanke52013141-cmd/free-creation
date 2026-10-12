# C2.1 首包：文本/JSON 资产版本

日期：2026-10-12。本包进入 C2，交付资产版本及普通端口消费；**C2.2 生产 Agent 命令桥尚未接入**。不能把手动处理固定资产的验收称为手动/Agent 执行对等。

## 画布操作路径

打开文本、JSON 或处理节点详情 → 输入输出 → 资产版本 → 提交当前输出为新版本。先等待保存协调器完成所有在途/合并保存，再确认磁盘节点与当前节点一致；保存失败、暂停、冲突或节点有新修改时不提交。处理节点必须有可用正式输出，失败运行的旧结果不提交。

在同一区域查看最近 100 个版本及完整内容，选择版本后点击“将此版本放到画布”。创建已有文本/JSON 类型的节点，通过普通输出端口连接下游。复用 pinnedOutput 协议，卡片与端口均显示固定版本；修改源节点、随后运行、重开快照都不改变固定输出。固定卡片提供“创建可编辑副本”，产生普通文本/JSON 草稿节点，保留原版不变；副本沿公共编辑规则修改，新版本须明确提交。创建位置避让已有卡片，副本创建后居中可见。

画布放置是可撤销编辑，沿原有自动保存链路保存；“放到画布”不代表文件事务完成。用户可显式重复放置一个版本创建多个引用节点，不当作命令自动重放。

## 数据与提交协议

- 生产 SQLite 迁移 v11：flow_asset_versions 保存不可变正文、digest、来源节点/端口、图版本、序号和时间；flow_asset_submissions 保存提交签名及版本回执。同一来源节点/端口有稳定 assetId，每次提交产生独立 versionId。
- main 从已保存 tldrawSnapshot 节点按正式端口投影取值，IPC 不接受正文或结果。文本/JSON/处理投影抽到 shared，仍由原 NodeTypeSpec 注册，没有第二套业务执行器。支持 text/markdown/JSON，单版本 UTF-8 上限 1 MiB；媒体及其他节点提交暂不支持。
- 新提交须匹配 expectedGraphVersion。相同 submissionId/意图返回原版本，即使图后来改变；修改来源/端口/预期版本则拒绝冲突。版本和回执同一事务提交，回执失败不留半个版本。无图改动也可显式再提交新版本。
- UI 丢失回执时，在当前面板保留同一个请求，再点击核对原提交。重开面板可查看历史，未确认请求的跨进程恢复归 C4。
- 读取校验 digest；resolveInputs 按顺序验证完整 assetId/versionId/sourceNodeId/sourcePortId，拒绝跨项目和伪造引用，最多 128 项。目前没有 Agent 调度消费该接口。
- 固定节点保存版本引用和 pinnedOutput 内容快照。SQLite 是版本历史权威来源，画布快照是固定版本可独立读取的投影；源节点编辑不回写历史，无 API 更新已提交版本。
- IPC 只接受受控桌面窗口主 frame。项目删除级联清理版本/回执；源节点删除保留同项目历史。不引入登录或团队权限。

## 日志自查

影响：新增数据库提交/读取与画布物化，复用项目保存和公共节点执行日志。main 记录 asset.operation.started → completed/failed，关联 trace/span/project/node、操作 phase、submissionId；提交完成附 assetId/versionId。日志失败不改变业务结果。提交成功才表示版本/回执落库，读取成功不等同提交。

画布放置记录 asset.placement.started → applied/failed；applied 仅表示画布编辑，不冒充项目保存成功。相机/拖动不逐帧记录。白名单仅含标识、阶段、稳定原因和耗时；正文、JSON、标题、原始异常与密钥不入诊断。

独立 Electron 测试用真实生产 preload/IPC、project.json 与 SQLite，第二个进程读 v1 并重放回执，检查诊断文件无测试正文/假密钥。保存合并/冲突/失败、诊断唯一终态及 transport 故障有测试。未宣称全部节点/模型/恢复链路已覆盖。

## 验证与边界

定向测试：agent-flow-assets.test.ts（13 项）、agent-flow-asset-canvas.test.ts（6 项）及迁移测试。真实 SQLite 覆盖冻结、去重、冲突、坏 JSON、失败旧输出、体积上限、回执失败回滚、完整引用、digest、端口类型与删除级联。

浏览器 UI fixture 验证 v1/v2 提交、丢回执核对、选 v1 放到画布、预览与端口一致、正文单击/拖动、文本/JSON 可编辑副本、真实端口连接、普通 runNodeManually 消费 v1 与快照恢复。生产存储另由隐藏 Electron 双进程验收，二者边界分别记录，不用浏览器 mock 证明落库。

复跑：构建后 `npm run test:agent-flow-assets`；浏览器与构建后的 Electron 验收均纳入 `npm run verify`。当前 native SQLite 为 Electron ABI 140，门禁沿用匹配的 Electron-as-Node。证据在忽略目录 qa/canvas-agent-flow/C2：electron-assets-results.json、diagnostics、browser-assets-results.json、fixed-asset-canvas.png、final-verify.log；全量结果以开发台账为准。没有新增付费模型调用。

剩余：媒体/更多输出投影、固定输入目标端口清单、语义修订、命令占用/回执/未知核对、手动/Agent 对等、真实审核 gate 与自动返工。版本历史及引用的复制/导入导出、模板重映射及恢复归 C4。固定内容快照可随画布保存，但版本历史尚不随项目导出完整迁移。

唯一下一步：C2.2 确定性 node.execute；main 授权/保存 pending，renderer 复用公共执行器消费固定输入，保存正式输出及版本后确认回执，验证冲突/去重/未知不重放。
