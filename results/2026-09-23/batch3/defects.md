# Canvas Studio 缺陷增量（batch3 · 本地/契约/真实媒体覆盖）

候选版本：53c738e · 2026-09-23 · 状态：OPEN（仅记录，未修改业务代码）

## 新记录

### N3-01 【测试缺口】Electron 原生文件对话框无法被 CDP/Playwright 文件选择器驱动（P1 记录）
- 触发条件 → 实际：点击资产中心「导入素材」后唤起 **OS 原生文件选择对话框**，该对话框非 DOM `<input type=file>`，
  Playwright `waitForEvent('filechooser')` 未触发，无法用脚本 `setFiles` 完成真实导入。
- 预期：受控环境能注入文件路径完成素材导入闭环。
- 影响：AS01/AS02/AS03/AS05 与 E2E 的「导入素材→预览→重开」真实 UI 闭环暂无法自动化；相关证据依赖手工/用户操作。
- 建议：改用 Electron `webContents` IPC 层注入临时文件路径，或以 mock 图片导入 + 真实重开验证拆分验证（现有 `image-transform-real`、
  `media-index.test.ts` 已覆盖后端写入与检索，UI 层留待手工或授权范围）。

### N3-02 【覆盖边界】DOCX/XLSX/PPTX 真实导入未闭环（P1，继承 batch0 B5）
- document-text.test.ts（10 例）覆盖 UTF-8/GB18030/MD/CSV/可解析 PDF/坏 PDF 诊断；二进制 DOCX/XLSX/PPTX 仍由
  batch0 `media-import-real.test.ts` B5（期望 5 字段实际 4）记录，属既有差异，未在本批重复处理。

## 状态汇总
- 本批新增 600+ 契约/执行器用例 + 真实 FFmpeg 媒体用例 PASS；未发现新产品回归。
- 受控桌面已在 AS 之外完成批量 P0 本地验证（batch2）；本批因原生对话框限制，资产真实导入交手工/授权。
- 基线缺陷（batch0 A–C）保持。