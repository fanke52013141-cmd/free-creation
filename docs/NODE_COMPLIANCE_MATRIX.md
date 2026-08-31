# 节点合规矩阵

> 审计基线：`f519ac3` · 2026-08-31。详细审计、连线关系和参考项目差异见 [NODE_PROTOCOL_AUDIT_2026_08_31.md](./NODE_PROTOCOL_AUDIT_2026_08_31.md)。

本表是当前 **23 个可创建节点** 的发布前协议索引。新增或修改节点前必须同步更新本表、`NODE_CONTRACT_SPEC.md`、契约快照与连线测试；脚本节点仅为历史兼容，不进入创建菜单。

| 节点                      | 版本 | 输入端口（类型 / 基数）                                      | 输出端口（类型 / Schema）                                               | 执行与投影                               | 结论 |
| ------------------------- | ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------- | ---- |
| 文本 `text`               | 2    | `in-text` text / many                                        | `out-text` text                                                         | executor + projectOutputs                | 通过 |
| 图片资产 `image`          | 1    | 无                                                           | `out-image` image                                                       | executor + projectOutputs                | 通过 |
| 图片裁剪 `image-crop`     | 1    | `in-image` image / one / 必填                                | `out-image` image                                                       | executor + projectOutputs                | 通过 |
| 图片拆分 `image-split`    | 1    | `in-image` image / one / 必填                                | `out-image` image；`out-images` json `list.items@1`                     | executor + projectOutputs                | 通过 |
| 图片生成 `image-gen`      | 2    | 图片单张/多参考图、提示词包 JSON、文本多输入                 | `out-image` image                                                       | executor + projectOutputs                | 通过 |
| 图片编辑 `image-edit`     | 1    | `in-image` image / one / 必填；`in-text` text / many         | `out-image` image                                                       | executor + projectOutputs                | 通过 |
| 视频生成 `video`          | 3    | 首帧、尾帧、参考图/视频/音频、提示词包、文本                 | `out-video` video                                                       | executor + projectOutputs                | 通过 |
| 视频取帧 `video-frame`    | 2    | `in-video` video / one / 必填                                | `out-image` image                                                       | executor + projectOutputs                | 通过 |
| 视频截取 `video-clip`     | 2    | `in-video` video / one / 必填                                | `out-video` video                                                       | executor + projectOutputs                | 通过 |
| 视频提音 `video-audio`    | 2    | `in-video` video / one / 必填                                | `out-audio` audio                                                       | executor + projectOutputs                | 通过 |
| 人声分离 `vocal-separate` | 2    | `in-audio` audio / one / 必填                                | `out-vocals` audio；`out-accompaniment` audio（可选）                   | executor + projectOutputs                | 通过 |
| 音频资产 `audio`          | 2    | `in-audio` audio / one / 可选                                | `out-audio` audio                                                       | executor + projectOutputs                | 通过 |
| 语音合成 `speech`         | 1    | `in-text` text / many                                        | `out-audio` audio                                                       | executor + projectOutputs                | 通过 |
| 声音克隆 `tts`            | 1    | `in-audio` audio / one；`in-text` text / many                | `out-audio` audio                                                       | executor + projectOutputs                | 通过 |
| 对话 `chat`               | 1    | `in-text` text / many                                        | `out-markdown` markdown                                                 | executor + projectOutputs                | 通过 |
| 处理 `processor`          | 1    | `in-data` any / many                                         | `out-data` any                                                          | executor + projectOutputs                | 通过 |
| JSON `json`               | 1    | `in-json` json `json.any@1` / many；`in-text` text / many    | `out-json` json `json.any@1`                                            | executor + projectOutputs                | 通过 |
| 结构数据 `structured`     | 1    | `in-context` json `json.any@1` / many；`in-text` text / many | 动态 `out-json`（实例 Schema）                                          | executor + projectOutputs + resolvePorts | 通过 |
| 代码 `code`               | 2    | `in-text` text / many；`in-json` json `json.any@1` / many    | 动态输出端口（实例声明）                                                | executor + projectOutputs + resolvePorts | 通过 |
| 分镜 `storyboard`         | 1    | `in-json` json `storyboard.shots@1`；`in-text` text / many   | `out-json` json `storyboard.shots@1`；`out-text` text（可选）           | executor + projectOutputs                | 通过 |
| AI 处理 `ai-process`      | 1    | `in-text` text / many；`in-json` json `json.any@1` / many    | `out-text` / `out-markdown` / `out-json json.any@1`（互斥）             | executor + projectOutputs                | 通过 |
| 循环 `iterate`            | 1    | `in-list` json `list.items@1` / one / 必填                   | `out-item` json `json.any@1`（循环体）；`out-items` json `list.items@1` | executor + projectOutputs                | 通过 |
| 导演台 `director`         | 2    | 分镜 JSON、参考图多输入、机位 JSON                           | 帧、预演视频、机位、工程摘要                                            | manual-publish + projectOutputs          | 通过 |

## 自动门禁

- `test/node-compliance.test.ts`：Active/Legacy 类型、executor、投影、版本、说明与创建菜单分类。
- `test/node-contract-snapshot.test.ts`：所有可创建节点（含 `vocal-separate`）的注册、端口命名、Schema 与关键契约快照。
- `test/connection-matrix.test.ts`：端口类型兼容/拒绝矩阵和代表性工作流。
- `npm run verify`：本项目发布前的统一自动验证命令。

## 历史节点

| 类型               | 状态    | 约束                                 |
| ------------------ | ------- | ------------------------------------ |
| `script`           | Legacy  | 可读取历史数据但 `creatable=false`。 |
| `group`、`compose` | Retired | 不注册、不创建、不参与连线。         |
