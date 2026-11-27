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
    `- 默认启动命令（暴露 25 个高频核心工具 + 3 个渐进发现元工具，共 28 个工具、<45 KB，兼容所有 MCP 客户端且可调用全部 **${totalOps}** 项能力）：`,
    '```json',
    '{',
    '  "mcpServers": {',
    '    "canvas-studio": {',
    '      "command": "node",',
    '      "args": ["<Canvas Studio 源码根目录>/out/main/local-agent.js", "mcp", "serve"]',
    '    }',
    '  }',
    '}',
    '```',
    '- **重要路径提示**：请将 `<Canvas Studio 源码根目录>/out/main/local-agent.js` 替换为本机实际绝对路径（或在打包版指向 `canvas-mcp.cjs`）；如使用自定义数据目录，追加 `["--data-dir", "<数据目录>"]`；如需一次性展开全部工具，可加 `["--profile", "full"]`。',
    '- **幂等键必填规则**：所有非只读工具（`project_create` / `project_open` / `graph_patch_propose` / `graph_patch_confirm` / `node_execute` / `media_import` 等）必须在顶层携带 `idempotencyKey`，格式严格为 **`<13位毫秒时间戳>:<小写UUIDv4>`**（例：`1764244200000:550e8400-e29b-41d4-a716-446655440000`）。',
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
    '   - `graph_get`（项目已打开时优先传 **`view: "latest"`** 获取最新节点、连线与 `graphVersion`，避免与后台自动保存产生 `REVISION_CONFLICT`）',
    '   - `node_type_get` 查看任意节点类型的端口契约与 **`configGuide` 配置示例**；`composite_search` / `composite_get` 查看已封装发布的可复用节点流',
    '   - `model_definition_list` 查看本机已配置的可用模型；`media_list` / `media_import` 管理本地素材（`media_import` 的 `filePath` 须位于 `<数据目录>/agent-exports` 受控目录内）',
    '',
    '2. **以“幽灵预览”提议建图（强烈推荐，方案 A）**',
    '   - 调用 **`graph_patch_propose`**，传入 `projectId`、`expectedGraphVersion`、`name`、`autoLayout: true` 和类型化 `ops` 数组（支持 `node.create` / `node.update` / `node.delete` / `node.duplicate` / `edge.create` / `edge.delete` / `group.create` / `backdrop.create` 等）。',
    '   - **提案期即完成深度校验 + 零画布写入**：服务端会立即校验节点类型、端口存在性、类型兼容、`code` 配置与无环性（有误会直接返回合法端口列表）；通过后桌面画布立刻渲染半透明「拟创建」幽灵卡片与连线、蓝色虚线「拟修改」框和红色虚线「拟删除」框，右上角弹出「外部建图预览」卡片。',
    '   - 确认落盘二选一：',
    '     - 让我直接在桌面预览面板点击 **「确认落画布」**；',
    '     - 或你调用 **`graph_patch_confirm({ projectId, previewId })`** 弹出桌面确认弹窗，经我点击「允许落画布」后以单撤销步原子落盘并保存。',
    '   - 若要放弃预览：调用 `graph_patch_discard`。小幅直接微调也可用 `graph_patch`。',
    '',
    '3. **执行节点 / 节点流并核对真实产物**',
    '   - 调用 `node_execute`（单节点或子图）或 `composite_execute` + `composite_execute_wait`（已发布复合节点流）',
    '   - `node_execute` 后调用 `run_wait` 等待终态，再调用 `output_get` 读取真实输出（文本、JSON 或受控 `mediaId`）',
    '   - 纯本地确定性节点（`code` / `processor` / `image-crop` / `image-split` / `video-frame` / `video-clip` / `sound-adjust` / `silence-trim`）无需付费重跑确认；若上游含付费模型节点，需征得我同意后传 `confirmPaidRerun: true`。',
    '   - **严禁凭猜测宣称成功**：所有结论必须以 `run_wait` / `composite_execute_wait` 终态和 `output_get` 真实结果为准。',
    '',
    '4. **按需发现与调用其余扩展能力**',
    '   - `canvas_ops_search({ query, group, effect })`：检索 `library` / `history` / `provider` / `model` / `composite` / `diagnostics` / `director` / `node.runPlan` 等命名空间操作',
    '   - `canvas_ops_schema({ operationId })`：按需获取单个操作的精确 JSON `inputSchema`',
    '   - `canvas_ops_call({ operationId, input, idempotencyKey })`：经同一鉴权与人工确认门禁执行',
    '',
    '---',
    '',
    '## 三、`graph_patch_propose` 请求示例（文案 → 生图 → 视频）',
    '',
    '```json',
    '{',
    '  "idempotencyKey": "1764244200000:550e8400-e29b-41d4-a716-446655440000",',
    '  "input": {',
    '    "projectId": "<目标项目ID>",',
    '    "expectedGraphVersion": 1,',
    '    "name": "短片分镜生图转视频",',
    '    "autoLayout": true,',
    '    "ops": [',
    '      { "action": "node.create", "ref": "prompt", "nodeType": "text", "title": "画面文案", "x": 0, "y": 0, "text": "清晨阳光洒在海边木屋，电影感" },',
    '      { "action": "node.create", "ref": "img", "nodeType": "image-gen", "title": "首帧生图", "x": 420, "y": 0, "config": { "aspectRatio": "16:9", "resolution": "2k", "count": 1 } },',
    '      { "action": "node.create", "ref": "vid", "nodeType": "video", "title": "图生视频", "x": 840, "y": 0, "config": { "mode": "first-frame", "params": { "ratio": "16:9", "duration": 5 } } },',
    '      { "action": "edge.create", "from": { "nodeId": "prompt", "portId": "out-text" }, "to": { "nodeId": "img", "portId": "in-text" } },',
    '      { "action": "edge.create", "from": { "nodeId": "prompt", "portId": "out-text" }, "to": { "nodeId": "vid", "portId": "in-text" } },',
    '      { "action": "edge.create", "from": { "nodeId": "img", "portId": "out-image" }, "to": { "nodeId": "vid", "portId": "in-images" } }',
    '    ]',
    '  }',
    '}',
    '```',
    '> **避坑速查**：',
    '> - 同批新建节点用 `ref` 互连；已有画布节点用真实 `shape:...` ID；插入已发布复合节点流用 `"nodeType": "composite", "config": { "capabilityId": "...", "version": "1.0" }`。',
    '> - `video` 的图片输入端口统一为 **`in-images`**（多值按顺序解析首帧/尾帧/参考图，不存在 `in-first-frame`）。',
    '> - `processor` 的端口为 `in-value` / `out-value`，模板占位符为 **`{{value}}`**（不是 `{{text}}`）。',
    '> - `code` 的 `config` 使用 `source`（`async function main(args)`）、`params: [{ name, type }]`（端口 `in-param-<kebab>`）、`outputMode: "fields"`、`outputs: [{ name, type }]`（`type` 取 `string/object/array/...`，不是 `text/json`）。',
    '> - `image-split` 的列数键名为 **`columns`**（不是 `cols`）；更多节点字段请随时调 `node_type_get` 查看 `configGuide`。',
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
    '  - `REVISION_CONFLICT`：读取错误中的 `currentGraphVersion`（或 `graph_get({ view: "latest" })`）后重试；',
    '  - `EDGE_PORT_INVALID` / `PATCH_REFERENCE_INVALID` / `CONFIG_INVALID`：按 `error.detail` 中的合法端口/配置提示或 `node_type_get` 的 `configGuide` 修正；',
    '  - `PATH_NOT_ALLOWED`：`media_import` 文件须先放入 `<数据目录>/agent-exports` 受控目录；',
    '  - `PAID_RERUN_CONFIRM_REQUIRED`：子图含付费模型上游，征得同意后传 `confirmPaidRerun: true` 或改 `mode: "single"`；',
    '  - `OUTCOME_UNKNOWN`：先通过 `run_get` / `graph_get` 核对真实状态，切勿盲目重放写操作。'
  ].join('\n')
}
