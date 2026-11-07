# F4 第一批交付：媒体登记接入与节点素材引用

日期：2026-11-08。基线：里程碑（`b914917`）。

## 1. 实际完成的业务动作（GUI / CLI / MCP 状态）

| 业务动作 | GUI | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 本机文件登记为项目受控媒体 | ✅ 素材导入 | ✅ media.import | ✅ media_import | 复用 `importMedia` 公共服务（同一目录/索引/文本抽取规则），受控 mediaId，字节不过线 |
| 项目媒体清单 | ✅ 素材面板 | ✅ media.list | ✅ media_list | `listMedia` 项目作用域分页摘要，不含绝对路径 |
| 节点携带素材创建/替换 | ✅ 拖放/设置 | ✅ graph.patch media 引用 | ✅ 同上 | main 预检解析归属（MEDIA_NOT_FOUND 拒绝未登记/跨项目引用），解析事实经桌面载荷注入宿主，外部输入永远只有 mediaId |

## 2. 公共契约与一致性处理

- graph.patch 的 node.create/node.update 新增 `media: {mediaId}`；**外部输入不可携带路径**——main 在预检中校验媒体行存在且属于同一项目（`projects/{id}/media/` 前缀），把 `{mediaId, mediaPath, mediaMime, name}` 作为 `mediaResolutions` 注入桌面载荷；权威宿主据此写节点 props。素材节点的默认标题与 GUI 拖放一致（素材名优先）。
- 导入排除门禁从"名称含 import 一票否决"改为**显式包传输黑名单**（project.import/importStructure、library.import、凭据包等 F7 未验收项继续阻断）——落实一致性计划 F1 的"按明确能力范围/阶段判定"；media.import 是普通素材登记，不受包导入排除约束。包传输类导入在 F7 独立验收前仍然不可调用。
- Registry 共 34 项操作；audit 分母 32 项 external。

## 3. 验证证据（本工作区实测）

| 检查 | 结果 |
| --- | --- |
| `test/local-agent-media-access.test.ts`（导入/去敏/缺项目拒绝/坏文件拒绝/归属预检/路径不进外部输入/跨项目引用拒绝） | 3 项通过 |
| 全部接入测试（access/graph/run/planner/media） | 65 项通过 |
| `npm run typecheck`、ESLint（本包文件） | 通过 |
| `npm run verify:agent-access` | 通过：34 操作 |
| `node scripts/audit-business-actions.cjs` | 通过：206 动作、32 项 external |

## 4. 日志覆盖

复用 `agent.access.*` 生命周期与 `media.read_failed` 既有域事件；media.import 失败 detail 仅含 ≤120 字符稳定原因摘要，不记录源路径、文件名与正文（测试断言绝对路径不进响应与日志）。

## 5. 尚未支持 / 仅模拟验证

1. **F4 余项（下一批）**：image-gen/image-edit/image-crop/image-split 的逐类执行验收（crop/split 为本地确定性执行，经 node.execute 已可运行，但坐标单位/越界/部分失败/取消的逐动作桌面验收未做）；生图/P图的付费供应商验收未做（无预算授权）。
2. 真实 Electron 桌面的 media.import→节点引用链路目前为服务级 mock 宿主验收；桌面实测并入 F4 第二批。
3. 媒体删除/替换/导出（media.delete/batch-export）仍为 F4/F7 计划项。

## 6. 下一工作包

F4 第二批：image 族逐动作桌面验收（导入→引用→本地裁剪/拆分执行→结果选择→output.get）扩展里程碑脚本；生图/P图契约与参数 Schema（真实供应商按预算授权另列）；media.delete/替换。
