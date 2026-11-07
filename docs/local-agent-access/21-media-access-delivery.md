# F4 交付：媒体登记接入、节点素材引用与图片族桌面验收

日期：2026-11-08。基线：里程碑（`b914917`）。第二批（桌面验收）与第一批同包交付。

## 1. 实际完成的业务动作（GUI / CLI / MCP 状态）

| 业务动作 | GUI | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 本机文件登记为项目受控媒体 | ✅ 素材导入 | ✅ media.import | ✅ media_import | 复用 `importMedia` 公共服务（同一目录/索引/文本抽取规则），受控 mediaId，字节不过线 |
| 删除项目媒体 | ✅ 素材面板 | ✅ media.delete | ✅ media_delete | 与 GUI 面板同一 `deleteMedia` 服务；外部校验项目归属，回执含引用计数（信息性，与 GUI 规则一致） |
| 项目媒体清单 | ✅ 素材面板 | ✅ media.list | ✅ media_list | `listMedia` 项目作用域分页摘要，不含绝对路径 |
| 节点携带素材创建/替换 | ✅ 拖放/设置 | ✅ graph.patch media 引用 | ✅ 同上 | main 预检解析归属（MEDIA_NOT_FOUND 拒绝未登记/跨项目引用），解析事实经桌面载荷注入宿主，外部输入永远只有 mediaId |

## 2. 公共契约与一致性处理

- graph.patch 的 node.create/node.update 新增 `media: {mediaId}`；**外部输入不可携带路径**——main 在预检中校验媒体行存在且属于同一项目（`projects/{id}/media/` 前缀），把 `{mediaId, mediaPath, mediaMime, name}` 作为 `mediaResolutions` 注入桌面载荷；权威宿主据此写节点 props。素材节点的默认标题与 GUI 拖放一致（素材名优先）。
- 导入排除门禁从"名称含 import 一票否决"改为**显式包传输黑名单**（project.import/importStructure、library.import、凭据包等 F7 未验收项继续阻断）——落实一致性计划 F1 的"按明确能力范围/阶段判定"；media.import 是普通素材登记，不受包导入排除约束。包传输类导入在 F7 独立验收前仍然不可调用。
- Registry 共 35 项操作；audit 分母 33 项 external。

## 3. 验证证据（本工作区实测）

| 检查 | 结果 |
| --- | --- |
| `test/local-agent-media-access.test.ts`（导入/去敏/缺项目拒绝/坏文件拒绝/归属预检/路径不进外部输入/跨项目引用拒绝/删除归属与引用计数） | 4 项通过 |
| 全部接入测试（access/graph/run/planner/media/compliance） | 70 项通过 |
| `npm run typecheck`、ESLint（本包文件） | 通过 |
| `npm run verify:agent-access` | 通过：35 操作 |
| `node scripts/audit-business-actions.cjs` | 通过：206 动作、32 项 external |
| **真实桌面（里程碑脚本 F4 段）**：media.import 真实 PNG → graph.patch 素材引用建 image/image-crop 节点并连线 → node.execute 本地裁剪 → run.wait completed → output.get 读到**新产物**（mediaId 与源不同）→ 产物文件真实落盘且媒体索引可查 | 通过（11 项检查全绿，见 `qa/local-agent-access/milestone-a-b-c/report.json`） |

## 4. 过程中发现并修复的真实缺陷

1. **media.import 被活动项目 flush 握手误拦截**：画布无关写入被要求 expectedGraphVersion 核对而必然 REVISION_CONFLICT。已改为显式 flush-handshake 白名单（project.save/rename/update/clone/export/chat.skill.bind），画布无关写入直接走存储服务。
2. **output.get 对媒体产物响应校验失败**：outputValueDto 的 kind 枚举缺 NodeValue 媒体种类（image/video/audio）→ STORAGE_UNAVAILABLE。已补枚举（加法扩展）。
3. **导入排除门禁按名称子串误伤 media.import**：按一致性计划 F1 改为显式包传输黑名单（project.import/importStructure、library.import、凭据包等 F7 未验收项继续阻断）。
4. image-crop/image-split 纳入共享确定性投影（裁剪=最近成功产物；拆分=当前选中格/首格，与 GUI 语义一致）。

## 5. 日志覆盖

复用 `agent.access.*` 生命周期与 `media.read_failed` 既有域事件；media.import 失败 detail 仅含 ≤120 字符稳定原因摘要，不记录源路径、文件名与正文（测试断言绝对路径不进响应与日志）。

## 6. 尚未支持 / 仅模拟验证

1. **生图（image-gen）与 P图（image-edit）**：经 node.execute 契约可提交，但真实供应商验收未做（无预算授权）；本地与模拟验证通过，不能宣称供应商全量通过。
2. **裁剪/拆分的逐动作深验收**（坐标越界、quad 模式、部分失败清理、取消清理）未逐项桌面实测——本地执行路径与 GUI 同一 executor/媒体服务，已在里程碑中通过矩形裁剪主路径；其余组合列入 F4 收尾。
3. media.delete/替换/批量导出（F4/F7 计划项）；拆分节点 out-images 列表端口的投影（当前仅 out-image 选中格）。
4. 媒体预览/缩略图/波形等呈现类 IPC 不开放（excluded，见 action-coverage.json）。

## 7. 下一工作包

F4 收尾：裁剪 quad/越界/取消清理与拆分部分失败桌面验收；media.delete/替换；随后进入 F5 视频音频与时间线。
