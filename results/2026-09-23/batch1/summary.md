# Canvas Studio 测试批次报告（batch1 · 夹具就绪 + node-matrix 根因定界）

- 候选版本：53c738e
- 系统：Windows / Electron 39.8.10 / node v24.11.0
- 日期：2026-09-23
- 状态：夹具与受控桌面验证完成；node-matrix 失败归类为**审计脚本过时，非产品回归**。

## 一、qa-fixtures 夹具与 manifest

`qa-fixtures/manifest.json` 已生成，逐文件记录大小 + SHA256 + 媒体元数据（尺寸/时长/帧率/编码）。
仅本地生成，无远程依赖、无密钥。

| 代号 | 文件 | 规格 | 用途 |
|---|---|---|---|
| T-A/T-B/T-SAME | text/*.txt | UTF-8，来源唯一标记 / 内容均 SAME | 来源去重与顺序 |
| T-LONG | text/T-LONG.txt | 10056 字，中英混排/换行/emoji/引号，首中尾唯一标记 | 截断/输入法/存储 |
| I-W | media/images/I-W.png | 1600×900 四象限红绿蓝黄 | 裁剪、16:9 |
| I-P/I-A | media/images/I-P.png, I-A.png | 900×1600 竖图；带透明通道 PNG | 变形、透明度 |
| I-GRID/I-GRID2 | media/images/I-GRID.png, I-GRID2.png | 1800×1200 2行3列标 A–F；1601×901 | 拆分顺序/余数 |
| I-BAD | media/bad/*.png | 零字节/损坏(0xA5×100)/JPEG 伪装成 PNG | 坏文件处理 |
| V-AV | media/video/V-AV.mp4 | 10s/30fps/1280×720 逐秒烧录 SEC#，880Hz 音轨 | 抽帧/裁剪/同步 |
| V-SILENT | media/video/V-SILENT.mp4 | 同规格无音轨 | 无声处理 |
| V-WEBM/V-PORTRAIT | media/video/*.webm, V-PORTRAIT.mp4 | VP9 WebM；720×1280 竖屏 | 格式/竖屏覆盖 |
| A-SPEECH/A-MIX | media/audio/*.wav | 10s 合成语音参考；语音+噪声混合 | 克隆/分离参考（机器合成） |
| DOC | media/doc/* | UTF-8 / GB18030 文本、CSV、MD、**可解析 PDF**（unpdf 提取出唯一标记，见下） | 文件正文提取 |
| J-OBJ/J-LIST/J-SHOTS | json/*.json | 对象假值/数组批量/分镜结构 | 数据与解析 |

**PDF 有效性验证**：用项目同款 `getDocumentProxy(...,{useSystemFonts:false,verbosity:0})` + `extractText` 解析
`DOC.pdf`，成功提取 `DOC_PDF_MARKER_8B4C text extraction test`。`A-MIX` 的 amix `a=0` 选项在当前 ffmpeg 已移除，
已改为 `duration=first`。

**未生成的二进制 DOC（DOCX/XLSX/PPTX）**：由既有 `test/media-import-real.test.ts` 覆盖（batch0 失败项 B5，
见 defects.md），本轮不另造重复夹具。视频/音频为可解析产物，非真实人声。

## 二、node-matrix 失败根因（定界完成）

`npm run test:node-matrix` 的「添加文本/JSON/处理/分镜板/结构数据节点」30s 超时，根因分析：

- 源码 `src/renderer/src/canvas/CanvasEditor.tsx:1728-1794`：节点创建入口已改为**两级调色板**——
  一级分类（`展开${meta.label}节点`，aria-label，见 `palette-categories.ts` PALETTE_CATEGORY_META），
  二级抽屉 `.palette-node-flyout`（`aria-label=添加${t.label}节点`）仅在分类被展开后才渲染。
- 审计脚本 `scripts/audit-node-operation-matrix.cjs:296` 直接 `getByRole('button',{name:'添加${label}节点'})`，
  **从未展开分类** → 抽屉未渲染 → DOM 不存在 → 30s 超时。脚本中也无任何 `.palette-category-item`
  /`.palette-node-flyout`/`aria-expanded` 引用。
- 受控桌面验证（隔离 `CANVAS_DATA_DIR` + `--remote-debugging-port=9223`，Playwright connectOverCDP）：
  - 新建项目进入画布：✅（需先填项目名，确认按钮为「创建」）
  - 一级分类呈现：常用 / 文本与 AI / 图片创作 / 视频创作 / 声音创作 / 流程与高级 ✅
  - 展开「文本与 AI」抽屉：文本 / 文件 / AI 对话 / AI 处理 ✅
  - 点击「添加文本节点」：`.type-text` 卡片 0→1，新卡提示「双击输入文本」✅

**结论**：产品多级创建入口在真实桌面可用；`test:node-matrix` 失败属**测试脚本过期**（未适配两级调色板），
**非产品回归**。修复方向：审计脚本先点击目标分类再点节点；或按入口分「分类/节点」两级遍历。

> 证据说明：CDP 截图受 Electron 字体栅格化等待阻塞（locator/page screenshot 均超时），故本次以 DOM
> 断言为通过依据（新建项目、分类展开、抽屉节点名、添加节点数 0→1、新卡提示语），证据脚本在
> `qa/test-data/drive*.cjs`。

## 三、受影响文件与后续批次

- 本轮未修改任何业务代码。
- batch1 与 batch0 结论一致：自动门禁基线不绿（lint 7 错、单测 13 失败），详见 batch0/defects.md。
- 后续：对每个可创建节点执行通用 C01–C12 + 专属 S（本地）用例，及跨模块 REF/UI/AS/DATA/ENG/MD P0 回归；
  远程付费项保持 BLOCKED（缺图片/视频/文本凭据与预算）。