# 通用模型调用模块：可迁移架构实践手册

> 适用场景：本地桌面产品、Web 产品或服务端产品需要同时接入文本、图像、视频、语音合成、语音复刻与音色设计模型；同一产品内不同功能可使用不同供应商和模型。

## 1. 要解决的问题

模型调用不能以“某个节点直接保存供应商 ID、模型 ID 和 API Key”的方式扩展。该做法会让每个产品、每个节点各自维护协议差异、密钥、验证逻辑和故障状态；改换供应商时还会修改业务节点。

本项目采用的边界是：

```text
产品功能节点
  └─ 引用 featureKey（例如 image.generate）
       └─ 模型目录的功能绑定（FeatureBinding）
            └─ 已验证的模型定义（ModelDefinition + Capability）
                 └─ 已加密密钥的连接（Connection）
                      └─ 协议适配器（Adapter）
                           └─ 供应商 API
```

节点只表达“我需要什么能力”，模型目录表达“用哪个已验证实例实现该能力”。这使节点、产品和供应商接入彼此解耦。

## 2. 四个稳定领域对象

### Connection（连接）

保存可安全复用的连接事实：协议、Base URL、请求头、启用状态和加密后的密钥引用。一个连接对应一个供应商账户或中转站实例，不应该承担业务功能名称。

当前协议枚举覆盖：`openai-compatible`、`openai`、`openrouter`、`google`、`anthropic`、`minimax`、`volcengine`、`toapis` 与 `custom`。

### ModelDefinition（模型定义）

保存连接下的模型 ID、展示名和能力声明。一个模型可声明多个 `Capability`，例如 `text.generate`、`image.generate`、`image.edit`、`video.generate`、`speech.synthesize`、`voice.clone`、`voice.design`。

不要用模型名猜能力；能力是显式数据。中转站把不同厂商模型以同一种协议暴露时，这一点尤其重要。

### ModelValidation（验证记录）

验证必须以三元组为粒度：

```text
(connectionId, modelDefinitionId, operation)
```

同一模型“可聊天”并不代表它“可生图”或“可生成视频”。验证由协议适配器发起最低成本的真实请求，记录结果、时间、提示信息和必要动作。只有状态为 `verified` 的能力可以建立或解析功能绑定。

### FeatureBinding（功能绑定）

功能绑定是业务产品唯一需要引用的模型配置：

```ts
{
  featureKey: 'storyboard.image.generate',
  target: {
    connectionId: 'toapis-production',
    modelId: 'gpt-image-1',
    operation: 'image.generate'
  },
  enabled: true
}
```

`featureKey` 是产品自己的稳定语义，不是供应商名，不是模型名，也不是 URL。一个产品可以有多个不同粒度的键，例如 `image.draft`、`image.quality`、`video.preview`、`video.final`，让每个节点按质量、价格和速度引用不同档案。

## 3. 本项目的落点

| 层级       | 当前位置                                         | 职责                                                                               |
| ---------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 共享契约   | `packages/model-contracts`                       | Zod 契约、操作枚举、验证与绑定结构                                                 |
| 运行时     | `packages/model-runtime`                         | 只解析已验证绑定；不允许绕过验证直接执行                                           |
| 持久化     | `src/main/model-host/sqlite-model-host.ts`       | SQLite 目录 CRUD、加密密钥、绑定前二次校验                                         |
| 供应商协议 | `src/main/model-host/http-validation-adapter.ts` | OpenAI 兼容、OpenRouter、Google、Anthropic、MiniMax、火山、ToAPIs 与自定义协议验证 |
| 进程边界   | `src/main/ipc/models.ipc.ts`                     | 渲染层只能经 IPC 管理和解析目录                                                    |
| 执行器     | `src/shared/engine/executors/*`                  | 按 `featureKey + operation` 解析已验证模型，再发起业务调用                         |
| 配置入口   | `src/renderer/src/gateway/ModelCatalogPanel.tsx` | 建连接、登记能力、付费确认后验证、建立功能绑定                                     |

密钥永远留在主进程与本地数据库加密域中。渲染层只获得连接是否有密钥、验证状态和可执行模型摘要；项目导入导出不能携带 API Key。

## 4. 新产品接入步骤

1. **定义功能键，而不是选择供应商。**
   先为产品能力命名，如 `article.draft`、`avatar.image.final`、`narration.synthesize`。
2. **给功能键指定操作。**
   例如图像生成只能绑定 `image.generate`，音色设计只能绑定 `voice.design`。
3. **在模型目录登记连接和模型能力。**
   连接可被多个模型定义复用；模型可被多个功能键引用。
4. **执行一次真实验证。**
   低成本验证也可能收费，界面必须明确确认。未验证、失败或禁用的能力不得被绑定。
5. **在节点配置中只保存 `featureKey`。**
   业务参数（提示词、尺寸、风格、时长、音色）仍保存在节点配置；供应商、密钥和原始模型 ID 不应进入产品工作流。
6. **执行时解析并审计。**
   运行时调用 `resolveBinding(featureKey, operation)`；解析不到已验证记录时以明确的“未绑定/未验证”状态跳过或失败，绝不静默换成其他供应商。

## 5. 适配器设计准则

每个供应商适配器只负责协议差异，不负责产品业务语义。建议统一实现以下职责：

- `validate`：按操作构造最小真实请求，归一化认证、限流、余额与参数错误；
- `execute`：把标准化请求转换为供应商请求，返回标准化的同步结果或异步任务引用；
- `poll/cancel`：仅为异步操作实现，如视频、语音复刻、音色设计；
- `normalizeError`：将 HTTP/供应商错误转成可展示、可重试、可审计的错误；
- `capabilities`：只声明有文档和验证支撑的控制项，不能根据模型名称臆测。

对于 OpenAI 兼容中转站，应当把协议标记为 `openai-compatible`，但仍对每个模型、每个 operation 单独验证。兼容协议不等于兼容全部端点或参数。

## 6. 失败与安全边界

- 绑定时再次检查验证状态，避免前端状态过期或伪造 IPC 参数；
- 解析时再次检查验证状态，避免禁用或失败的模型继续执行；
- 真实验证必须经用户确认，因为它可能计费；
- 验证记录需要保存时间。生产产品应配置有效期，到期后要求重新验证；
- 异步任务保存供应商任务 ID、提交参数摘要、状态与错误，不保存密钥；
- 不把 API Key 写入节点 JSON、工作流文件、日志、截图或导出包；
- 自定义协议只能通过受限的适配器配置扩展，不能把任意请求脚本暴露给节点。

## 7. 上线验收清单

发布前每项都应满足：

- [ ] 每个可调用节点都只呈现“模型档案/功能键”选择，不再呈现会误导调用结果的供应商或模型下拉；
- [ ] 节点配置解析和序列化均保留 `featureKey`；
- [ ] 所有执行器都走 `resolveBinding(featureKey, operation)`，生产路径没有按模型列表默认回退；
- [ ] 每个绑定目标都有完全匹配的 `verified` 验证记录；
- [ ] 图像、视频、语音等异步操作覆盖提交、轮询、超时、取消和恢复；
- [ ] 密钥加密、IPC 边界、项目导入导出与错误脱敏通过测试；
- [ ] 类型检查、契约测试、运行时测试和打包验证通过；
- [ ] 发布方式、版本号、变更说明和回滚产物已准备。

## 8. 当前项目的发布前缺口（2026-09-21）

模型目录、验证门禁、IPC 解析和多数执行器已接入功能键解析。但 UI 改造尚未完成：AI 处理节点已经使用 `FeatureProfileSelect`，图像生成、图像编辑、视频、语音合成、语音复刻与音色设计等节点仍保留旧供应商/模型下拉。它们在新的执行路径中不应继续决定最终调用目标。

因此当前版本**不应发布到线上**。下一阶段应先统一节点控件与配置保存逻辑，再做端到端验证和打包发布。该结论不是旧数据兼容问题，而是避免用户界面与实际模型解析结果不一致。
