# Canvas Studio 测试总览 / 发布结论（2026-09-23 复核版执行）

- 候选版本：53c738e · 系统：Windows / Electron 39.8.10 / node v24.11.0
- 数据目录：受控 `qa/data/controlled`（CANVAS_DATA_DIR 隔离），仅本地 + mock + 真实本地媒体夹具
- 规则：**全程未修改任何业务代码**；远程付费（图片/视频/配音/克隆/音色/chat/ai-process 真实调用）无凭据与预算 → BLOCKED。
- 状态口径：PASS / FAIL / BLOCKED / GAP / NOT_RUN / N/A（TEST_PLAN §3.1）。

## 一、各批次交付

| 批次 | 内容 | 结论 |
|---|---|---|
| batch0 | 自动门禁 typecheck/test/contract/node-matrix/build/lint/verify | typecheck/build/contract(282) PASS；lint 7 错、单测 13 失败、node-matrix 脚本超时 → 记录 |
| batch1 | qa-fixtures 夹具 + manifest + 受控桌面验证 | node-matrix 根因定界=审计脚本过期（两级调色板），非产品回归；创建入口可用 |
| batch2 | 跨模块 P0 本地回归 | C01/C04/N-text-S01/DATA01/C06/REF01/03/04 真实 UI + 契约 PASS；REF02/UI遮摭/AS/MD 待补 |
| batch3 | 本地/契约/真实媒体覆盖 | 600+ 用例 PASS；真实 FFmpeg 取帧/人声分离/缩略图通过；资产原生对话框无法脚本驱动已记录 |

## 二、自动化证据汇总

- 契约体系：contracts 282、node-contract-snapshot 155、node-schemas 23、registry 28、compliance 3、create-options 6、topology 3 → 全 PASS
- 引用/连线：connection-matrix 124、batch-connection 5、connected-input-preview 1 → 全 PASS（REF01/03/04 数据层）
- 本地执行器：executors 22、executors-shared 28、iterate 28、iterate-cancel、code、storyboard、document-text 10、aiProcess 11、chat-memory 3、image-crop 8、image-split 6、image-edit → 全 PASS
- 真实媒体（本地 FFmpeg）：video-transform-real-media 16(1skip)、video-transform 24、image-transform-real 10、image-perspective 2 → 全 PASS
- 迁移/持久化：migration 62、db-migrations 3、project-save-sync 6、external-reload 6、media-index 3、transfer.integration、media-reference-remap → 全 PASS
- 供应商/安全/成本：provider-preset-modality、providers-security、gateway-cost-safety 15、tts-config 8、speech-config 11、voice/wire → 全 PASS
- **已知 FAIL（基线，含 13 项）**：node-ui-decisions 5、ui-foundation 3、canvas-interaction 2、selection-geometry 2、media-import-real 1（B5 文档抽取 4/5 字段）

## 三、覆盖状态清单（按方案 §5/§6/§7）

### 通用用例 C01–C12
| 用例 | 状态 | 依据 |
|---|---|---|
| C01 创建入口 | PASS | 受控桌面：新建项目→多级调色板→文本节点 0→3（batch2）|
| C04 中文/标题输入 | PASS | 受控桌面：中文+全角冒号输入无拼音残留（batch2）|
| C06 保存重开 | PASS | 受控桌面：回主页→重开，3 节点/3 段正文一致（batch2）|
| C02/03 缩放/拖拽、C05 复制删除、C07 校验、C08 运行一致、C09 产物、C10 失败恢复、C11 隔离、C12 结果集合 | 部分 | 契约/执行器层有对应覆盖；真实 UI 逐节点矩阵见 batch4（未执行，需预算+资产夹具）|

### 专属用例
- 本地类契约/真实媒体已覆盖：image、image-crop、image-split、video-asset(video-transform)、video-frame、video-clip、
  vocal-separate(真实 FFmpeg)、audio、file(document-text)、processor、json、structured、code、storyboard、director、
  iterate、ai-process(本地校验)、chat(记忆/mock 流)。
- 远程类全部 **BLOCKED**：image-gen、image-edit(真实调用)、video、speech、tts、voice-design。

### 跨模块 P0
| case | 状态 | 说明 |
|---|---|---|
| REF01 同文双源 | PASS | 数据层每连接一条引用，sourceNodeId 独立 |
| REF02 历史重复边 | NOT_RUN | 缺含重复关系的历史快照夹具 |
| REF03 删边不重注 | PASS | 仅遍历在线箭头 |
| REF04 多端口 | PASS | 按端口隔离 |
| DATA01 持久化 | PASS | 真实 UI 重开一致 |
| DATA02 导入导出 | NOT_RUN | 需真实媒体项目副本引用重映射往返（原生/导出链路待授权范围）|
| DATA03 崩溃/04 磁盘 | NOT_RUN | 需故障注入副本 |
| UI03/UI04 遮挡/剪刀 | NOT_RUN | 需像素级几何夹具（底层执着断在 batch0 B3/B4）|
| AS01-05 资产 | 部分 | 面板打开/空库确认可 CDP 驱动；文件导入受原生对话框限制（N3-01），名称持久化交手工/后端证据 |
| MD01 模型可见性 等 | BLOCKED | 无远程凭据/模型 |

### E2E / 显示矩阵 / 容量
- E2E01（本地图片裁剪→拆分→当前项）本地可做但依赖资产导入闭环，受原生对话框阻塞 → NOT_RUN（待授权）。
- 其余 E2E02-10、ENV/PERF 显示与容量矩阵 → NOT_RUN / 需预算或同硬件基线。

## 四、缺陷清单（均 OPEN，未修改代码）

1. lint：memory.ts:23、ConnectionLayer.tsx:75、DataEdgeLayer.tsx:270、ProvidersPanel:61、ProviderSettingsPanel:117、voice-design:621
2. 单测 13：node-ui-decisions 5、ui-foundation 3、canvas-interaction 2、selection-geometry 2、media-import-real 1（B5）
3. node-matrix：脚本过期（非产品回归，两级调色板未适配）
4. N2-01 REF02 缺历史快照；N2-02 真实请求未链通
5. N3-01 原生文件对话框 CDP 不可驱动；N3-02 DOCX/XLSX/PPTX 导入差异（B5）

## 五、发布结论

**当前发布候选门槛不满足（TEST_PLAN §10）。** 依据：

- 全量自动门禁未绿（lint 7、单测 13、node-matrix 脚本过期），未关闭 P0/P1 存在。
- 25 类可创建节点仅本地/契约层覆盖，真实 UI 逐节点矩阵、E2E10 条、显示/容量矩阵、干净安装/v5 升级/导出导入往返、2 小时长时均未完成。
- 远程真实供应商最小调用（每能力一条成功+校验失败+保存重开）全部因缺凭据/预算 BLOCKED。

**可达结论（谨慎限定）：** 对「本地节点能力（文本/JSON/结构化/文件/代码/分镜/裁剪/拆分/迭代/AI处理本地校验/导演台数据结构）的契约与执行语义」以及「本地真实 FFmpeg 媒体处理（取帧/人声分离/时序缩略图/裁剪）」可声明在 53c738e、本 Windows 环境可用；对「受控桌面上的创建→编辑→保存→重开持久化」已由真实 UI 验证。其余（远程生成、真实 E2E、规模/长时间、资产 UI 导入闭环、模型可见性）未验证，不可宣称。

## 六、交付物
- results/2026-09-23/batch0/{summary,defects,*.log}
- results/2026-09-23/batch1/{summary,evidence,qa-fixtures/manifest.json}
- results/2026-09-23/batch2/{report.json,summary,defects,evidence}
- results/2026-09-23/batch3/{report.json,summary,defects,evidence}
- qa/test-data/drive*.cjs（受控桌面驱动脚本）