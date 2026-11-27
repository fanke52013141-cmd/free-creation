import { GENERATED_NODE_CONTRACTS } from '@shared/agent-access/generated/node-contracts.generated'
import { ACCESS_OPERATIONS } from '@shared/agent-access/registry'

export interface BriefProjectSummary {
  id: string
  name: string
}

function formatPortList(
  ports: ReadonlyArray<{ id: string; type: string; required?: boolean; cardinality?: string }>
): string {
  if (ports.length === 0) return '无'
  return ports
    .map((p) => {
      const flags: string[] = [p.type]
      if (p.required) flags.push('必填')
      if (p.cardinality === 'many') flags.push('多值')
      return `\`${p.id}\`(${flags.join('/')})`
    })
    .join(', ')
}

/**
 * 生成可直接粘贴给外部 Agent（Claude Code / Cursor / Codex / Antigravity 等）的
 * Canvas Studio 完整对接与操控说明书。
 * 节点清单与操作总数全部从机器契约动态派生，不含任何密钥或私有内容。
 */
export function buildExternalAgentBrief(projects: readonly BriefProjectSummary[] = []): string {
  const totalOps = Object.keys(ACCESS_OPERATIONS).length
  const totalNodes = GENERATED_NODE_CONTRACTS.length

  const projectSection =
    projects.length > 0
      ? [
          '## 当前工作区已有项目（可直接传 `projectId` 给 `project_open`）',
          ...projects.slice(0, 20).map((p) => `- **${p.name}**：\`${p.id}\``),
          ...(projects.length > 20 ? [`- （其余 ${projects.length - 20} 个项目可通过 \`project_list\` 分页查看）`] : []),
          ''
        ]
      : [
          '## 当前工作区项目',
          '- 当前主页暂无项目，可调用 `project_create` 新建项目后再 `project_open`。',
          ''
        ]

  const nodeRows = GENERATED_NODE_CONTRACTS.map(
    (n) =>
      `| \`${n.typeId}\` | ${n.label} | ${formatPortList(n.ports.in)} | ${formatPortList(n.ports.out)} |`
  )

  return [
    '# Canvas Studio 外部 Agent 对接与操控说明',
    '',
    '你是我的外部协作 Agent。Canvas Studio 是一款本地桌面节点式 AI 创作软件（图像/视频/音频/脚本/剪辑/复合节点流），通过本机 **MCP（推荐）** 或 **CLI** 向你开放全部画布读写、幽灵预览建图、节点执行与产物读取能力。',
    '',
    '> **定位约定**：你负责理解我的创作目标、规划节点拓扑、选择参数、检查中间产物并迭代优化；Canvas Studio 负责确定性执行、幽灵预览与桌面人工确认安全阀。',
    '',
    '---',
    '',
    '## 一、如何连接 Canvas Studio',
    '',
    '### 方式 1：MCP 接入（推荐，默认轻量 `core` 档位）',
    `- 默认启动命令（仅暴露 24 个高频核心工具 + 3 个渐进发现元工具，共 27 个工具、<30 KB，兼容所有 MCP 客户端且可调用全部 **${totalOps}** 项能力）：`,
    '```json',
    '{',
    '  "mcpServers": {',
    '    "canvas-studio": {',
    '      "command": "node",',
    '      "args": ["out/main/local-agent.js", "mcp", "serve"]',
    '    }',
    '  }',
    '}',
    '```',
    '- 如需使用打包版或自定义数据目录，可将 `args` 中的路径指向本机 `local-agent.js` / `canvas-mcp.cjs`，并追加 `["--data-dir", "<数据目录>"]`；如需一次性展开全部工具，可加 `["--profile", "full"]`。',
    '- 支持 SSE 传输：`node out/main/local-agent.js mcp serve --transport sse --port 0`（令牌通过 `Authorization: Bearer <token>` 请求头传递）。',
    '',
    '### 方式 2：CLI 调用',
    '```bash',
    '# 生成合法幂等键（格式：13位毫秒时间戳:UUID）',
    'node out/main/local-agent.js key',
    '# 调用任意操作（operationId 中的 "." 改为空格）',
    'node out/main/local-agent.js project list --input-file payload.json',
    '```',
    '',
    ...projectSection,
    '## 二、推荐 4 步标准工作流（覆盖全部节点与已发布节点流）',
    '',
    '1. **探索与打开项目**',
    '   - `project_list` → `project_open`（编辑画布与执行节点前，目标项目必须在桌面打开）',
    '   - `graph_get` 读取当前画布节点、连线与 `graphVersion`（写操作需携带 `expectedGraphVersion` 防并发覆盖）',
    '   - `node_type_get` 查看任意节点类型的详细配置结构；`composite_search` / `composite_get` 查看已封装发布的可复用节点流',
    '   - `model_definition_list` 查看本机已配置的可用模型；`media_list` / `media_import` 管理本地素材',
    '',
    '2. **以“幽灵预览”提议建图（强烈推荐，方案 A）**',
    '   - 调用 **`graph_patch_propose`**，传入 `projectId`、`expectedGraphVersion`、`name`、`autoLayout: true` 和类型化 `ops` 数组（支持 `node.create` / `node.update` / `node.delete` / `node.duplicate` / `edge.create` / `edge.delete` / `group.create` / `backdrop.create` 等）。',
    '   - **零画布写入**：桌面画布会立刻渲染半透明「拟创建」幽灵卡片与连线、蓝色虚线「拟修改」框和红色虚线「拟删除」框，右上角弹出「外部建图预览」卡片。',
    '   - 确认落盘二选一：',
    '     - 让我直接在桌面预览面板点击 **「确认落画布」**；',
    '     - 或你调用 **`graph_patch_confirm({ projectId, previewId })`** 弹出桌面确认弹窗，经我点击「允许落画布」后以单撤销步原子落盘并保存。',
    '   - 若要放弃预览：调用 `graph_patch_discard`。小幅直接微调也可用 `graph_patch`。',
    '',
    '3. **执行节点 / 节点流并核对真实产物**',
    '   - 调用 `node_execute`（单节点或子图）或 `composite_run`（已发布复合节点流）',
    '   - 调用 `run_wait` 等待终态，再调用 `output_get` 读取真实输出（文本、JSON 或受控 `mediaId`）',
    '   - **严禁凭猜测宣称成功**：所有结论必须以 `run_wait` 终态和 `output_get` 真实结果为准。',
    '',
    '4. **按需发现与调用其余 170+ 扩展能力**',
    '   - `canvas_ops_search({ query, group, effect })`：检索 `library` / `history` / `provider` / `model` / `composite` / `diagnostics` / `director` / `media` 等命名空间操作',
    '   - `canvas_ops_schema({ operationId })`：按需获取单个操作的精确 JSON `inputSchema`',
    '   - `canvas_ops_call({ operationId, input, idempotencyKey })`：经同一鉴权与人工确认门禁执行',
    '',
    '---',
    '',
    '## 三、`graph_patch_propose` 请求示例（文案 → 生图 → 视频）',
    '',
    '```json',
    '{',
    '  "input": {',
    '    "projectId": "<目标项目ID>",',
    '    "expectedGraphVersion": 1,',
    '    "name": "短片分镜生图转视频",',
    '    "autoLayout": true,',
    '    "ops": [',
    '      { "action": "node.create", "ref": "prompt", "nodeType": "text", "title": "画面文案", "x": 0, "y": 0, "text": "清晨阳光洒在海边木屋，电影感" },',
    '      { "action": "node.create", "ref": "img", "nodeType": "image-gen", "title": "首帧生图", "x": 420, "y": 0 },',
    '      { "action": "node.create", "ref": "vid", "nodeType": "video", "title": "图生视频", "x": 840, "y": 0 },',
    '      { "action": "edge.create", "from": { "nodeId": "prompt", "portId": "out-text" }, "to": { "nodeId": "img", "portId": "in-text" } },',
    '      { "action": "edge.create", "from": { "nodeId": "prompt", "portId": "out-text" }, "to": { "nodeId": "vid", "portId": "in-text" } },',
    '      { "action": "edge.create", "from": { "nodeId": "img", "portId": "out-image" }, "to": { "nodeId": "vid", "portId": "in-first-frame" } }',
    '    ]',
    '  }',
    '}',
    '```',
    '> 提示：同批新建节点使用 `ref` 互连；已有画布节点使用真实 `shape:...` ID；插入已发布复合节点流使用 `"nodeType": "composite", "config": { "capabilityId": "...", "version": "1.0" }`。',
    '',
    '---',
    '',
    `## 四、全部可用节点类型与端口速查（共 ${totalNodes} 类，与软件契约同源）`,
    '',
    '| 节点类型 (`nodeType`) | 名称 | 输入端口 (`in-*`) | 输出端口 (`out-*`) |',
    '| --- | --- | --- | --- |',
    ...nodeRows,
    '',
    '---',
    '',
    '## 五、安全铁律与常见错误码处理',
    '',
    '- **人工门禁不可绕过**：落画布确认（`graph.patch.confirm` / `flowGraph.confirm`）、人工任务提交、状态机人工事件等均会在桌面弹窗等待我点击允许；若返回 `HUMAN_DENIED` 或 `HUMAN_DECISION_TIMEOUT`，代表零副作用，不要强行重试。',
    '- **付费与联网显式确认**：涉及真实模型计费或联网的操作，必须明确征求我同意后再传确认参数（如 `confirmCost: true` / `confirmPaidRerun: true`）。',
    '- **不触碰密钥**：切勿索要、打印或往节点正文写入任何 API Key。',
    '- **常见错误码**：',
    '  - `ACTIVE_PROJECT_REQUIRED`：先调用 `project_open` 在桌面打开目标项目；',
    '  - `REVISION_CONFLICT`：读取错误中的 `currentGraphVersion`（或重新 `graph_get`）后重试；',
    '  - `PATCH_REFERENCE_INVALID`：检查 `nodeId` / `ref` / 端口 ID 与上表是否一致；',
    '  - `OUTCOME_UNKNOWN`：先通过 `run_get` / `graph_get` 核对真实状态，切勿盲目重放写操作。'
  ].join('\n')
}
