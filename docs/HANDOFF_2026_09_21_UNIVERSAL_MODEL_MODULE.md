# Handoff：通用模型调用模块（2026-09-21）

## 本次交付

本次将模型接入从旧的“节点保存供应商/模型选择”模式，升级为可迁移的模型目录：

```text
节点 featureKey
  → 已验证的功能绑定
  → 模型定义与能力
  → 连接（密钥加密保存）
  → 协议适配器
```

已新增两个独立工作区包：

- `packages/model-contracts`：连接、模型、能力、验证、功能绑定的共享 Zod 契约。
- `packages/model-runtime`：只允许解析“已验证绑定”的运行时门禁与适配器端口。

主进程新增 SQLite 模型目录、HTTP 验证适配器、IPC 通道和与现有网关的执行桥接。模型目录数据保存在独立的 `model_*` 表中，不迁移、不读取旧 `providers` 表。

## 用户可见流程

模型设置入口已统一打开“添加模型”面板，不再把用户带到旧供应商表单。

用户流程为：

1. 填写服务商连接（名称、协议、API 地址、API Key）。
2. 选择“用于什么”，例如图片生成、视频生成、语音合成；填写模型 ID。
3. 点击“验证并启用”。该操作会发起一次明确确认过的最低成本真实调用。
4. 验证成功后，系统自动把模型绑定到对应功能键，节点可见且可执行。

“用于什么”会自动映射到稳定功能键，例如：

| 用途     | 功能键              | 操作                |
| -------- | ------------------- | ------------------- |
| 图片生成 | `image.generate`    | `image.generate`    |
| 图片编辑 | `image.edit`        | `image.edit`        |
| 视频生成 | `video.generate`    | `video.generate`    |
| 语音合成 | `speech.synthesize` | `speech.synthesize` |
| 语音克隆 | `voice.clone`       | `voice.clone`       |
| 音色设计 | `voice.design`      | `voice.design`      |

文本能力可按对话、文本处理或剧本拆解分别绑定；添加时选择的用途以模型元数据保存，后续“验证并启用”不会擅自换用途。

## 覆盖的协议与能力

连接协议：OpenAI、OpenAI Compatible/中转站、OpenRouter、Google、Anthropic、MiniMax、火山引擎/豆包、ToAPIs 与自定义协议。

能力操作：文本生成/嵌入、图像生成/编辑、视频生成、语音合成/识别、语音克隆与音色设计。

异步能力的领域操作已包含视频、语音克隆和音色设计；真实供应商的任务提交与轮询仍复用既有网关执行器。

## 关键入口

| 位置                                             | 责任                           |
| ------------------------------------------------ | ------------------------------ |
| `packages/model-contracts`                       | 跨产品可复用的模型目录契约     |
| `packages/model-runtime`                         | 验证状态门禁、端口与运行时解析 |
| `src/main/model-host/sqlite-model-host.ts`       | SQLite 模型目录与密钥隔离      |
| `src/main/model-host/http-validation-adapter.ts` | 协议级真实调用验证             |
| `src/main/ipc/models.ipc.ts`                     | 安全 IPC 边界                  |
| `src/renderer/src/gateway/ModelCatalogPanel.tsx` | 用户添加、验证和启用模型的流程 |
| `src/shared/engine/models.ts`                    | 执行器的 featureKey 解析       |

更完整的架构和跨产品接入说明见 [UNIVERSAL_MODEL_MODULE_PLAYBOOK.md](./UNIVERSAL_MODEL_MODULE_PLAYBOOK.md)。

## 已验证

本次在 Windows 本地执行：

```text
pnpm typecheck:model
pnpm typecheck:node
pnpm typecheck:web
pnpm --filter @free-creation/model-runtime test
pnpm vitest run test/db-migrations.test.ts test/aiProcess.test.ts test/async-executors.test.ts test/executors-shared.test.ts test/image-edit.test.ts test/speech-config.test.ts test/tts-config.test.ts test/voice-protocol-wire.test.ts test/node-ui-decisions.test.ts --maxWorkers=2 --minWorkers=1
pnpm build
pnpm start
```

结果：类型检查通过；模型运行时测试通过；相关 9 个测试文件、207 项断言通过；Electron 生产构建和主进程启动通过。

## 后续建议

1. 将剩余图像、视频、语音节点中的旧供应商/模型下拉逐步替换为 `FeatureProfileSelect`。当前执行器已优先按功能键解析，UI 仍有部分历史控件需要统一，以彻底消除“下拉看似影响实际调用”的歧义。
2. 给 `model_validations` 增加验证有效期和重新验证提醒，避免密钥失效或账户余额变化后仍长期视为可用。
3. 为模型目录补充渲染层交互测试：空连接、验证失败、验证成功、绑定覆盖、长 URL 与小窗口。
4. 旧 `ProviderSettingsPanel` 已从应用入口移除；在确认没有其他调用方依赖后，可在后续清理该历史实现和旧网关表。

## 安全边界

- API Key 仅在主进程加密保存，渲染层、节点配置、项目导出和运行记录不得保存明文。
- 验证和绑定均检查准确的 `(connectionId, modelDefinitionId, operation)` 组合。
- 验证前必须经用户确认；它可能产生供应商费用。
- 运行时拒绝未验证、未绑定或已禁用的模型，不静默回退到其他供应商。
