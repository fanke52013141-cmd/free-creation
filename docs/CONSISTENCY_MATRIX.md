# 节点手动入口一致性矩阵（R0 / WP3）

> 制定日期：2026-08-27 · 依据：R0_PLAN.md §3 WP3、b3a33cc 之后的手动路径收敛改造。
> 用途：作为后续新增卡片按钮的对照基线——任何新的"生成/运行"类按钮必须走 `runNodeManually`；
> "导入/编辑辅助"类直调需在本表登记归类理由。

## 1. 统一入口约定

- **生成类按钮**（产出端口输出的动作）：一律调用 `runNodeManually(editor, projectId, shapeId)`
  （`src/renderer/src/engine/executor.ts`），内部复用 `executeNodeOnce` 完整链路：
  输入收集（含 flagged 边拦截）→ 契约校验 → 执行器 → `projectNodeOutputs` 投影 → 登记 → `addError` 写诊断面板与日志。
- **取消**：生成类统一对接 `CancelSignal`——引擎运行中调用 `useEngineStore.getState().stop?.()`；
  非运行态的历史任务（如重启后恢复）直接调网关取消。
- **导入类**（资产编辑，写 props 后由投影天然一致）：保持直调，全局运行会重新投影，无双轨风险。
- **辅助类**（改写节点配置：prompt、代码源码、镜头字段）：语义是"编辑"不是"运行"，不收敛进执行器。

## 2. 矩阵（13 节点）

| 节点 | 手动入口 | 复用执行器 | 输出投影 | 取消 | 错误路径 |
| --- | --- | --- | --- | --- | --- |
| text 文本 | 双击编辑；「生成N图」为辅助类直调 | 运行走 `textExecutor`；生成N图属配置编辑不收敛 | out-text（props.text） | 同步无取消 | 执行器 → addError；辅助类 toast |
| image 图片 | 「导入」pickMedia 写 props（导入类） | `imageExecutor`（存量/上游复用） | out-image（mediaId） | 不适用 | 导入失败 toast；运行 → addError |
| image-gen 生图 | 「生成图片」→ **runNodeManually**（WP3 收敛） | `imageGenExecutor`（复用成片/参考图/种子） | out-image（mediaId） | 引擎 stop（CancelSignal） | addError（input/execution/output 分相）+ 日志 |
| video 视频 | 「生成视频」→ **runNodeManually**（WP3 收敛）；「重新生成」清空后手动触发 | `videoExecutor`（提交+轮询+taskId 持久化） | out-video（mediaId） | 「取消任务」→ 引擎 stop → `waitForVideo` 撤销；非运行态直调 videoCancel | addError + 日志；网关事件 toast |
| audio 音频 | 「上传」导入类；「生成语音」→ **runNodeManually**（WP3 收敛） | `audioExecutor`（上游音频优先，否则 TTS） | out-audio（mediaId） | 引擎 stop | addError + 日志 |
| chat 对话 | 聊天面板会话式直调 `chatStart`（交互式会话，非单次运行按钮） | 全局运行走 `chatExecutor`（单轮） | out-text（最新回复） | 面板「停止」chatCancel | 面板内联错误；执行器 → addError |
| script 脚本 | 「AI 拆解」直调 `chatStart`（辅助类：改写脚本配置） | `scriptExecutor`（拆解分镜 → out-json） | out-json / out-text | 拆解任务 chatCancel | 执行器 → addError；拆解失败 toast |
| processor 处理 | 无生成按钮（参数配置面板） | `processorExecutor` | out-value（nodeResult） | 引擎 stop | addError + 日志 |
| json JSON | 文本编辑 | `jsonExecutor`（透传） | out-json（props.text） | 不适用 | addError |
| code 代码 | 「AI 生成代码」直调 `waitForChat`（辅助类：生成源码配置） | `codeExecutor`（运行代码） | out-text / out-json（nodeResult） | 同步无 | 执行器 → addError；AI 生成面板内联错误 |
| storyboard 分镜 | 镜头级/全部生图直调 `imageGenerate`（导入类：写镜头内部字段 `shot.imageMediaId`，不产生端口输出；`normalizeShot` 保留该字段） | `storyboardExecutor`（上游 JSON 标准化） | out-json（含镜头图引用）/ out-text | 无（顺序生成） | 执行器 → addError；镜头失败 toast |
| ai-process AI处理 | 无生成按钮（配置面板） | `aiProcessExecutor`（Schema 校验输出） | out-text / out-markdown / out-json | 引擎 stop | addError（含 Schema 名） |
| iterate 迭代 | 无生成按钮（配置面板） | `iterateExecutor`（runSubflow 驱动循环体） | out-items（list.items@1） | 引擎 stop（含子流程） | addError + 单项失败隔离 |

## 3. 收敛记录（本次 WP3 改动）

| 按钮 | 改造前 | 改造后 |
| --- | --- | --- |
| 生图「生成图片」 | 直调 `imageGenerate` 写 props，无契约校验/无输出登记/无取消 | `runNodeManually`，草稿先写回 props |
| 视频「生成视频」 | Body 自管任务生命周期（submit/events/cancel），绕过执行器 | `runNodeManually`；taskId 由执行器持久化到 props.text，Body 仅据事件显示进度 |
| 视频「取消任务」 | 直调 `videoCancel` | 引擎运行中 → `stop`（CancelSignal → `waitForVideo` 撤销）；非运行态历史任务直调 |
| 音频「生成语音」 | 直调 `audioGenerate` | `runNodeManually`，草稿先写回 props |

## 4. 决策点结论（对应 R0_PLAN §7）

- **决策点 4（分镜生图归类）**：已核实——镜头级生图写入卡片内部镜头字段（`shot.imageMediaId/imageMediaPath`），
  不产生 out-image 端口输出，与生图节点输出不重叠；`normalizeShot` 展开保留该字段，全局运行不会丢失。
  归类为**导入类**：保持 Body 直调，文档化于本表。
- **辅助类维持直调**（R0_PLAN §7 决策点 3）：脚本 AI 拆解、代码 AI 生成、文本生成N图均为配置编辑动作。
- **chat 面板**：会话式交互界面（多轮、流式、可停止），非"单次生成"按钮，维持现状；全局运行仍走执行器单轮路径。
