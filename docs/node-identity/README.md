# 节点身份色 v2 与图标重绘 · 交付备注

- 日期：2026-11-02
- 范围：节点身份色（`NODE_ACCENTS`）、节点图标（`Icon.tsx` / 节点 spec `icon` 字段）、颜色与图标规范文档、图标契约测试
- 设计源与量化脚本：`design/2026-11-node-identity/`（设计工作区，不在本仓库内；副本见本目录 `plan-v1.md`、`palette-report.md`）
- 状态：代码、文档、测试、浏览器双主题验收均已完成并进入 `main`

## 1. 为什么改

原色板不是"颜色数量不够"，而是三个结构问题叠加：

1. **同族只调明度、不调色相**：声音族 5 个节点挤在 303–307°、L 0.63–0.83，同族 ΔE00 最低只有 4.2；视频族两个节点最低 3.3。
2. **跨族借色**：AI 族成员仍是玫红/橙，AIM 对话撞 input 粉、Agent/状态机/AI 审核撞 data 橙；状态机 `#D99647` 与数据处理 `#D99048` 的 ΔE00 只有 **2.1**，肉眼同色。
3. **图标共用**：33 个节点 ID 只有 27 个图标，`audio` 被声音族 5 个节点共用；状态机用通用流程图 `workflow`，AI 审核用动作语义的裸 `check`。

## 2. 颜色：从"族内微调"到"六族色相带 + 明度/色度阶梯"

### 2.1 结构性调整

| 调整 | 说明 |
| --- | --- |
| AI 与自动化整体迁青蓝带（182–214°） | 不再借 input 的粉、data 的橙；与视频蓝保持 ≥22° 色相间距 |
| 分镜板、3D 预演台迁入视频蓝带 | 兑现旧规范里"橙色 → 蓝色"的迁移承诺 |
| 橙色专属数据与代码 | 暖色族由 4 个减为 2 个（input 玫红 + data 橙） |
| 新增时间线 `#239AD3` | 按视频蓝带补算，满足同族/跨族 ΔE 与双主题对比度 |
| 白模 `#D1DAF6`、裁剪 `#ABE9CC` | 为通过浅色历史主题对比度门禁微调（暗色约束不变） |

### 2.2 量化结果（CIEDE2000，暗色 raw 色；对比度为 WCAG 相对亮度比）

| 指标 | 旧 | 新 |
| --- | --- | --- |
| 同族最小 ΔE00 | 3.3（视频截取 vs 深度视频） | **7.8**（视频素材 vs 抽帧） |
| 菜单相邻最小 ΔE00 | 3.8 | **10.4** |
| 跨族最小 ΔE00 | 2.1（状态机 vs 数据处理） | **7.8**（分镜板 vs 声音调整） |
| 身份色对卡片 `#20242A` 最低对比度 | 3.13:1 | **3.87:1**（可创建节点最低 3.94:1） |
| 浅色历史主题兜底（55% 混色） | — | 图标前景 ≥3.13:1、12% 底板 ≥3.38:1 |

完整 37 个节点的 HEX / OKLCH / 对比度见 `palette-report.md`。

## 3. 图标：11 个节点各用一张轮廓不同的图标

| 节点 | 旧图标 | 新图标 | 轮廓 |
| --- | --- | --- | --- |
| 音频 `audio` | `audio` | `audio` | 五柱声波（族锚点） |
| 声音调整 `sound-adjust` | `audio` | `sound-adjust` | 三根竖向推子 + 错高旋钮 |
| 人声分离 `vocal-separate` | `audio` | `vocal-separate` | 声波柱向右分叉两支 |
| 语音合成 `speech` | `mic` | `speech` | 麦克风 + 两条发射弧 |
| 语音克隆 `tts` | `audio` | `voice-clone` | 上下两条错位声波（回声） |
| 音色设计 `voice-design` | `audio` | `voice-design` | 声纹三弧 + 四角星（唯一 1.65 描边） |
| Agent `agent` | `spark` | `agent` | 机器人头 + 天线 + 实心眼点 |
| AI 处理 `ai-process` | `spark` | `ai-process` | 斜向魔杖 + 大小四角星 |
| AI 审核 `ai-review` | `check` | `ai-review` | 盾牌 + 对勾 |
| 状态机 `state-machine` | `workflow` | `state-machine` | 两个状态圆 + 带箭头迁移曲线 |
| 循环 `iterate` | `grid` | `iterate` | 三条递减横线 + 回绕箭头 |

`mic`、`spark`、`check`、`workflow`、`grid` 保留在 `ICON_NAMES` 中继续服务工具/动作语义，但不再被节点标题引用。

## 4. 涉及文件

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/nodes/registry.tsx` | `NODE_ACCENTS` 37 个值 + 色板注释 |
| `src/renderer/src/components/Icon.tsx` | 新增 10 个 `IconName`/`PATHS`；`voice-design` 默认 1.65 描边 |
| `src/renderer/src/nodes/specs/index.tsx` | 8 个节点 `icon` 字段 |
| `src/renderer/src/nodes/specs/agentFlow.tsx` | Agent / 状态机 / AI 审核的 `icon` |
| `docs/NODE_COLOR_SPEC.md` | 升 v1.4：六族色相带、37 节点分配表、验收口径、浅色混色标为历史残留 |
| `docs/UI_ICON_SYSTEM.md` | 升 v2：语义字典补 10 个图标，写清 `speech`/`mic`、`state-machine`/`workflow`、`ai-review`/`check` |
| `test/icon-system.test.ts` | 图标契约：11 个映射、声音 6 个/AI 5 个互不重复、节点图标都在 `ICON_NAMES` |
| `scripts/test-browser-node-colors.cjs` | 修正"无底板身份图标"被当成黑色背景的假失败 |

## 5. 验证

```
cd source
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
npx vitest run test/node-color-spec.test.ts test/icon-system.test.ts \
  test/registry.test.ts test/node-compliance.test.ts test/node-contract-snapshot.test.ts
node scripts/test-browser-node-colors.cjs        # 需 dev:browser
```

结果：

- 类型检查通过；
- 239 项 vitest 通过（颜色规范、图标、注册表、节点契约、契约快照）；
- 浏览器验收通过：32 个可创建节点 × 暗/浅双主题 + 6 组分类菜单 + 搜索 + 详情面板 + 项目弹窗 + 创建菜单，**最低对比度 3.16:1**，截图在 `qa/node-colors-<时间戳>/`；
- 色板复算脚本输出 `问题数: 0`。

视觉证据（`docs/assets/node-identity-v2/`）：

- `qa-all-nodes-dark.png` — 32 个可创建节点全景（暗色）
- `qa-voice-menu.png` — 声音创作 5 个节点并排（新图标 + 新紫色阶梯）
- `icons-review-voice-final.png` — 设计稿：6 个语音图标 × 新色板
- `icons-review-final.png` — 设计稿：图标整页预览
- `swatches.png` — 37 个身份色板审阅页

## 6. 已知边界与遗留

1. **完整 `npm run verify` 未在交付时执行**：交付窗口内工作区有并行改动（时间线节点），`npm run lint` 曾被并行会话的临时调试脚本阻塞；建议合并窗口后重跑一次。
2. **浅色主题当前未启用**（组件固定 `canvas-theme-dark`）。`ui-surfaces.css` 的 `.canvas-theme-light` 55% 混色属历史残留，若恢复浅色主题需改为逐节点显式浅色 token，不能复用该公式。
3. **跨族门槛按 7.5 执行**（原目标 12）：36+ 个节点、6 个色带无法同时满足，8 以下的跨族对已登记，并由图标轮廓与分类菜单位置兜底。
4. **视频族 9 个节点同属蓝带**是客观上限：色板负责"族 + 层级"，具体功能由图标轮廓区分。
5. 颜色只改值、不改节点 ID 与数据契约，旧项目重开后按 ID 自动继承新色，无需数据迁移。

## 7. 回滚

- 颜色：还原 `NODE_ACCENTS` 即可，无数据迁移；
- 图标：删除新增 `IconName`/`PATHS` 并改回节点 `icon` 字段；
- 无运行数据、日志或存储格式变化（日志影响：不涉及）。
