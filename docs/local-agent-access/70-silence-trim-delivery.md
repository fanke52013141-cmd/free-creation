# 70：去气口节点（silence-trim@1）交付台账

2026-11-25 新增「音频语音」分类节点 `silence-trim@1`（去气口）：检测并剪掉音频中的静音
与呼吸气口，输出独立新音频资产。双引擎一步到位：`engine=silence`（FFmpeg silencedetect
能量阈值）与 `engine=vad`（Silero VAD v5 ONNX，MIT，模型随仓库 `resources/models/`
经 files 白名单分发，`onnxruntime-node` 进程内推理）。

## 动作与外部路径（铁律 §4 口径）

| 动作 | GUI 入口 | CLI / MCP 路径 | 证据等级 |
| --- | --- | --- | --- |
| 去气口节点执行 | 节点运行按钮（公共执行器） | `node.execute`（同 executor） | 仅接线 + 服务级测试（真实 ffmpeg/模型由 `test/silence-trim-media.test.ts` 覆盖，桌面逐动作实测待办） |
| 正式产物读取 | 产物卡片 / 资产面板 | `output.get`（投影 `out-audio`） | 服务级测试（`test/silence-trim-node.test.ts` 投影用例） |
| 类型契约查询 | 右侧详情面板 | `node.type.get` / `node.type.list` | 契约快照漂移门禁（`test/node-contracts-export.test.ts`） |

无新增 operationId：与 sound-adjust 同构，走通用 `node.execute` + `output.get`；
`action-coverage.json` 新增 `ipc.media.silenceTrim` 条目（phase=external）。

## 契约与登记清单

- `ActiveNodeTypeId` + `NODE_ACCESS_DECLARATIONS` + `NODE_TABLE`（media 族，N5/N6 如实为
  contract-tested、桌面实测待办）+ `DETERMINISTIC_OUTPUT_SOURCES['silence-trim']='run'`。
- 机器真值快照已重新生成：`docs/local-agent-access/generated/contracts.json`、
  `src/shared/agent-access/generated/node-contracts.generated.ts`、`change-impact.json`
  （兼容结论：新增节点，不改既有契约，无兼容性破坏）。
- IPC 通道 `media:silence-trim`；错误码 `SILENCE_TRIM_FAILED`；取消沿用
  `MEDIA_TRANSFORM_CANCELLED` / `media:cancel-transforms` 作用域。

## 未覆盖边界（如实）

- 真实 Electron 桌面逐动作实测（node.execute 经外部入口跑去气口节点）未做，
  N5 证据为服务级 + 真实二进制测试，不宣称 desktop-tested。
- onnxruntime-node 的发行包（electron-builder 依赖收集）打包验证未跑；
  开发态已实测加载与会话创建。
- 真实语音的 VAD 裁剪听感验收（边距/中心保留参数的音质取舍）待用户桌面试听确认。
- `test/r09-soak-runner.test.ts`（R09 长时压测，spawn Electron worker）在整仓全量
  串行跑时出现环境性抖动（worker-init 失败 / 1925 轮后 Windows 文件锁 EPERM），
  单独运行 9/9 稳定通过；与本次节点改动无关，属既有测试在全量负载下的稳定性问题。

## 实现备注

- 卡片主按钮为「开始去气口」：校验并落盘草稿后经统一 `runNodeManually` 直接运行
  （与视频截取/抽帧同一运行入口），不直接触发媒体转换；设置面板保留「保存去气口参数」。
- 测试基建：8 处 esbuild fixture 打包的 `external` 列表补入 `onnxruntime-node`
  （原生模块不可内联，与 `better-sqlite3`/`electron` 同处理）。
