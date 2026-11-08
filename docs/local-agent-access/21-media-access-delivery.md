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

## 6. 深验收补充（第四批，真实桌面）

里程碑脚本新增 6.6 段，16 项检查全绿（qa/local-agent-access/milestone-a-b-c/report.json）：

1. **quad 四点透视裁剪**：合法点集执行成功，正式产物落盘。
2. **坐标越界钳制**：越界 rect 在执行期由与 GUI 同一 parseImageCropConfig 钳制（配置保存原值与 GUI 一致），运行成功并产出有效裁剪。
3. **拆分成功**：2×2 拆分恰好 4 个新资产入库，out-image 投影选中格。
4. **拆分失败回滚**：坏图运行 failed，媒体数量不变（主进程回滚已写资产，无孤儿）。
5. **取消契约**：终态任务取消为诚实无操作（cancelRequested=false）；未知任务 NOT_FOUND。

## 7. 尚未支持 / 仅模拟验证

1. **生图（image-gen）与 P图（image-edit）**：经 node.execute 契约可提交，但真实供应商验收未做（无预算授权）；本地与模拟验证通过，不能宣称供应商全量通过。
2. **本地媒体取消的“迟到产物删除”时序**（runCancellableMedia 对已完成渲染的删除路径）未在快操作上复现——随 F5 长任务（视频转换）验收。
3. media.delete/替换/批量导出（F4/F7 计划项）；拆分节点 out-images 列表端口的投影（当前仅 out-image 选中格）。
4. 媒体预览/缩略图/波形等呈现类 IPC 不开放（excluded，见 action-coverage.json）。

## 8. 下一工作包

F5：视频/音频/时间线接入——video-asset 导入、video-frame/video-clip/sound-adjust 本地执行（ffmpeg 已在本机 PATH 验证可用）、timeline 轨道/片段编辑（graph.patch 配置通道）与合成、任务恢复。

---

# F5 第一批交付：本地视频/音频节点执行桌面验收

日期：2026-11-08。基线：F4（`deed9cf`）。

## 1. 实际完成的业务动作（GUI / CLI / MCP 状态）

| 业务动作 | GUI | CLI | MCP | 公共实现 |
| --- | --- | --- | --- | --- |
| 视频素材导入与节点引用 | ✅ | ✅ media.import + graph.patch media | ✅ 同左 | 与图片同一媒体登记服务 |
| 抽帧（指定时刻） | ✅ video-frame 节点执行 | ✅ node.execute(single) | ✅ 同左 | 同一 executor + ffmpeg；2000ms 帧产物 PNG 落盘并索引 |
| 视频截取（画面+音频双产物） | ✅ video-clip 节点执行 | ✅ 同左 | ✅ 同左 | 3s–6s 区间，产物时长与区间一致（ffprobe 实测 3s）；画面/音频分端口投影（runId 圈定，R-06） |
| 声音调整（倍速） | ✅ sound-adjust 节点执行 | ✅ 同左 | ✅ 同左 | 2× 倍速产物时长 5.006s（源 10s），与 GUI 同一 ffmpeg 管线 |

共享确定性投影新增 video-frame/video-clip/sound-adjust/video-depth/video-clay（与 GUI specs 同语义）；output.get 的 UNSUPPORTED_CONTRACT 边界相应收窄。

## 2. 验证证据

- 里程碑脚本 19 项检查全部通过（qa/local-agent-access/milestone-a-b-c/report.json），含 F5 三段（frame/clip/adjust）。
- 产物时长用 ffprobe 独立核验（clip=3s、adjust≈5s），不依赖自报回执。
- verify:agent-access 通过（35 操作）；typecheck 通过。

## 3. 过程发现

- video-clip 的 keepVideo/keepAudio 开关仅在 version=3 配置下生效（v2 历史语义不同）——外部契约必须携带 version 字段，已按 GUI 解析规则对齐。

## 4. 尚未支持 / 仅模拟验证

1. video（付费生视频）、speech/tts/voice-design（付费语音）未做真实供应商验收。
2. video-depth/video-clay 需要本地 Python/GPU 依赖，本机未验收（依赖探测 F9）。
3. timeline 轨道/片段编辑接入（graph.patch 配置通道）与合成渲染在 F5 第二批。
4. 取消清理（迟到产物删除）随长任务验收。

## 6. F5 第二批交付：时间线编辑与合成（真实桌面）

- **轨道/片段结构编辑**：graph.patch node.update(text) 承载 timeline JSON（轨道增删/静音、片段 durationMs/inMs），与 GUI 同一 normalizeTimeline 解析；多轮编辑读回核对一致。
- **合成渲染**：node.execute 时间线节点 → out-video 成片为独立资产（不写回节点 mediaId，node-invariants 核对）；ffprobe 实测成片 4.02s 与片段区间一致；自定义渲染配置 1280×720 生效。
- 里程碑脚本 20 项检查全部通过；audit 分母 35 项 external（canvas.timeline.edit/render 移入）。

## 7. 下一工作包

F5 余项：audio 素材节点链路、speech/tts 付费供应商验收（待预算授权）；随后 F6 对话/Skill/3D。
