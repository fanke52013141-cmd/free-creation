# A0 + A1 最小纵向包交付台账

日期：2026-10-24。授权：用户要求先落地 A0 + A1 最小纵向包。

后续接续：[A1.1桌面项目操作](06-a1-1-desktop-projects.md)新增打开/名称更新及活动画布保存导出。本文件的9项操作和关闭项目限制是前包历史基线；最新支持与验收以接续台账为准。

本包开放本机应用连接、能力发现、项目列表/摘要、新建、按版本重命名、保存和完整项目导出，经 CLI 与 MCP stdio 共用主进程服务。旧 headless 不恢复，节点运行不在本包范围。

## 1. 当前支持表

| 能力                                                   | 实现                                               | 验收                                  |
| ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------- |
| `app.status`、`capability.list`                        | 可用；返回实例/数据库身份与操作 Schema             | CLI/MCP SDK真实协议验收               |
| `node.type.list`                                       | 31类型均有明确planned状态                          | 与Active集合一致性及缺声明阻断测试    |
| `project.list/get/create`                              | 可用；get只返回已保存摘要/数量                     | 隔离SQLite、CLI/MCP及重启回执         |
| `project.rename`                                       | 可用；必传期望图版本，写入正式快照和SQLite索引     | MCP重命名、桌面回读、旧版本拒绝       |
| `project.save`                                         | 可用；仅保存已关闭项目当前权威内容，不接收外部快照 | CLI保存、正文保持与重开               |
| `project.export`                                       | 可用；固定源版本、完整包、受控目录、不覆盖         | CLI包内容/版本检查、占用/缺失媒体拒绝 |
| 命名管道/本机socket                                    | 默认不启动；应用显式 `--local-agent-access` 开启   | 实际IPC往返、应用退出不可调用         |
| HTTP、项目包导入、节点创建/编辑/执行                   | 未开放；有限操作目录外拒绝                         | tools/list无此类工具                  |
| project.open/update/clone/delete、资源库/模型/诊断导出 | 尚未纳入最小包                                     | 后续A1包；不能将本包写成完整A1        |

“修改并保存”在本包指项目名称修改与持久确认；正文/节点/连线修改属于后续A2，不接受任意JSON快照。

## 2. 运行方式

构建后启动桌面应用时显式启用本地入口：

```powershell
# 开发源码环境：从仓库运行；生产环境在安装目录启动 canvas-studio.exe --local-agent-access
& .\node_modules\electron\dist\electron.exe . --local-agent-access
```

使用普通 Node 运行构建出的薄代理，代理不加载Electron数据库或项目仓库：

```powershell
node .\out\main\local-agent.js status
node .\out\main\local-agent.js project list
node .\out\main\local-agent.js project create --input-file .\create-project.json
node .\out\main\local-agent.js project rename --input-file .\rename-project.json
node .\out\main\local-agent.js project save --input-file .\save-project.json
node .\out\main\local-agent.js project export --input-file .\export-project.json
node .\out\main\local-agent.js key
```

Windows目录包提供 `canvas-studio-agent.cmd`，使用安装目录内Electron的Node模式运行相同代理，无需另装Node。入口位于安装目录，与 `canvas-studio.exe` 同级。不要给已运行应用传Node参数；脚本仅影响自身子进程。

本次独立验收目录包：`dist/local-agent-access-a0a1-20261024/win-unpacked/`。该目录包经过已打包应用的CLI/MCP真实闭环；没有覆盖现有正式分发目录，也未安装或发布。可在包目录运行：

```powershell
.\canvas-studio.exe --local-agent-access
.\canvas-studio-agent.cmd status
.\canvas-studio-agent.cmd capability list
```

包内入口哈希与源码构建对应、关键依赖物理位于包内的证据：`qa/local-agent-access/package-manifest.json`；已打包闭环证据：`qa/local-agent-access/installed-vertical-slice/report.json`。这两项通过不等于整个工程回归通过，整轮结论见§6。

默认读取本机 `%APPDATA%/canvas-studio/data/agent-access/connection.json`；显式隔离环境使用应用同样的 `CANVAS_DATA_DIR`，代理可传 `--data-dir <该目录>`。此文件含本地连接凭据，不应复制到项目、截图或聊天。凭据每次启动轮换，旧实例连接失效；不使用本机API Key作连接认证。

新建输入示例：

```json
{
  "input": { "name": "Agent 创建的项目" },
  "idempotencyKey": "<从 key 命令或 app.status 的 nextIdempotencyKey 获取>"
}
```

重命名输入示例：

```json
{
  "input": {
    "projectId": "<真实项目ID>",
    "expectedGraphVersion": 0,
    "name": "新项目名称"
  },
  "idempotencyKey": "<本次新意图的新key>"
}
```

保存使用相同projectId与读取到的最新expectedGraphVersion，不带name；导出另外带安全文件名 `fileName: "example.canvasbundle"`。导出目录固定为应用数据根下 `agent-exports/`，返回文件路径、字节数、SHA256、源版本及缺失媒体数。不接受任意输出目录或静默覆盖。示例占位符不能直接调用。

同一次意图的重试必须复用同key；不同参数复用key被拒绝。key格式为毫秒时间戳加UUID，有效期30天，过期拒绝，不能因清理旧回执重做副作用。`unknown` 时复用同key查询原回执或人工核对业务事实，不换key重发。

CLI退出码：0=completed；2=已知失败/输入命令失败；3=结果未知。stdout为单一JSON结果（key命令除外），固定错误摘要走stderr，不打印原始请求/异常。当前文件输入，未实现stdin与等待长任务；没有长任务受理操作。

## 3. MCP 配置

开发构建示例（替换成自己的安装/数据目录）：

```json
{
  "mcpServers": {
    "canvas-studio": {
      "command": "node",
      "args": ["D:/software/free-creation/out/main/local-agent.js", "mcp", "serve", "--stdio"]
    }
  }
}
```

生产目录可直接用Electron可执行文件作为command，args指向 `resources/app/out/main/local-agent.js` 并设置 `ELECTRON_RUN_AS_NODE=1`。不把连接token写入MCP配置。客户端支持 `.cmd` 启动时也可使用安装目录脚本。

本包锁定官方 `@modelcontextprotocol/sdk@1.32.1`；本机检查其实际协议集合为 `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07`。实际验收客户端为同版官方SDK `Client + StdioClientTransport`；初始化、工具发现和工具调用均经过真实子进程stdio。没有验证其他第三方客户端或2026版协议，不宣称这些组合兼容。旧方案中“当前官网版本”不能替代已安装SDK的实际能力。

每个工具接受 `{input, idempotencyKey?, requestId?}`；写/导出必填key，工具名将operation的点映射为下划线。`app_status`可先取nextIdempotencyKey；读取结果和下一次写入不能共用不同意图的旧key。所有入口只暴露Registry中的9项，不提供通用IPC/SQL/JS/shell工具。

## 4. A0 落地与未完成边界

机器来源为 `src/shared/agent-access/registry.ts`，CLI/MCP目录和JSON Schema均从其生成；快照位于 `generated/contracts.json`。

```powershell
npm run verify:agent-access
node scripts/check-agent-access.cjs --write --reason "具体变更的接入影响、兼容结论和证据说明"
```

Schema变化额外要求 `--accept-contract-change`，是明确承认契约变化供审查，不代表自动判定兼容。门禁比较Active声明、生成Schema和受保护文件hash；变更必须同包刷新影响记录并附人工行为证据。已接入 `verify:checks`，现有CI运行 `verify` 时会执行。

当前实现G1登记完整性、G2有限共同暴露面、G3生成一致性和G5受保护路径影响确认；没有实现完整NodeAccessSpec/configSchema/端口抽取、自动语义兼容diff、所有业务路径精准影响推断、外部节点主体到Flow租约适配。节点当前仅登记planned，不能宣称完整A0完成。

## 5. 数据、恢复和日志

- main是唯一业务调用者，CLI/MCP只读取连接描述符并发送操作，不读项目/数据库。每个数据根只允许一个桌面拥有者，隔离目录可各自运行。
- 桌面打开的项目全部拒绝外部写/导出，即使“看似已保存”；关闭后再操作。首包未实现在线flush握手，避免UI未保存数据被覆盖或导出旧版本。
- 命令/任务占用含unknown时拒绝修改。未新增节点执行宿主，不冒充内部Agent身份。
- 新增M19持久幂等回执；先登记pending再执行；崩溃后pending转unknown，不自动重放。未知回执尚无自动reconcile接口，需要核对原项目/导出事实。
- 重命名和保存使用现有项目写锁/临时写入/备份/SQLite校准；复制/删除未开放。导出持有源版本锁，临时包验证后fsync并独占发布，不覆盖既有文件。
- 桌面首页对已关闭项目的重命名也进入同一版本化事务，记录project.save生命周期；活动画布保留既有索引重命名行为，不推进其在途图版本，外部写入仍被拒绝。项目关闭后应重新读取再修改；跨活动会话的独立元数据CAS属于后续完整A1，不能把图版本保护称为全部元数据并发保护。导出使用索引中的权威名称，避免旧快照名称与桌面显示不一致。
- 共享导出对普通媒体增加真实路径边界检查，避免符号链接引用项目外文件；原UI缺失媒体计数语义保留，外部路径默认不发布不完整包。
- 日志由 `agent.access.started → completed/failed/unknown` 记录本次公共服务操作；验证拒绝单独rejected。重复幂等读取不再产生第二业务终态；仓库未自行重复该终态。服务就绪/失败另记启动事件。
- 事件只记录固定operation/phase/code和安全trace/request/span；不含项目名称、正文、key、token、签名URL或文件路径。业务响应和项目包可以包含用户明确请求的项目内容，不能进入诊断。
- logger拒写不改变业务结果；幂等账本拒写不能启动副作用。目录/文件/SQLite不保证跨存储断电原子性；未知窗口保持unknown，不伪造成功。

## 6. 验证记录

最终完整 `npm run verify` 已通过，退出码0：`qa/verification/run-4kUMWv/status.json`，开始2026-10-24 06:58:31 UTC、结束07:24:50 UTC。单元2484通过、5项既有跳过（203文件：201通过、2跳过），模型另2项通过；lint、Node/Web/模型类型检查、日志/接入门禁、浏览器门禁、生产构建、本地接入真实闭环及全部桌面专项通过，包括多参考视频和最后的R09保存恢复。

接入专项包含错误凭据/过期实例拒绝、受理/最终回执拒写、过期/冲突key、断线/重启幂等、Schema/影响门禁拒绝、恢复副本/桌面占用、结构化悬挂媒体引用拒绝。源码真实Electron+CLI+SDK MCP子进程闭环证据：`qa/verification/run-4kUMWv/qa/local-agent-access/vertical-slice/report.json`、`desktop-readback.png`及实际诊断JSONL。当前构建的独立Windows目录包同样通过真实CLI/MCP/桌面回读与重启回执；证据：`qa/local-agent-access/installed-vertical-slice/report.json`、`package-manifest.json`，入口哈希与当前构建一致、关键依赖均在包内。目录包未安装、发布或替换既有正式分发目录。

初次沙箱测试遇原子rename EPERM；修正测试前置外键及JSON输出/日志终态后，在正常权限、隔离临时目录复验通过。未使用真实项目、密钥、供应商或收费模型。退出时关闭所有测试窗口并删除隔离数据，证据只保留安全日志和截图。

以上结论针对本包的实现和明确验收环境，不将5项既有跳过写成通过，也不扩大为全部A0/A1或未开放节点能力已验收。

首轮完整验证 `qa/verification/run-RhUxdh/status.json` 退出1：旧v16并发迁移夹具未移除本次M19表，导致重复建表；夹具已同步，定向并发迁移复验通过。第二轮 `run-cdJlAq` 单元2477通过/5既有跳过，模型2通过、日志/接入门禁通过，停止于既有键盘浮层Escape缺陷。已确认并修正为嵌套下拉框消费Escape时不关闭外层说明面板；原键盘断言保留，新增外层独立Escape关闭验证通过。最初对夹具身份的猜测已撤回，未保留弱化断言或绕过键盘测试的改动。

追加：桌面/外部重命名与项目保存IPC定向37/37通过；导出索引夹具补齐后的接入/重命名/原导出定向26/26通过。第三轮完整验证 `qa/verification/run-GpHK68/` 退出1：单元2480通过/5既有跳过，模型、浏览器、构建、本地接入闭环和此前桌面专项均通过，视频多参考专项因 `FLOW_PROJECT_INACTIVE` 停止，最后的R09未运行。其诊断显示失败前canvas-detach、随后canvas-attach，时间接近共享源码修改；推测开发服务器热更新使画布重挂载，未证明根因。视频多参考随后独立复验及第四轮完整验证均通过，未修改或弱化该专项断言；第四轮保持源码冻结。

安全补充：项目有待处理恢复副本时拒绝外部写/导出；文件监听启动失败或运行中失败时仍保留桌面占用，只有显式关闭/切换项目才释放；旧监听器的迟到错误不能关闭新监听器。接入/重命名/原导出/迁移定向34项通过，监听保护/接入定向20项通过，最新Node类型检查与lint通过。

## 7. 日志影响检查（按模板填写）

- 影响：新增外部操作路径与M19幂等账本；复用项目仓库、导出、跨进程写锁和现有诊断入口。
- 附带UI修复：详情面板只处理未被嵌套下拉框消费的Escape，不改变配置、节点执行、文件或保存路径，执行日志影响为不涉及。已读节点UI规范§19；使用原键盘门禁与新增父层Escape验证，不新增业务日志。
- 文件监听失败新增失败专用 `project.watch.failed`，只记录projectId、trace/span及固定watch阶段与WATCH_UNAVAILABLE码；不记录异常、路径或快照，不重复项目保存终态。监听器故障保留占用、迟到错误隔离及诊断脱敏均有定向验证。
- 生命周期拥有者：main/agent-access公共服务；CLI/MCP不重复业务终态；传输认证失败只断开，不记录客户端原始数据。
- 关联：服务端trace/span、调用requestId、允许的固定operation/phase/code。项目名、正文、幂等key、HMAC、token、路径和原始异常不进诊断；业务回执可包含本次请求的项目名和受控导出路径。
- 成功：业务提交与回执均完成；未知存储/回执窗口返回unknown，pending重启不重放。文件与SQLite断电原子性未宣称。
- 失败：validate/connect/admission/desktop-ownership/task-occupancy/storage/export/receipt分阶段；已有仓库负责实际事务，外部包装不把日志当权威。
- 取消/超时/重试：本包同步操作没有业务cancel/resume；客户端15秒连接等待超时不触发重试，发出后无回执返回unknown。相同key仅返回原事实。
- 脱敏证据：假密钥从实际包剥离；正文可在项目包中回读但不进入事件；项目名/私有路径不进入实际JSONL；logger抛错不影响创建；业务账本拒写阻止副作用或保留unknown。
- 未覆盖：外部节点、模型请求、在线flush、自动reconcile、HTTP、第三方MCP客户端、跨账户ACL以及物理断电/设备组合；这些未开放能力不构成本包支持声明。

## 8. 接入变更影响检查（按模板填写）

- 范围与用户路径：本机桌面显式开启入口后，外部客户端发现能力、新建关闭项目、读取版本、重命名、保存并导出，随后桌面打开核对。9项操作均为operationVersion=1；31种节点仅声明planned，不开放节点写入/执行。
- 公共入口：CLI和MCP共用Registry及main公共服务；项目事务、写锁、保存恢复和导出继续由原仓库负责。UI关闭项目重命名与外部重命名共用版本化仓库事务；适配器没有第二套执行器或直接数据库通路。
- 兼容基线：这是旧接口移除后的新协议首版，不承诺兼容旧CLI/MCP/headless。现有项目沿M19迁移，原正文、节点、端口及媒体格式不改变；原UI导出可告警缺失媒体，外部完整导出会拒绝缺失。Schema变化须明确兼容结论并更新生成快照。
- 副作用边界：实例和数据根身份校验；关闭项目、期望图版本、无任务占用且无恢复副本才允许变更/导出。新建/重命名/保存/导出均要求意图绑定的持久幂等键。未开放删除等破坏性动作，不引入其确认协议；未开放异步任务，不返回accepted冒充完成。
- 失败与恢复：保存继续复用现有事务与恢复能力；受理后无法确认的结果返回unknown，客户端不自动重发。API回执不会替代任务账本或项目事实；断电和自动核对尚未验收。
- 日志与证据：见§6、§7及日志覆盖清单；登记完整性、过期生成文件/影响记录拒绝、版本冲突、占用、幂等冲突、重启回执、完整包和脱敏均有针对性验证。完整工程验证和目录包结论分别记录，不用其一代替另一项。
- 例外与后续：完整NodeAccessSpec/语义兼容自动判定属于后续A0；打开/元数据修改/复制/删除属于后续A1；画布和节点操作属于A2。每包继续按真实支持及验收更新清单，未适配节点保持planned。
