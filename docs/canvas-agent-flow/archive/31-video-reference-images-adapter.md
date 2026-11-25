# 多参考图片生成视频接入 Agent Flow

日期：2026-10-15。接续首尾帧双图包，保留当前工作区已有首尾帧改动。本包不新增节点/UI 或安装包，不提交/推送。

画布路径：按需要的顺序连接图片 out-image 至 video v7 的 in-images，明确选择参考模式；可接一路文本或使用节点正文。主 Agent 分派专业 Agent，经 node.execute 和既有公共视频 executor 生成，unknown 后重开明确核对/继续，只接回原任务，交付一个固定视频版本。

## 实现

- reference 与首帧/首尾帧是独立模式。只开放固定图片参考，至少 1 张、公共 manifest 硬上限 30；实际数量继续受已选择供应商/模型能力约束，不支持 reference 的模型拒绝。图片上限复用现有 video-capabilities（如 Seedance 2.0 为 9，2.5 为 30），不扩展模型或手动节点能力。官方依据：[创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)。
- main 准入固定保存连线顺序与每张来源/资产/版本；原端口 many 不改，文本最多一路，视频/音频/提示词包继续阻断。漏图、重复版本/媒体、额外边和换序沿公共校验拒绝。
- gateway 回读已准入命令，逐张匹配 referenceImageMediaIds、有序固定版本、项目媒体边界与文件 SHA-256；每张实际异步读取并编码的字节再次核验，保留已有 20 MiB 固定图片上限。
- 原任务重接除模型/参数/提示词/mode 外比较完整有序参考媒体列表，漂移保留 unknown。停止/迟到/多进程恢复/下载物化复用原任务服务，不重发生成。
- 原 video v7 端口、contractVersion、executor 与输出投影保持；专业 Agent 仍交付可连接的固定视频成果，未创建第二套执行器。

## 验证

83 项三文件定向通过：reference 1/3/9/30 公共上限、空/31/混合拒绝、有序账本与重开、原任务 drift、异步任意图片字节变化和停止后明确接回。首轮新增测试误嵌套和旧错误文案断言修正后通过；失败记录保留，未放宽来源/重放断言。两端类型、增量 lint 与构建结果及真实桌面接续见下方最终记录。

桌面测试使用三张有序真实图片、可解码 MP4、真实 SQLite/preload/公共 executor 和 main/专业 Agent；SDK 决策与供应商请求为隔离协议夹具，无付费媒体调用。验证每张 reference_image 与源 PNG 编码字节对应，unknown 重开后 1 POST/1 下载/1 任务，固定成果预览和原生指针规则通过。最终第三张 PNG 加合法 ancillary chunk，使三张编码可区分，原生展示仍可解码。

首次桌面夹具将第三张节点建在第二张之前，却按另一顺序断言 wire；实际保存清单和请求为同一顺序。调整夹具建图一致后通过，不改生产排序、不放宽逐项字节断言。失败日志 desktop-second/desktop-wire 保留；最终完整轮采用不同编码三图，逐项匹配通过。

### 最终完整验收

2026-10-15 npm run verify 完整串行退出码 0：171 文件、1874 项通过、1 既有跳过，模型包另 2；lint、两端/模型类型、日志门禁、17 浏览器、生产构建、15 组隐藏 Electron 全部通过。包括原文生视频/单首帧/首尾帧和新增图片参考，历史模式未回归失败。

证据 qa/agent-reference-20261015/verify.log、directed-fixed.log，以及 qa/agent-video-reference-20261015/desktop/results.json、video-fixed.png、image-fixed.png。最新报告 1 POST、1 下载、1 视频任务、3 张固定图片和 9 次合成 SDK 请求，实际诊断脱敏与开始/唯一终态配对通过，恢复关联保留；两张最终截图已人工查看。测试临时目录、窗口与服务由脚本清理，受跟踪 QA 两份基线恢复，不作为源码改动。源码未提交/推送，安装包未更新。

本机沿用 Electron-as-Node ABI140 及缓存 pnpm，QA 浏览器预加载显式使用已安装 Chromium1228 并关闭 GPU，不 rebuild native 模块、不修改产品环境或提交本机包装路径。

## 日志模板自查

本包改变输入与模型/恢复校验，复用 agent.desktop/coordination、command.operation、公共 node、model.request、task、media.persist/download、asset 和 project.save；不新增重复终态。关联 project/node/task/command/run/trace/span，失败沿 input/video-input/saved-input/image-integrity。只记录固定阶段/代码/数量/身份；无提示词、图片、Data URL、Base64、路径、Key 或原始响应。unknown 不因日志缺失而重派，logger 失败非致命沿公共测试保持。实际桌面脱敏、终态和恢复关联以最终结果为准；覆盖清单同步更新。

未支持视频/音频/运动混合参考、提示词包、视频视觉审核、并行媒体、真实供应商计费/撤回及物理掉电。没有可信任务查询身份的供应商仍 unknown。下一步独立适配视频/音频参考或视频审核，不把本包外推为全部多模态调度完成。
