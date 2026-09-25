# 节点数据流与代码节点用法

本文用用户视角说明常见节点各自负责什么，以及端口传值的形态。完整的机器契约仍以
[`NODE_CONTRACT_SPEC.md`](../NODE_CONTRACT_SPEC.md) 为准。

## 常见节点怎么选

| 节点     | 主要用途                                                 | 什么时候选它                         |
| -------- | -------------------------------------------------------- | ------------------------------------ |
| 数据处理 | 透传一个值、从 JSON 取字段、把值套进文本模板             | 只需要简单转换，想用表单操作         |
| JSON     | 解析或格式化通用 JSON，方便查看和手工编辑                | 数据结构还没有专用 Schema            |
| 结构数据 | 编辑 JSON 模板、替换连线占位符，并按 Schema 校验         | 下游要求稳定字段和数据格式           |
| 分镜板   | 编辑 `shots` 列表，并输出完整分镜 JSON 与摘要            | 内容是一组镜头，需要逐行管理         |
| 代码     | 用 JavaScript 完成自定义转换，或把多项处理合在一个函数中 | 表单节点表达不了，且用户愿意维护代码 |

数据处理和 JSON 节点能做的转换，大多也能用代码实现。例如 `JSON.parse(args.text)` 可以解析文本，
`return args.json[0].title` 可以取字段。不过专用节点保留了可视化编辑、错误提示和 Schema 校验，
一般操作优先用专用节点；遇到复杂逻辑时再用代码。代码节点不会让一个普通 JSON 节点自动变成
“按任意业务结构编辑”的界面。

JSON 节点的取值顺序是：有上游 JSON 时优先用 JSON；没有 JSON 时才解析 `in-text`；两类都没有时
使用节点内已编辑的 JSON 正文。JSON 与文本同时连接时，文本不会参与本次运行。

## “多值”与“数组”是两回事

- 一条 JSON 连线可以传对象，也可以传数组。比如 `[1, 2]` 是**一个** JSON 值。
- 输入端口设为 `many`，表示可以接多条连线；运行器按保存的连线顺序保留输入数据包。JSON 和媒体输入按序组成数组，单个 JSON 数组仍保持为其中一项；多值文本输入则按 `\n$$$\n` 合并成一个字符串。
- 图片、视频、音频和文件端口传的是资产引用（类型、资产 ID、路径和 MIME），不是像素或二进制。
- 多张图片连到生图节点的 `in-images` 后，执行器得到的是有序图片引用数组；这时不必先把图片伪装成 JSON。图片拆分的 `out-images` 是一条 JSON 列表，每个条目都带有 `kind: "image"` 和图片资产引用，可连接到循环的 `in-list`；再把循环的 `out-item` 接到图片端口，就会在每轮传入当前那张图片。普通列表条目仍作为 JSON 传递。
- 一个输出端口可以连到多个下游。输入端口的 `many` 不控制输出能连几条线。

## 代码节点的输入和输出

代码在本地 Web Worker 运行。Coze 风格入口如下：

```js
async function main(args) {
  return { caption: args.shot.scene, length: args.shot.duration }
}
```

输入侧固定的便捷字段：

- `args.text`：`in-text` 收到的文本合并成一个字符串。
- `args.json`：`in-json` 收到的 JSON 值列表。若其中一项本身是 JSON 数组，列表里该项仍是一个数组。
- `args.images`、`args.videos`、`args.audios`、`args.files`：所有媒体输入的资产引用列表；每项是 `{ kind, mediaId, mediaPath, mime }`，不是媒体二进制。
- 在输入参数表中声明的字段：例如 `shot: object / one` 生成 `args.shot`；`references: image / many` 生成
  `args.references` 图片引用数组。`many` 每个值一项，即使某项 JSON 本身又是数组，也不会自动压平。
- `camera / one` 参数传入的是符合 `previs.camera@1` 的机位对象；多值机位参数会成为机位对象数组。

输出侧：

- 单输出兼容模式把 `return` 的值写到一个命名端口，并按配置类型检查。
- 多输出模式中，配置表的每一行对应一个独立端口。代码返回对象的同名字段会映射到该端口；
  例如声明 `caption: string` 和 `length: number`，就返回 `{ caption: "...", length: 3 }`。
- 同类型字段可以有多个端口，因为它们是不同的函数字段；其它节点仍使用 `many` 输入口承接多条同类连线。
- `camera` 输出字段必须返回符合 `previs.camera@1` 的对象，之后可连到 3D 预演台的机位输入。
- 图片等媒体输出必须引用本节点实际收到的资产。代码节点不能读取图片像素或凭空创建文件；
  要编辑媒体时请使用对应媒体节点。

代码 Worker 不提供 Node/Electron API、动态模块或网络访问。代码只处理传入数据，工具库 `_` 和 `dayjs`
是离线轻量实现。

这个输入输出模型和 Coze 开源工作流的“命名字段映射”思路接近：Coze 节点以字段名接收输入 map、再返回字段名对应的输出 map；这里把代码节点参数和返回对象字段直接映射到有类型的画布端口。运行方式不同：Canvas Studio 代码使用本地 JavaScript Worker；Coze Studio 仓库提到其代码节点使用 Python 执行环境。可以沿用 Coze 的“先声明字段、再连线、代码按字段名取值”的操作习惯，但不能直接照搬语言、依赖库或执行环境。[Coze 工作流节点开发说明](https://github.com/coze-dev/coze-studio/wiki/11.-Add-new-workflow-node-types-%28backend%29) · [Coze Studio 仓库](https://github.com/coze-dev/coze-studio)

## 分镜板表格

分镜板按所有镜头对象中出现过的字段动态生成列。每行仍对应一个镜头；原始 JSON 的额外字段（例如
`camera` 或 `sound`）会保留并能编辑。`id` 是稳定内部键，显示但不可直接改。JSON 编辑入口仍可用于
一次性编辑整份数据。

## 循环与批处理

当前节点叫“循环”：把列表逐项送进循环体，等待当前项完成后再运行下一项；支持单项失败、重试和断点恢复。
这与 Coze 的“批处理”是不同运行模式：Coze 批处理按并发数分批运行整个处理体，循环则表达逐项控制流。
因此这里把顺序执行的节点称为“循环”；要加入并行批处理，应单独呈现并设置并发数、失败策略、取消行为和结果排序。
可参照 [Coze 批处理节点说明](https://docs.coze.cn/guides_batch_node) 和 [Coze Studio 复合节点实现说明](https://github.com/coze-dev/coze-studio/wiki/11.-Add-new-workflow-node-types-%28backend%29)。
