# REL-03 旧工作流支持矩阵（2026-10-18 冻结）

对应主用例：REL-03（P0，桌面+人工）。
通过标准：旧工作流仍可用；公共 executor 改动无回归；受控目标的 gate/占用一致。

## 1. Agent 实际支持目标清单（源码冻结）

来源：`src/shared/agent-flow/video-adapter.ts` 的 `flowTargetContract`。自动化冻结断言见
[`test/agent-flow-target-matrix.test.ts`](../../../test/agent-flow-target-matrix.test.ts)（4/4 通过）。

| 目标 | 契约 | 输入端口 | 输出端口 |
| --- | --- | --- | --- |
| processor | 1 | `in-value` | `out-value` |
| video | 7 | `in-text`、`in-prompt`、`in-images`、`in-reference-video`、`in-reference-audio` | `out-video` |
| image-gen | 3 | `in-images`、`in-prompt`、`in-text` | `out-image` |
| image-edit | 2 | `in-image`、`in-text` | `out-image` |
| speech | 4 | `in-text`、`in-voice`（minimax）/ `in-audio`（volc） | `out-audio` |
| tts | 4 | `in-audio` | `out-json` |

任何其他节点类型或非上述契约版本都不属于 Agent 支持目标；旧手动节点继续可用，但不能被声明为 Agent 可执行目标。

## 2. 逐格证据

图例：✅ 已有直接证据；◐ 仅集成/自动化层证据；⬜ 尚未覆盖。

| 目标 | 旧手动路径运行/保存/重开 | Agent 正向执行 | 共享 gate/占用 | 未支持目标拒绝 |
| --- | --- | --- | --- | --- |
| 旧文本 processor | ✅ 正式包双进程（`run-20261018-rel03-legacy-manual-package-v4`） | ✅ M01 正式包提交固定文本成果 | ✅ 旧手动入口被 unknown 占用阻断（`run-20261018-rel03-agent-legacy-gate-package-v2`） | 不适用 |
| video@7 | ✅ 抽音轨/截取/抽帧（`rel03-legacy-video-*-package-v1`） | ✅ 桌面 Electron `test-agent-flow-desktop --video`：固定视频版本一次提交；命令台账覆盖返工身份 | ✅ 命令台账桌面 fixture 占用；旧视频节点 gate 由 `run-20261018-rel03-agent-media-gate-package-v2` 覆盖 | — |
| image-gen@3 | ⬜ 生成类节点依赖供应商，未作为旧手动路径 | ✅ 桌面 Electron `test-agent-flow-commands`：单张固定生成、拒绝批量/重试计费 | ✅ 命令台账桌面 fixture 占用 | — |
| image-edit@2 | ✅ 编辑/裁剪/四分割（`rel03-legacy-image-*-package-v4`） | ✅ 桌面 Electron `test-agent-flow-commands`：一张固定原图 + 固定输出 | ✅ 旧图像节点被 unknown 占用阻断（`...gate-package-v1/v2`）；命令台账占用 | — |
| speech@4 | ✅ 旧音频变速/音量及语音协议回归 | ✅ 桌面 Electron `test-agent-flow-commands`：按保存后端准入，拒绝跨后端/可变参考音频 | ✅ 命令台账桌面 fixture 占用 | — |
| tts@4 | ✅ 同上（声音克隆协议回归） | ✅ 桌面 Electron `test-agent-flow-commands`：一份固定音频输入、音色档案校验 | ✅ 命令台账桌面 fixture 占用 | — |
| image-crop / sound-adjust / image-split / video-clip 等旧手动类型 | ✅ 旧手动路径可运行 | 不适用（`flowTargetContract` 返回 null） | ✅ 正式包启动前拒绝并保持目标 idle（`rel03-agent-image-crop-rejection-package-v1`、`rel03-agent-sound-adjust-rejection-package-v1`） | ✅ 提示“当前工具支持数据处理与文本生成视频”且任务/命令/资产版本=0 |

## 3. 结论与剩余缺口

- 支持矩阵已冻结，且由单测防止源码漂移。
- 旧手动文本/图片/音频/视频路径已有正式包双进程证据；未支持媒体目标的拒绝边界已有正式包双进程证据。
- image-gen、video、speech、tts 的 Agent 正向执行与占用由桌面 Electron 命令/视频 fixture 覆盖（`test:agent-flow-commands`、`test:agent-flow-video`，均在最终 verify 中通过）；这些是源码 Electron 桌面夹具，不是正式包 UI。正式包侧覆盖的是旧手动路径、旧媒体节点 gate 占用和未支持目标拒绝。
- 生成类 image-gen 没有旧手动样本（依赖供应商），不作为“旧路径”断言；其 Agent 命令契约已在桌面 fixture 中验证。
- 按 REL-03 的通过标准“旧工作流仍可用、公共 executor 无回归、受控目标 gate/占用一致、未支持目标不伪装成功”，本矩阵已齐全。REL-03 升级为通过；真实旧客户项目人工走查和真实供应商生成质量不属于本用例声明范围。
