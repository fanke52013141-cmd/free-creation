# Agent Flow 端到端验证材料（2026-11-12）

本目录是"外部 Agent 构建并驱动 agent flow"构想的端到端验证证据与复现工具。配套交接文档见 [`../HANDOFF_2026_11_12_AGENT_FLOW_VERIFICATION.md`](../HANDOFF_2026_11_12_AGENT_FLOW_VERIFICATION.md)。

## 文件

| 文件 | 内容 |
|---|---|
| `REPORT.md` | 三轮验证完整报告（外部建图/执行、模型验证、根因隔离）。含证据与缺口清单。 |
| `repro_glm.py` | 裸 API 根因隔离脚本（脱敏，密钥从环境变量读）。证明官方端点能稳定产出工具调用。 |
| `repro_sdk.mjs` | 用应用同款 AI SDK + 精确内容复现主控决策（脱敏）。最 decisive 的证据。 |
| `exact_ctx.json` | 应用主控实际发送的精确上下文内容（真实目标+4专家+真实资产引用）。**不含密钥**。 |

## 如何复现

> 密钥绝不写进代码或提交仓库。运行前用环境变量注入。

```powershell
$env:CANVAS_TEST_API_KEY = '<你的智谱 API Key>'
# 可选：$env:CANVAS_TEST_BASE_URL / $env:CANVAS_TEST_MODEL

# 1) 裸 API 隔离（在任意目录）
python repro_glm.py

# 2) 同款 SDK 复现（必须在仓库内运行，依赖 ../../node_modules）
node repro_sdk.mjs
```

预期：两个脚本都稳定产出合法 `dispatch_agent` 工具调用（`finish=tool_calls`）。
而应用内主控（`flowAgent.run` start）却在 `decisions=1` 处 `AGENT_MODEL_FAILED`。
→ 根因锁定在**应用运行时集成**，而非端点/内容/SDK 版本。详见 REPORT.md 第十二–十三节。

## 应用内复现主控失败

1. 按自用版构建：`$env:CANVAS_OWNER='1'; npx electron-vite build`（在 `source/`）。
2. 启动时**必须带** `--local-agent-access`（否则外部接入服务不启动）：
   `node_modules\electron\dist\electron.exe . --local-agent-access`
   （先移除 `ELECTRON_RUN_AS_NODE` 环境变量，否则 Electron 以纯 Node 运行秒退。）
3. 经 CLI 配置模型并验证：`model.connection.save` → `model.definition.save` → `model.validateAgentToolCalling`（confirmNetwork+confirmCost）。
4. `flowAgent.run`（主控节点，action=start）→ 观察 `AGENT_MODEL_FAILED`。

CLI 调用要点见交接文档 §4。