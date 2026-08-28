# P2：结构化创作数据

P2 不用多个“角色节点”“场景节点”堆出各自的 UI。所有创作对象都通过同一个**结构数据**节点编辑、校验和传递；差异只由版本化 Schema 决定。

## 数据协议

| Schema                | 必填字段                    | 可选字段                                                              | 用途                   |
| --------------------- | --------------------------- | --------------------------------------------------------------------- | ---------------------- |
| `character.profile@1` | `id`、`name`、`description` | `appearance`、`persona`、`voice`、`tags`、`referenceImageIds`         | 人物设定与提示词上下文 |
| `scene.definition@1`  | `id`、`name`、`description` | `location`、`timeOfDay`、`mood`、`tags`、`referenceImageIds`          | 场景设定               |
| `shot.definition@1`   | `id`、`scene`               | `dialogue`、`sound`、`camera`、`duration`                             | 单条镜头，可组装为分镜 |
| `prompt.bundle@1`     | `prompt`                    | `negativePrompt`、`style`、`aspectRatio`、`seed`、`referenceImageIds` | 可追溯的生成提示词包   |

媒体只以 `referenceImageIds` 这类资产 ID 引用，绝不把图片二进制塞入 JSON 或连线。

## 结构数据节点

节点有两种输入：`in-context`（多条 JSON）和 `in-text`（多条文本），输出为所选 Schema 的 `out-json`。选择 Schema 后，右侧 I/O 面板会显示实际的 Schema ID 与版本。

正文是用户可编辑的 JSON。它可以显式引用输入：

```json
{
  "id": "scene-1",
  "name": "霓虹雨巷",
  "description": "{{input[0].name}} 穿行在雨夜街头"
}
```

`{{input[0].name}}` 只读取第一条接入 `in-context` 的数据；`{{text}}` 只读取 `in-text`。没有“自动找角色节点”“按标题猜输入”的隐藏规则。运行会把变量解析为实际值，并执行字段级校验；例如缺少 `description` 或 `seed` 不是数字都会失败且不输出。

## 内置模板

- **角色→场景→分镜**：角色、场景和镜头均使用结构数据节点，镜头再组装为 `storyboard.shots@1` 交给分镜板。
- **分镜→导演台**：通过 `storyboard.shots@1` 的明确端口把分镜板连接到导演台。
- **提示词包→生图**：通过 `prompt.bundle@1` 的 `in-prompt` 端口交给图片节点；视频节点也提供同名端口。当前图片/视频驱动读取 `prompt` 和 `style` 形成正向提示词，其余字段仍保留在结构数据中供后续能力驱动使用。

“分镜→批量生图”不会在 P2 假装可用。它依赖 P3 的每项独立运行态、暂停/恢复和下游子图边界；在此之前不把一个共享图片节点包装为“批量”模板，以免不同镜头覆盖同一媒体结果。

## 兼容策略

Schema ID 与 version 都是端口契约的一部分。未来新增字段且保持可选，可在同一版本内兼容；修改必填性、字段含义或数据形状时必须升级版本并提供迁移或拒绝策略。通用 `json.any@1` 可以作为显式适配输入，但运行时仍以目标 Schema 做字段级验证。
