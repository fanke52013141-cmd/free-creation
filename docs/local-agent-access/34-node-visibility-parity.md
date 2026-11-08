# 节点可见集在三入口不一致：CLI/MCP 创建的项目默认少了 8 类节点（已修）

日期：2026-11-08。发现方式：用户在 GUI 里打开验收用的应用窗口，发现"图片创作节点和声音创作
节点好像缺失"。核对后确认这是**真实缺陷**，不是视觉错觉，也不是发票本裁剪导致。

## 1. 现象与根因

同一个业务动作「创建项目」，两个入口给出**不同的默认节点可见集**：

| 入口 | 默认预设 | 可见节点 |
| --- | --- | --- |
| GUI「新建项目」对话框（`ProjectCreateDialog`） | `all` | 全部 32 类可创建节点 |
| 外部 `project.create`（CLI/MCP） | `general`（`defaultWorkspaceProfile()`） | 只有 24 类常用节点 |

差异的 8 类正是用户注意到的：

- 图片创作相关：`image-crop`（裁剪）、`image-split`（拆分）
- 声音创作相关：`voice-design`（音色设计）
- 其他高级节点：`video-clip`（截取）、`video-depth`、`video-clay`、`director`（3D 预演台）、
  `ai-process`（AI 处理）

`CanvasEditor` 的调色板按 `workspaceProfile.visibleNodeTypeIds` 过滤，所以用 CLI 建的项目
（验收脚本、Agent 建画布都用这条路径）在 GUI 里打开时，这 8 类节点的**新建入口不存在**——
用户看到的就是"节点缺失"。节点协议、执行器、外部操作全部正常，缺的是可见集。

为什么不是发行版裁剪：`src/shared/edition.ts` 的 `DISTRIBUTION_HIDDEN_NODE_TYPES`
只在 `CANVAS_DISTRIBUTION=1` 构建时生效（常规 `npm run build` 下 `DISTRIBUTION_EDITION=false`），
且它隐藏的清单与本现象不同。本次看到的差异发生在默认预设层，与发行版无关。

## 2. 修复

- `src/shared/workspace-profile.ts` 新增 `allWorkspaceProfile()`：预设 `all`、可见集合 =
  全部 `ACTIVE_NODE_TYPE_IDS`（发行版构建时再叠加同一条裁剪清单）、带当前节点集版本号；
- `src/main/store/projects.repo.ts` 的 `createProject` 在**未显式传节点可见集**时改用
  `allWorkspaceProfile()`，与 GUI 新建项目对齐；
- `defaultWorkspaceProfile()`（`general` 24 类）保留原语义，仍用于"损坏/缺失配置的兜底"，
  不改变老项目已保存的可见集。

## 3. 验证

`test/local-agent-parity.test.ts` 新增回归用例（7 项全过）：

- 外部 `project.create` 成功后读回项目文件：`presetId === 'all'`、可见集**包含全部 32 类**
  Active 节点；
- 逐个断言此前缺失的 8 类（裁剪/拆分/截取/深度/白模/音色设计/导演台/AI 处理）都在默认可见集里；
- 既有 `project-profile-migration.test.ts`（老项目预设补齐/兜底语义）与
  全量接入测试保持通过。

## 4. 影响与边界

- **对已存在的老项目**：已保存的 `visibleNodeTypeIds` 不会被改写（只有新建项目受影响）。
  老项目若确实缺这些节点，可在 GUI「工作台节点设置」里勾选需要的节点；不需要手工改文件。
- **对验收脚本**：里程碑此前用 CLI 建的项目默认是 general，因此截图里调色板节点较少；
  修复后新跑的项目会与 GUI 一致。节点卡片渲染、执行、外部操作本身不受影响。
- **未做**：外部 `project.create` 仍未提供"显式指定可见集/预设"的入参（属新增可选字段，
  会改动既有操作 Schema，需单独走契约变更与兼容结论）；当前先对齐默认值。
- 发行版裁剪（`edition.ts`）仍是并行开发中的未提交改动，本修复只在默认预设层面与之叠加，
  没有改它的裁剪清单。
