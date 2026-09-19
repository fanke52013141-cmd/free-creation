# 节点深度审查报告（2026-09-11）

> 状态：第一轮已完成（23 个 Active 节点空态结构 + 视频节点深度审查）；视频 P0 协议/交互修复已完成并留有二次浏览器证据。2026-09-11 修复后重跑 23 节点空态截图，全部节点正文均无横向或纵向溢出。
>
> 本报告不是“所有节点已验收”的声明。浏览器演示页的布局/交互证据已经采集，但远程模型的真实生成、任务轮询和结果落盘必须在桌面 Electron + 已配置供应商环境中单独通过。

## 0. 追加收口：生成节点正文与固定配置分离

2026-09-11 在 P0/P1 修复后发现，图片生成和视频生成仍把用户提示词混入
`props.config`。这会让固定参数与用户正文有两个来源，违反节点契约的持久化边界，也会使
Agent、画布手动运行和保存重开难以使用同一解释方式。

- 图片生成：正文改为只读写 `props.text`；`config` 仅包含模型、画幅、尺寸和可选 seed。
- 视频生成：正文改为只读写 `props.text`；`config` 仅包含模型、模式和参数。删除
  `video.generate.configSchema.prompt`，并将视频节点 `contractVersion` 从 5 升至 6。
- 执行器：图片、视频请求只从 `props.text` 加上已声明的 `in-text` / `in-prompt` 输入构造
  prompt，绝不读取 JSON config 的遗留 prompt。
- 回归：执行器测试断言实际网关 payload 使用正文提示词；契约快照、版本迁移、Agent
  合约生成和类型检查均覆盖此次版本变更。

这不是“兼容迁移”：本地新项目没有历史项目，旧 config prompt 不再作为可执行正文读取。

## 1. 审查目标与结论

本轮把“能看到控件”与“能力真的可用”拆开验证，重点检查：

1. 节点 UI 是否在空态、已配置、已连接、错误和结果态保持可读且不溢出；
2. 用户操作是否改变了正确的 `props.config` / `meta.nodeRun` / `meta.nodeResult`，而不是只改变 React 局部状态；
3. 连线是否通过真实端口、类型、Schema、基数和稳定顺序建立；
4. 点击运行后是否调用对应 executor、provider/本地转换器，是否产生可连接输出；
5. 模型特性是否真正约束模式和参数，而不是展示一组“看起来能选”的通用控件。

当前最重要的判断：

- 节点注册、端口矩阵和大部分本地执行器已有基础；已有静态契约测试不能代替逐节点运行验收。
- 视频节点曾是当前最高风险样板。用户提出“连图片后不能再用文生视频、默认多参”已在 UI 与执行器共用的模式解析器中落实；本轮浏览器证据只证明本地 UI/连线/提交前约束，不代替真实供应商验收。
- 浏览器演示供应商已拆为 `specId: minimax`、`specId: seedance`，`MiniMax-H3` 不再错误落入 relay fallback。
- 23 个节点中，视频节点空态截图出现横向溢出；其余节点本轮空态截图未发现横/纵向 body 溢出，但这不代表其操作和真实输出已经通过。

## 2. 审查方法（以后每个节点都按同一流程）

### 2.1 事实源顺序

每个节点先建立一份“能力卡”，禁止从按钮文案或节点标题猜测：

1. `src/capabilities/definitions.ts`：Active capability、输入/输出端口、Schema、必填性、基数、configSchema；
2. `src/renderer/src/nodes/specs/index.tsx` 与 Body：实际呈现控件、保存字段、输入预览和状态；
3. `src/shared/engine/executors/*`：运行时读取的端口和输出投影；
4. `src/main/gateway/*` 或本地媒体服务：真实请求字段、任务轮询、结果入库；
5. 测试与浏览器/桌面运行证据：只把可复现的结果标为通过。

### 2.2 每节点状态矩阵

每个节点至少要截图并记录以下状态：

| 状态           | 必查内容                                                                    |
| -------------- | --------------------------------------------------------------------------- |
| 空态           | 标题、色条、端口、正文、主按钮、缺省值、body 是否溢出                       |
| hover/focus    | 下拉、按钮、端口、Tooltip 是否遮挡，键盘焦点是否可见                        |
| 已配置         | 配置是否写入 `props.config`，刷新后是否恢复                                 |
| 单输入/多输入  | 来源名称、端口名、顺序、缩略图/文本摘要、角色是否正确                       |
| 非法输入       | 类型、Schema、基数、模型能力冲突是否在放下/运行前阻断                       |
| running        | 禁止重复提交，保留旧结果，进度与取消入口清晰                                |
| success        | `meta.nodeRun`、`meta.nodeResult`、`projectOutputs`、媒体资产和下游预览一致 |
| failed/blocked | 错误可操作、旧成功结果不被伪装覆盖、重试路径有效                            |
| reload         | 保存、关闭、重开后边、输入顺序、结果来源和状态仍一致                        |

### 2.3 连线验收

每条关系都要同时验证四层：

```text
source.outPort
  -> persisted edge(fromPortId, toPortId)
  -> target resolved input (type/schema/cardinality/order)
  -> executor request/output
```

放下连线前验证类型、Schema、`one/many` 占用和环路；放下后检查目标节点显示真实值；运行后检查 executor 是否消费同一个 `portId`，不得通过“上游节点类型/标题扫描”补数据。

### 2.4 真实功能验收

- 本地媒体节点：用真实 PNG/JPG/MP4/WAV，检查文件读取、转换、媒体表、`mediaPath` 和输出端口；
- 远程生成节点：记录最终 HTTP method/URL/headers/body、task id、轮询响应、下载、入库和重启恢复；
- 浏览器 mock 只证明 UI、连接和演示数据流，不证明真实供应商协议；
- 每个“生成/修改/配置”按钮必须有前后快照和可断言结果，不能只验证按钮存在。

## 3. 第一轮证据

### 3.1 23 个节点空态截图

执行：

```powershell
node scripts/audit-node-ui.cjs http://127.0.0.1:3123/ artifacts/node-ui-audit-2026-09-11
```

证据目录：`artifacts/node-ui-audit-2026-09-11/`，包含 23 张节点截图和 `report.json`。视口为 `1708×879`，每个节点使用独立浏览器上下文，避免前一节点的配置污染后一节点。

### 3.2 视频节点深度审查

执行：

```powershell
node scripts/audit-video-node.cjs http://127.0.0.1:3123/ artifacts/video-node-audit-2026-09-11
```

证据目录：`artifacts/video-node-audit-2026-09-11/`，包含空态、选择模型、连接图片、手动选择非法模式等截图和结构化状态。

本轮真实观察到：

- fresh video：模型下拉有 `演示中转站 · MiniMax-H3`，但实际 value 为空；节点立即显示能力错误，生成按钮 disabled；
- 选择该模型后，因为演示供应商 `specId=relay`，仍解析为 fallback，只暴露“文生视频”；
- 图片输出接入视频 `in-images` 后，边确实创建，但模式仍是 `text`，节点显示“文生视频模式不能连接图片”；
- 视频空态 body `scrollWidth > clientWidth`，宽度在放大/适配后会出现横向内容挤压；
- 当前脚本的自动模式断言因此失败，证明演示 fixture 本身不能代表 MiniMax H3 的能力，不能把 mock 通过当真实验收通过。

### 3.3 P0 修复后二次证据

执行：

```powershell
node scripts/audit-video-node.cjs http://127.0.0.1:3123/ artifacts/video-node-audit-2026-09-11-p0-final3
```

结果：三个自动断言均通过：

1. 新建视频节点没有隐式 provider fallback，必须显式选择模型；
2. H3 连接一张真实图片后，默认模式为 `reference`（UI 名称“多参模式”）；
3. 接图后的模式选择只有 `reference`、`first-frame`，`text` 不再出现，提交按钮保持可用。

截图 `04-h3-one-image-filtered-modes.png` 同时确认输入卡展示缩略图、`video-audit` 资产名称和“参考图 1”角色。这是 browserMock 证据；真实模型请求、任务轮询、资产落盘仍须在 Electron + 已配置供应商环境完成。

### 3.4 本地媒体节点的真实 FFmpeg 验收（2026-09-19 追加）

§2.4 要求“本地媒体节点用真实 MP4/WAV 检查转换结果”，但此前 `test/video-transform.test.ts`
mock 的是 `window.api`，`test/video-transform-main.test.ts` mock 的是 `child_process.spawn`——
**主进程那批真调 FFmpeg 的处理器一次都没有跑过真二进制**。新增
`test/video-transform-real-media.test.ts`：用 `lavfi` 合成一段 2 秒 320×240 带音轨的测试片和
一段完全无声的测试片，只 mock 持久层（`media.repo` 落盘 + `db` 查询），产物文件再交给
`ffprobe` 独立复核，避免「FFmpeg 自己产的文件自己说没问题」。本机没有 FFmpeg 时整组跳过。

真跑出来的结论：

- 通过：`probeVideo` 的时长/帧率/音轨判定；取帧的首帧、自定义时间、**尾帧**（尾帧是越界输出
  空文件的高危路径，实测产物是有效 PNG）；精确重编码截取 500–1500ms 实得约 1.0s 且带 aac 音轨；
  提音产出 `RIFF`/48000 的 WAV 且时长吻合。
- 缺陷（已修）：对**没有音轨的视频**执行提音，FFmpeg 直接失败，用户看到的是
  `视频处理失败：[out#0/wav @ …] Output file does not contain any stream` 加一条系统临时目录
  绝对路径。现在 `transformVideoAudio` 先用一次 `ffprobe -select_streams a:0` 判定，改报
  「这段视频没有音轨，提取不出音频」；探测本身失败时不猜测，仍交给 FFmpeg 报错，免得把
  「FFprobe 不可用」说成「没有音轨」。
- 已知取舍（未改）：快速截取按关键帧流复制，实测 500–1500ms 得 998ms——边界不精确是 `-c copy`
  的设计代价，测试据此只断言“不少给、仍可解码”，没有把它写成精确区间。

### 3.5 人声分离与时间轴缩略图/波形的真实验收（2026-09-19 追加）

同一套打法用到 §3.4 剩下的三个函数：`separateVocals`（快速模式）、`generateVideoThumbnails`、
`generateAudioWaveform`。素材按声像分成两份满刻度正弦：`center.wav`（左右同相，即居中人声，
也是“单声道录音上混立体声”的日常形态）与 `side.wav`（右声道反相，只有左右差值、没有同相内容，
即分布在两侧的伴奏）。响度不由被测代码自证，用 `volumedetect` 的 `mean_volume` 独立读。

两条真缺陷都在这里被抓出来，且新用例在还原旧代码后确实各自失败（不是恒真断言）：

- **快速增强的滤镜方向是反的**（已修）。原来是 `pan=mono|c0=0.5*c0+-0.5*c1`，注释与节点文案
  都写着“中置声道提取”，但左右相减抵消的正是同相内容——居中的人声被整条抹掉。实测：同相素材
  输出 `-91 dBFS`（数字静音），反相素材输出 `-17 dBFS`，与承诺完全相反。用户侧表现是
  人声分离节点“成功”产出一条听不见的文件，而它的下游正是语音克隆/配音。现改为
  `0.5*c0+0.5*c1` 下混（保留居中、削弱两侧），文案补上“单声道素材左右无差值，快速模式只等于
  降噪，请用高质量模式”。
- **波形按采样数反推解码率，把内容滤没了**（已修）。`-ar min(8000, samples*4)`：节点实际请求
  300 桶 → 1200Hz → 低通截止 600Hz，人声频带被切掉大半；64 桶 → 256Hz 时连 440Hz 纯音都只剩
  峰值 `0.016`（同一素材修好后是 `0.09`，与其 −21dBFS 响度吻合），时间轴永远画成一条平线。
  降采样对性能没有意义（分桶在 JS 里做），现固定 8kHz，失败分支与成功分支的 `sampleRate`
  也随之统一。用例改用满刻度 1kHz 素材，阈值 0.5。
- 通过：缩略图按请求数量产出、每张都是可解码 JPEG，`count` 越界被夹在 1–12；波形对静音素材给
  全零而非 NaN；三条路径对不存在的源都在执行前报错，不去调用 FFmpeg。

### 3.6 文档导入链路的真实落盘验收（2026-09-19 追加）

`extractDocumentText` 一直有 `test/document-text.test.ts` 覆盖，但它只证明**解析器**认这些字节。
真正的入口是 `importMedia()`：扩展名→`detectKind`→白名单判断→复制进 `projects/<pid>/media/`→
SQLite 索引→把抽出的正文写进 `asset.textContent`，而 `CanvasEditor` 只在那一刻把
`asset.textContent` 塞进节点 `props.text`。也就是说这条链路一断，表现就是“拖进去一个 Word，
文档解析节点的 out-text 是空的”，而它此前在测试里**一次都没有被调用过**。

新增 `test/media-import-real.test.ts`：样张字节抽到 `test/helpers/document-fixtures.ts`，
由解析器用例与导入用例共用（两边看着同一份字节，才不会一边修好另一边还蒙在鼓里）。
只 mock 数据目录与 SQLite，文件读写、adm-zip、unpdf 全是真的；每条用例都额外把落盘副本
读回来与源字节逐字节比对，并断言 `INSERT INTO media` 的六个绑定参数。

覆盖到的结论（7 例全绿；把抽取那一行还原成空串后，Word/Excel/PPT/PDF 两例确实报错，非恒真断言）：

- Word / Excel / PPT / 中文 PDF 导入即得正文，且正文与解析器用例的期望字符串完全一致。
- 节点标题取用户文件名去扩展名（`分镜 草稿.docx` → `分镜 草稿`），媒体路径是随机 ID：
  中文名与空格不会泄漏进路径。
- 拉丁 PDF 与中文 PDF 同链路，不依赖外部 cmaps 目录。
- 旧版 `.doc`、无文字层扫描件、`.bin`：照常导入，只是没有正文——文档解析节点据此显示“不解析”，
  而不是把导入整个失败掉。
- 体积闸门（文本内联 1MB、Office/PDF 抽取 50MB）只跳过抽取，不拒绝导入。
- 目录路径 → `{ ok: false, reason: '不是有效文件' }`；`.mp4` / `.wav` 仍按视频/音频分类，
  不会因为“抽取失败”退化成 `file`。

### 3.7 文本文件编码：记事本 ANSI 与 PowerShell 导出的剧本此前必乱码（2026-09-19 追加）

同一批用例顺手试了三种中文用户最常见的“不是 UTF-8 的文本”：Windows 记事本按「ANSI」保存的
剧本（GBK）、PowerShell `Out-File` 默认产出的 UTF-16LE、以及带 BOM 的 UTF-8。旧实现是
`readFile(destAbs, 'utf-8')`，实测结果：

- GBK：`第一幕` → `\ufffd\ufffdһĻ`。文档解析节点会把这串替换字符原样喂给下游模型——
  垃圾进垃圾出，而且节点上看不出来。
- UTF-16LE：每两个字节被当成一个非法序列，中文全部变替换字符。
- 带 BOM 的 UTF-8：正文首字符是 `\uFEFF`，它会一路留在 `props.text` 里。

新增 `src/main/media/text-decode.ts` 的 `decodeTextFile()`，判定顺序 **BOM → 严格 UTF-8 → GBK**：
纯 ASCII 同时是合法 UTF-8 与合法 GBK，只有先按 UTF-8 判定才能保证正常文件一个字节都不改
（用例里 JSON/CSV 逐字符等值还原就是在守这条）；GBK 分支只在严格 UTF-8 抛错后才走，
运行环境缺 legacy 编码数据时构造 `TextDecoder('gbk')` 会抛，捕获后退回原有的有损解码，
不改变导入结果。BOM 只剥开头那一次，不动正文其余字节。

同时修掉文件资产节点的一处误导文案：`.docx` / `.pdf` 属于支持格式，但扫描件或超大文件抽出
的正文为空时，节点和 `.exe` 一样显示“该格式不在画布内解析”——用户据此会以为换格式能解决，
实际是文件里没有可选中的文字。现在按扩展名分两支：支持格式但没抽出文字 →
「未抽出文字：扫描件、纯图文或文件过大」并补一句「下游 out-text 会是空的，先用系统程序确认
文件里有可选中的文字」；真正的未知格式仍保留原文案。

真 Chromium 核对这两条分支时发现第三处缺陷：节点判断格式只看 `mediaPath` 的扩展名，而浏览器
验收页把小文件存成 data/blob URL——路径里没有可信扩展名，于是**导入一个正常 `.txt` 也会显示
“该格式不在画布内解析”**，正文预览整块出不来。现补 `extensionForMime()`（`src/shared/mime.ts`
的反查，同 mime 多扩展名取表里第一个），路径给不出可信扩展名时按 `mediaMime` 还原。
两条分支都在验收页跑过（`window.api` 为 mock，但组件、CSS、文件选择器都是真的）：

- `扫描页.pdf`（无文字层）→ 标题「扫描页」、副标题「PDF · application/pdf」、新文案两行，
  `.file-asset-binary` 的 `scrollHeight == clientHeight == 174`，底部「替换 / 定位」仍在卡片内。
- `剧本.txt` → 预览「第一幕：雨夜 / 第二幕：天台」，副标题「TXT · text/plain · 2 行」。
  修复前这一张显示的正是那句误导文案。

### 3.8 图片裁剪 / 四角透视 / 宫格拆分的真实像素验收（2026-09-19 追加）

`transformImageCrop` 与 `transformImageSplit` 在测试里**一次都没被调用过**：图片裁剪与宫格拆分
节点的两个 IPC 端点只跑过纯函数（`buildImageSplitTiles`、`solveHomography`、`parseImageCropConfig`），
纯函数对了不代表采样对——偏移一格、读错一个坐标都只在产物 PNG 上看得见。
新增 `test/image-transform-real.test.ts`：源图与产物全部真落盘（`fs/promises` 写临时目录），
真用 `@napi-rs/canvas` 解码并重编码，再把产物字节**独立解码回像素**逐点核对；只 mock SQLite 与
媒体索引写入。10 条用例的结论：

- **缺陷一（已修）：1:1 拷贝开着高质量平滑，产物边缘渗进裁剪区外的颜色。**
  `renderRect` 里 `drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)` 两组尺寸相同、根本不缩放，
  `imageSmoothingEnabled = true` + `quality = 'high'` 只剩副作用：采样核读到框外相邻像素。
  实测源图 120×60 的 3×2 拆分，`拆分图-R1C1` 的右下像素是 `[209,39,32]`（本格红 `220,30,30`
  混进了右邻格的绿）；矩形裁剪取右下象限时左上角是 `[210,202,50]`（黄里混了蓝与红）。
  用户看到的就是九宫格分镜每一格四周镶着一圈邻格残影。改为关闭平滑后逐点复验：四角与中心
  全部是纯本格色。浏览器验收页 `dev/browserMedia.ts` 里照抄的裁剪/拆分实现同步改掉，桌面与演示页
  不再有两种产物。
- **透视裁剪确认是真正的单应变换，不是外接矩形。** 用例把源图正方形区域按「左上→右上→左下→右下」
  的语义**旋转 90°** 指派给输出矩形，实测输出四角依次为绿/黄/红/蓝（外接矩形实现会给出
  「左上=红」）。另有一条梯形选区用例：四边形整体落在单一象限内时，输出的每个采样点都必须是那一色，
  证明没有把外接框的邻色拖进来。输出尺寸按上下边、左右边长度平均得出 20×30，与手算一致。
- **`validateImageCropConfig` 的「裁剪区域不能为零」在节点链路上不可达**：
  `parseImageCropConfig` 把宽高下限锁在 `1/10000`，零宽高会被收成 1px 细条（实测 1×20 资产）
  而不是报错。这条不是 bug（细条比静默失败更可解释），但审查时容易误以为有零面积保护，
  用例已把真实行为写死，避免以后有人按错误提示去「修」。自交四边形仍在执行前抛错且不落任何资产。
- **越权与体积闸门都真的生效**：别的项目的同名图片（`projects/p2/...`）走前缀匹配查不到 →
  「输入图片不存在，或不属于当前项目」；`kind='video'`、不存在的 ID 同一句话；
  `size_bytes > 100MB` 在解码前就被挡住。四种失败都不会产生新资产。
- **拆分的中途失败回滚是真的**：让第 4 格写盘抛错，验证前 3 格既从索引删除、磁盘文件也读不回来，
  失败后表里只剩源图——不会给节点留半套输出。
- **行列越界收敛符合设计**：200×200 的请求被压成 64 格（保行数、列数降到 1），产物命名
  `拆分图-R1C1 … 拆分图-R64C1`。
- 已知未修的精度边界：归一化格宽不能整除像素时（例如 100px 宽拆 3 列），整数取整会让某一列像素
  不属于任何格。要彻底消掉得让 `buildImageSplitTiles` 知道图片像素尺寸并按像素边界分格，
  而它同时被选区 UI 用作归一化几何——1px 的代价不值当改契约，记录在此。

变异核对：把 `renderRect` 改回旧写法（floor + 高质量平滑）后，上述两条像素用例分别以
`[209,39,32]`、`[210,202,50]` 失败，确认断言不是空跑；其余 8 条在两种实现下都通过，
说明它们守的是契约与失败路径，不依赖这次的颜色修复。

## 4. 视频节点详细问题

### P0-VIDEO-001：未选择模型时直接进入错误态（已修复）

证据：

- `src/renderer/src/nodes/specs/bodies/video.tsx:173-181`：`data.modelKey` 为空时，能力退化为 `videoCapabilitiesFor('seedance')` 的 fallback；
- `src/shared/video-capabilities.ts:111-125`：fallback 只支持 `modes: ['text']`；
- `video.tsx:46-57`：未保存模式默认返回 `reference`；
- 浏览器截图 `artifacts/video-node-audit-2026-09-11/01-fresh.png`：模型有可选项但未选中，同时显示“当前模型不支持此视频生成模式”。

影响：新建节点第一眼就是“有模型但不能跑”，用户无法分辨是未选模型、模型加载中还是模式错误。

修复：明确拆分“未选模型 / 已选模型无素材 / 已选模型有素材”。未选模型时不套用 provider fallback；显示“请选择视频模型”，禁用生成和模型参数，待模型选中后再计算模式与参数。二次审查断言 `fresh-requires-an-explicit-model-choice` 已通过。

### P0-VIDEO-002：图片接入后仍允许选择文生视频（已修复）

证据：

- `video.tsx:509-513` 直接渲染 `capabilities.modes`，没有结合图片、参考视频、参考音频过滤选项；
- `video.tsx:204-227` 只在输入数量变化时尝试自动切换；
- `video-capabilities.ts:233-237` 只能在运行前报错，不能阻止用户先选出非法模式；
- 实际浏览器操作：图片边创建成功，但 mode 仍为 `text`，按钮只是 disabled 并显示冲突错误。

影响：核心约束变成“允许非法配置，再在最后拦截”，用户会认为图片连线失效；切换模型或重载时也可能保留不合法 mode。

修复：模式选项由“真实选中模型能力 + 当前输入集合”计算：

- 无图/无参考媒体：只显示文生视频；
- H3 + 1 张图：默认多模态参考，可明确切换首帧；
- H3-Max + 1 张图：隐藏多模态，只显示首帧；
- 两张图：允许首尾帧；多模态模型可另选参考模式；
- 参考视频/音频接入：仅支持参考能力的模型可进入多模态；不支持时直接标出具体端口和模型原因。

`resolveVideoMode` 同时被 renderer 与 executor 调用；已有保存的 `text` mode 在接入图片后会收敛为合法的 `reference`/首帧模式，无法再从 UI 下拉选择。二次审查断言 `one-image-forces-non-text-mode`、`text-mode-is-not-selectable-after-image-connects` 均通过。

### P0-VIDEO-003：浏览器演示 fixture 将 MiniMax H3 错标为 relay（已修复）

证据：`src/renderer/src/dev/browserMock.ts:43-55`：同一个 `specId: 'relay'` provider 里放入 `MiniMax-H3` 视频模型。

影响：`videoCapabilitiesFor('relay', 'MiniMax-H3')` 无法命中 H3 profile；浏览器审查永远看不到多参、首尾帧和 H3 参数，导致 UI 回归测试产生错误结论。

修复：浏览器演示已拆成独立的 `specId: minimax` 与 `specId: seedance` fixture。浏览器脚本已断言模型选择、模式收敛和提交可用性；真实请求 payload、轮询和结果入库仍列为桌面端验收项。

### P1-VIDEO-004：renderer 与 executor 的默认 mode 逻辑不是同一个函数（已修复）

证据：

- `video.tsx:68-75` 的 `automaticMode` 会看 capability；
- `src/shared/engine/executors/video.ts:16-27` 缺少 mode 时无条件返回 `reference`；
- `video.tsx:204-227` 与执行器各自维护默认策略。

影响：画布看起来已自动回退到首帧，但整图/headless 运行仍可能按 reference 提交；H3-Max 这类不支持参考的模型会产生 renderer/executor 分歧。

修复：已新增共享 `resolveVideoMode(capabilities, inputs, savedMode)`；renderer 与 executor 共用。保存的显式 mode 只在当前能力/输入组合仍合法时保留。

### P1-VIDEO-005：图片端口是 many，但首帧/尾帧/参考图角色只存在于 mode 推断（已修复）

证据：

- `definitions.ts:172-177` 只有一个 `in-images` many 端口；
- `video.tsx:181-196` 根据 mode 和顺序解释同一批图片。

影响：同一条边在切换模式后含义改变；用户无法在卡片里确认“图片 1 是首帧、图片 2 是尾帧、图片 3 是参考图”，上游也无法得知自己的输出角色。

修复：不拆分端口，但在目标卡片把每个已连接图片呈现为缩略图、资产名称与角色标签（首帧/尾帧/参考图 N）；模式切换同步更新，避免让连线只剩抽象圆点。

### P1-VIDEO-006：默认分辨率依赖数组最后一项，默认成本过高（已修复）

证据：`video-capabilities.ts:195-199` 和 `video.tsx:606-610` 都使用 `resolutions.at(-1)`。

当前会把 H3 默认成 `2K`，Seedance 2.0 默认成 `4k`。这不是“默认稳定档位”，而是由数组排序偶然决定的。

修复：能力 profile 已增加 `defaultResolution/defaultDuration/defaultRatio`。H3 默认 768P、5 秒、16:9；Seedance 默认 720p、5 秒、16:9；数组顺序不再承担业务语义。

### P1-VIDEO-007：Seedance 兼容网关把参数拼进 prompt，正式控件与真实能力不一致（已透明化，待真实 wire 验收）

证据：`src/main/gateway/video.ts:394-406` 把画幅、清晰度、时长、seed、水印拼成 `--rt/--rs/--dur/--seed/--wm` 后缀；非代理才发送结构化字段。

影响：UI 显示为参数控件，但兼容网关是否识别完全未知；参数失效时没有结构化错误，也无法证明 Seedance 2.0 的真实协议已接入。

已处理：能力 profile 现在显式声明 `parameterTransport`。官方端点显示为 `structured`；`/gateway/ark/` 兼容地址显示“兼容网关”说明，明确画幅、时长、清晰度按兼容格式提交且以任务回执为准；不再把它误呈现为已验证的官方结构化字段。仍待：用已开通价格的 Seedance 账号保存真实 request/response fixture，再将兼容模式升级为已验证适配器。

### P1-VIDEO-008：视频 configSchema 没有声明 mode/params（已修复）

证据：`src/capabilities/definitions.ts:223-225` 只有 `providerId`、`modelId`；实际 `mode`、`params`、prompt 仍由 Body 私有 JSON 解析。

影响：Agent/契约生成层看不到画幅、时长、分辨率和模式；节点协议无法独立描述“哪些配置组合可运行”。

修复：在不改变端口的前提下，已将 `prompt`、`modelKey`、`mode` 与 `params.ratio/duration/resolution/generateAudio/seed/watermark` 置入可版本化 configSchema，并将视频节点提升至 contractVersion 5、同步生成 Agent 契约。模型能力约束仍由共享 profile 与 resolver 校验。

### P1-VIDEO-009：输入格式、尺寸、请求体和提示词限制没有在节点侧提前验证（部分修复）

MiniMax H3 V2 当前文档给出的限制包括：提示词不超过 7000 字符；图片单个不超过 30 MB、宽高 [256, 5760] 且宽高比 0.4～2.5；视频单个不超过 50 MB、单段 2～15 秒且总时长不超过 15 秒；音频单个不超过 15 MB、单段/总时长同样受限；请求体总大小不超过 64 MB。当前 `VideoBody` 没有 `maxLength` 或媒体探测错误展示，`main/gateway/video.ts:285-325` 还会把媒体读成 Data URL 直接拼入请求。

影响：用户在 UI 里可以选择合法模式，但大文件、错误尺寸或过长提示词会在远端才失败；Data URL 会放大请求体并造成主进程内存峰值，尤其是多参模式。

已处理：H3 profile 已声明 7000 字符提示词上限，UI `maxLength`、renderer executor 与 main gateway 共同校验；主进程在读取 Data URL 前按媒体索引校验 H3 的图片 30MB、视频 50MB、音频 15MB 单项上限，并将原始参考媒体合计限制为 46MB，为 Base64/JSON 预留 64MB HTTP 请求体空间。仍待：在导入时写入图片宽高和视频/音频时长，再补齐 256～5760 像素、比例、2～15 秒等更细限制；优先改为供应商上传/临时 URL 后可取消 Data URL 总量折算。

### P2-VIDEO-010：H3 的 Context-IR 与视频再生成能力尚未形成独立可验收入口

MiniMax 官方指南还提供 H3-Context-IR（只生成增强提示词）和基于 H3 768P 成片再生成 2K 的任务入口。当前视频节点只有一次普通生成和 regenerate UI，没有把这两种能力建成独立节点/命令或明确标记为未支持。

影响：用户无法判断“重新生成”是复用当前 prompt 重新抽卡，还是调用官方 regeneration；Context-IR 也无法在工作流中复用。

优化：保持节点单一职责，后续分别设计 `video.context-ir` 与 `video.regeneration` 能力（或明确列为暂不支持），各自声明输入、输出和 provider capability；不得在现有“生成视频”按钮里隐式追加未声明业务输出。

## 5. 23 个节点第一轮 UI/端口矩阵

下表来自 `artifacts/node-ui-audit-2026-09-11/report.json`。它是结构审查，不是功能通过表。

| 节点      | 初始尺寸 | 输入/输出端口 | 空态溢出 | 第一轮判断                                           |
| --------- | -------: | ------------: | -------- | ---------------------------------------------------- |
| 文本      |  340×260 |         1 / 1 | 无       | 空态可见；需继续验证双击输入、保存、下游文本消费     |
| 图片      |  340×260 |         0 / 1 | 无       | 资产入口可见；需真实文件、替换、输出预览和下游连接   |
| 裁剪      |  340×260 |         1 / 1 | 无       | 配置入口可见；需真实裁剪结果、比例、动态高度         |
| 拆分      |  340×220 |         1 / 2 | 无       | 网格参数可见；需 2×2/4×4 结果展开、端口和尺寸重算    |
| 生图      |  340×260 |         3 / 1 | 无       | 模型/画幅/按钮可见；需真实比例请求和参考图关联       |
| 修改      |  340×260 |         2 / 1 | 无       | 工作台入口可见；需标注→mask→真实图生图结果           |
| 视频      |  340×293 |         5 / 1 | 无       | 空态、模型选择、单图多参状态已回归；真实供应商待验收 |
| 取帧      |  340×260 |         1 / 1 | 无       | 需真实 FFmpeg/FFprobe、时间定位、媒体落盘            |
| 截取      |  340×260 |         1 / 1 | 无       | 需真实裁剪区间、输出视频和取消/失败                  |
| 提音      |  340×260 |         1 / 1 | 无       | 需真实音频输出、格式/路径和下游连接                  |
| 人声分离  |  340×260 |         1 / 1 | 无       | 需能力探测、模式、伴奏第二输出和失败路径             |
| 音频      |  340×260 |         0 / 1 | 无       | 需真实导入、名称、音频预览和下游输入                 |
| 配音      |  340×260 |         1 / 1 | 无       | 需文本合并、模型/音色/格式和真实音频输出             |
| 语音克隆  |  340×466 |         2 / 1 | 无       | 需参考语音、后端可用性、克隆结果和状态               |
| 对话      |  340×260 |         1 / 1 | 无       | 需选中开侧栏、真实多轮、markdown 下游                |
| 处理      |  340×260 |         1 / 1 | 无       | 需透传/字段提取/模板和输出类型                       |
| JSON      |  340×464 |         2 / 1 | 无       | 需输入解析、非法 JSON、Schema 和保存重开             |
| 结构数据  |  340×260 |         2 / 1 | 无       | 需模板替换、角色/场景/镜头 schema 校验               |
| 代码      |  340×342 |         2 / 1 | 无       | 需动态输入端口、离线沙箱、失败和确定性               |
| 分镜板    |  340×260 |         2 / 2 | 无       | 需 storyboard Schema、解析/编辑、下游 prompt bundle  |
| AI 处理   |  340×260 |         2 / 3 | 无       | 需 text/markdown/json 分支、Schema 错误和真实模型    |
| 循环      |  340×260 |         1 / 2 | 无       | 需顺序、限数、失败策略、取消和 item/out-items 关系   |
| 3D 预演台 |  340×260 |         3 / 4 | 无       | 本轮按约束暂不作为视频前置；需单独人工验收发布链路   |

## 6. 当前关系与测试覆盖判断

已有的 `test/connection-matrix.test.ts`、`test/contracts.test.ts`、`test/batch-connection.test.ts` 和 `test/connected-input-preview.test.ts` 能证明部分静态关系规则：类型、Schema、基数、many 顺序和批量连接计划的纯函数逻辑存在。

本轮运行结果：

```text
npm run typecheck                         PASS
npx vitest run test/video-capabilities.test.ts test/async-executors.test.ts   26 tests PASS
23-node empty-state browser audit         PASS（23 节点均无 body 横/纵溢出）
video deep browser audit                  P0 断言 PASS（不代表真实供应商验收）
```

仍缺少的关键证据：

- 当前网关标作 MiniMax H3/H3-Max 的真实桌面 HTTP 成功/失败响应；
- Seedance 2.0 官方方舟和兼容网关的真实桌面 HTTP 成功/失败响应；
- 每个远程生成节点成功/失败/取消/重试的桌面端结果入库；
- 每个节点至少一条真实“上游输出 → 下游输入 → executor 消费”的保存重开链路；
- 模式切换后图片角色、画幅来源和输出结果摘要的截图门禁。

## 7. 模型协议核对基线

### 7.1 已能由公开官方文档证明的协议

此前本节把 `/v2/video_generation` 判成「只有中转网关才有、不能算官方」，结论是错的，
2026-09-19 用零成本探测推翻（不带 Key 的 HTTPS 请求，未鉴权即被拒，不产生任何计费）：

- `POST https://api.minimaxi.com/v2/video_generation` → HTTP 401 `authorized_error`；
- 同主机 `POST /v2/nope_xyz` → HTTP 404 `404 page not found`。**存在的路由才会在鉴权层拒绝**，
  所以 `/v2/video_generation` 与 `/v2/query/video_generation/{id}` 都是官方主机的真实路由；
- `GET /v2/video_generation` 返回 404 只是因为它没有 GET 方法，不能据此判定路由不存在——
  这正是当初得出错误结论的原因。
- 官方 Hailuo 2.3 / 2.3 Fast / 02 的老契约仍在：文生、图生和首尾帧使用
  `POST /v1/video_generation`；图生使用 `first_frame_image`，首尾帧使用
  `first_frame_image` + `last_frame_image`；时长/分辨率由具体模型组合决定；任务异步返回
  `task_id`。参考：

- [MiniMax 文生视频 API](https://platform.minimax.io/docs/api-reference/video-generation-t2v)
- [MiniMax 图生视频 API](https://platform.minimax.io/docs/api-reference/video-generation-i2v)
- [MiniMax 首尾帧视频 API](https://platform.minimax.io/docs/api-reference/video-generation-fl2v)

火山引擎的 Seedance 2.0 官方 LAS 文档则明确：请求使用 `content[]` 多模态项，支持
`text`、`image_url`、`video_url` 等输入，输出为异步 task；2.0 的参考图为 1–9 张、参考视频
最多 3 段，单视频 2–15 秒、单音频 2–30 秒；每张图小于 30MB、请求体不超过 64MB；`resolution`、
`generate_audio`、`watermark` 是独立字段。参考：[Seedance 增强版视频生成官方文档](https://docs.byteplus.com/en/docs/byteplus_las/video_gen_enhanced)。

### 7.2 当前项目的适配结论

- `MiniMax-H3` / `MiniMax-H3-Max` 走 `/v2/video_generation` + `content[]`：按 7.1 的探测，这
  就是 MiniMax 官方 v2 视频协议（不是私有网关方言），因此适配可以按官方契约维护。仍未证明
  的是**模型名**：公开文档目前列出的仍是 Hailuo 2.3 / 2.3 Fast / 02，`MiniMax-H3` 这类 ID
  是否被官方端点接受，只有拿真实 Key 跑一次最低秒数任务才知道。
- 因此 H3 的 4–15 秒、768P/2K、12 个总素材等 profile 保留为**待验收能力配置**：协议方向已
  由零成本探测确认，计费成功/失败 wire fixture 仍缺，补上之前不得标记为供应商级验收通过。
- MiniMax 有两种错误信封，两条都得读：v1 会在 **HTTP 200** 里塞
  `base_resp.status_code`（探测 `/v1/video_generation` 未鉴权即返回 200 + `status_code 1004`），
  v2 的非 2xx 则用 `{"type":"error","error":{"message":…}}`。前者不看就会把业务错误当成
  「任务还在跑」，白等到超时且已扣费；`classifyMiniMaxTask` / `minimaxBaseRespError` 负责 v1
  式信封，`extractUpstreamMessage` 的递归取值负责 v2 式信封。
- Seedance 的 official/proxy 双通道继续分开：官方通道使用结构化字段；兼容网关仅在已有真实
  响应证据证明其 prompt 后缀语法时使用 `gateway-compatibility`，绝不把兼容写法传播到官方端点。

### 7.3 供应商预设必须与节点的模型过滤对得上（2026-09-19 追加）

「填好 Key 就能跑」还依赖一条此前没人核对的链路：设置面板按模板预填模型时，会用
`guessModelModality(id, specId)` 猜每个模型的模态，而语音/视频类节点的下拉一律是
`modelsByModality(providers, X)` 再按协议过滤。**猜错模态等于该模型在节点里选不到**，
而且不报错、只显示空列表。实测到两处断链并已修：

- 豆包语音（Seed-Audio）模板的建议模型 `seed-audio-1.0` 曾被猜成 `text`，于是配音节点的
  豆包与火山语音合成 1.0 两条通道都列出 0 个模型（协议自检同样报「未配置语音模型 ID」）。
  现在 `doubao-speech` 直接判为 `audio`（该实例只有语音），并把 `speech|tts|voice|audio`
  的识别从「仅 MiniMax 模板」提升为通用规则。
- MiniMax 模板缺 `speech-2.8-hd`（配音节点的默认 `modelId`），OpenAI 模板缺任何 TTS 模型，
  两条通道新建供应商后都要用户手填模型 ID。预设已补齐（OpenAI 加 `gpt-4o-mini-tts`）。
- 反方向的断链更贵：`minimax` 原先是「不是语音就算视频」，而同一个 Key 还能调 MiniMax 的
  大模型（`MiniMax-M2`、`MiniMax-Text-01`、`abab6.5s-chat`）。用户在面板里手动补一行 M2，
  它就会出现在视频节点下拉里——视频节点没有能力白名单，任何 `video` 行都会按 `FALLBACK`
  档位拼请求发出去。现在 `minimax` 按型号族分流（语音/图片/视频/大模型），**认不出时仍兜底
  成视频**：新发布的 H 系列不能因为这份正则落后就选不到，这是两害相权的取舍。
  `seedance` 保持整家 `video`——方舟接入点 ID 形如 `ep-2025xxxx-xxxx`，没有任何可辨认词汇。

门禁：`test/provider-preset-modality.test.ts`。它刻意**不复用**组件里的 `acceptsProvider`，
而是照节点契约重写一份协议↔供应商对照表——两边都复用时，一起写错就测不出来。

### 7.4 MiniMax 语音与音色契约的零成本探测（2026-09-19）

用户要求「确认」音色设计与语音克隆/合成接的是不是官方接口。下表全部来自不带 Key 的
HTTPS 探测（未鉴权即被拒，零计费），主机是设置面板默认的 `https://api.minimaxi.com`；
对照路径 `/v1/definitely_not_real_xyz` 与 `/v2/t2a_async_v2` 都返回 404，所以下面的
200/401 只能解释为「路由真实存在，只是没给 Key」：

| 代码里的调用                                           | 方法 | 探测结果               | 结论               |
| ------------------------------------------------------ | ---- | ---------------------- | ------------------ |
| `/v1/t2a_async_v2`（`audio.ts` 异步合成主通道）        | POST | 200 + `base_resp 1004` | 官方存在           |
| `/v1/t2a_v2`（同步兜底）                               | POST | 200 + `base_resp 1004` | 官方存在           |
| `/v1/query/t2a_async_query_v2?task_id=`（轮询）        | GET  | 200；POST 为 404       | 只能 GET，代码正确 |
| `/v1/files/retrieve?file_id=`（取成片）                | GET  | 200；POST 为 404       | 只能 GET，代码正确 |
| `/v1/files/upload`（克隆参考音与提示音）               | POST | 200 + `base_resp 1004` | 官方存在           |
| `/v1/voice_clone`（语音克隆）                          | POST | 200 + `base_resp 1004` | 官方存在           |
| `/v1/voice_design`（音色设计，返回 `trial_audio` hex） | POST | 200 + `base_resp 1004` | 官方存在           |

- MiniMax 语音/音色全族走 **v1 + `base_resp`**，视频走 **v2 + `/v2/query/…`**，两套错误信封
  不同：v1 即使 HTTP 200 也可能是业务失败。因此 `assertMiniMaxOk`（语音）与
  `classifyMiniMaxTask`（视频）都必须保留，缺一处就会出现「白等到超时且已扣费」。
- 探测不能证明的只剩两件事：账号是否接受 `MiniMax-H3` / `speech-2.8-hd` 这类模型 ID，以及
  计费成功响应体的字段。这两项只能由真实 Key 跑最低成本任务收口（任务 B2 / B4）。

### 7.5 真实 Key 下的免费自检：两项只读探测此前永远判不出结论（2026-09-19 追加）

§7.4 的遗留问题在拿到用户 Key 后先做了**零计费**收口：把 Key 只放进环境变量，用主进程
同一份 `probeProvider()` 跑一遍。结果证明这套自检对 MiniMax 完全没有产出——两项只读探测
全都落在「无法判定」，总结语是「请核对 Base URL 与密钥」，而密钥其实是对的：

| 探测项                                | 上游原话回执                                             | 修复前判定 | 修复后判定 |
| ------------------------------------- | -------------------------------------------------------- | ---------- | ---------- |
| `GET /v2/query/video_generation/<假>` | HTTP 500 `record not found (1000)`                        | 上游服务异常 | 通过       |
| `GET /v1/query/t2a_async_query_v2`    | HTTP 200 `base_resp 2013 invalid params, task not found`   | 未判定     | 通过       |
| 同一端点 + 故意错的 Key（控制组）     | HTTP 401 `authorized_error … (1004)` / HTTP 200 `login fail: Please carry the API secret key…` | 401 失败；200 那条也是未判定 | 两条都判失败 |

三处缺陷与对策：

- **状态码优先于语义**：MiniMax 对「任务不存在」不发 404，而是 500 / 200+业务码。请求能进到
  查任务这一步就说明鉴权已经过了，这恰恰是探测想证明的事。现在 `requestProbe()` 在非 401/403
  的回执里认出 `record not found` / `task not found` 两句原话并判通过，其余仍走保守分支。
  规则刻意只做窄匹配：Base URL 填错得到的 `404 page not found` 不在此列，仍然只算未判定
  （这条有专门的对照测试，把规则放宽成 `/not found/` 就会红）。
- **语音探测的假 task_id 不是数字**：MiniMax 的 `task_id` 只收数字，非数字在参数校验阶段就被
  挡下，回执是光秃秃的 `invalid params`——证明不了密钥，只会让用户以为我们发错了请求。
  改成必然不存在的数字号段后，真实 Key 拿到的是 `invalid params, task not found`。
- **`authFlavored()` 漏掉 MiniMax 说「密钥不可用」的英文原话**：`login fail` 与
  `API secret key` 都不匹配旧正则，坏密钥在 v1 端点（HTTP 200 信封）会被报成未判定。补进模式后
  控制组正确翻成失败。

修复后同一份真实探测：`免费自检通过（2 项只读探测）。另有 3 项可按需真实调用…`。
门禁在 `test/provider-check.test.ts`，三份回执按上游原文写死在测试里（真密钥通过组、假密钥
控制组、404 对照组）。请求体也一并核对过：H3 自检提交体是
`{model:'MiniMax-H3', content:[{type:'text',…}], duration:4, resolution:'768P', ratio:'16:9'}`，
即该模型能力表允许的最短时长与最低分辨率档——§7.4 剩下的「计费成功响应体字段」仍需一次真实
提交才能收口，那一步会计费，须用户逐条确认。

## 8. 后续实施顺序

### P0：先让视频节点不再产生非法状态（已完成）

1. 修复未选模型状态；
2. 建立共享 `resolveVideoMode`；
3. 图片/视频/音频输入变化时重算模式，并过滤非法下拉项；
4. 修复 browserMock provider identity，增加 H3/H3-Max/Seedance fixture；
5. 目前已覆盖空态与 1 图→多参/首帧收敛；2 图、参考视频、参考音频的浏览器场景仍纳入 P2 的逐节点关系审查。

### P1：按真实模型能力收口参数和请求（进行中）

1. ✅ profile 已有显式默认值、提示词上限和 H3 媒体体积/总量约束；
2. ✅ `test/video-gateway-wire.test.ts` 已覆盖当前 H3（官方 v2 `/v2/video_generation`）的首尾帧和
   多参 request fixture、任务状态归一化与 BaseURL 拼接口径，以及 Seedance 官方/兼容网关的字段
   隔离；若改为接入 Hailuo 2.3 / 02 的 `/v1/video_generation`，必须新建独立适配器，不能复用
   v2 的 `content[]` 路径；
3. ✅ H3-Max 的禁止 reference 已有 capability/UI 回归；
4. ✅ Seedance 官方方舟和兼容网关两套 adapter wire fixture 已补；真实请求成功/失败仍属于桌面端
   验收，不能由 mock fixture 替代；
5. ✅ configSchema 已声明 mode/params，并已更新生成的 Agent 契约。

### P2：全节点操作验收

按上表 23 个节点逐个执行：空态 → 配置 → 单输入 → 多输入 → 运行 → 成功/失败 → 保存重开。每个节点必须留下截图、输入/输出快照、运行记录和关系断言。

### P3：桌面端真实发布验收

使用本机已配置的 MiniMax/Seedance 供应商，执行真实成片、下载、入库、下游消费、重启恢复和取消；浏览器 mock 不能替代这一门禁。导演台依照既定安排，放在其它节点能力和真实连线全部稳定之后。

## 9. 单节点完成标准

一个节点只有同时满足以下条件，才可以标为“完成”：

- UI 所有矩阵状态无遮挡、无溢出、无伪状态；
- 输入/输出端口、Schema、必填性和基数与 capability registry 一致；
- 连线后卡片显示具体来源和顺序；
- executor 只消费声明端口，并写入正确的 `meta.nodeRun/meta.nodeResult`；
- `projectOutputs` 只在成功结果存在时暴露输出；
- 成功、失败、取消、重试和保存重开都有证据；
- 远程节点的 provider 请求与官方接口字段逐项对齐；
- 改动涉及协议时，`npm run agent:generate`、契约测试和全量 `npm run verify` 通过。
