/* eslint-disable no-regex-spaces, @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// F0 业务动作分母审计：把 GUI 业务动作（IPC 契约 + 画布级动作）与外部 Registry 覆盖对照。
// 产物：docs/local-agent-access/generated/action-inventory.json
// 校验：每个 IPC 通道与画布动作都有登记；登记的阶段合法；external 引用的操作必须真实存在。
// 本脚本是 F0 静态分母门禁，不证明任何动作已实现；运行状态以各交付台账为准。
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const contractsPath = path.join(root, 'src/shared/contracts/index.ts')
const registryPath = path.join(root, 'src/shared/agent-access/registry.ts')
const coveragePath = path.join(root, 'docs/local-agent-access/action-coverage.json')
const inventoryPath = path.join(root, 'docs/local-agent-access/generated/action-inventory.json')

function parseIpcChannels() {
  const src = fs.readFileSync(contractsPath, 'utf8')
  const marker = 'export const IPC = {'
  const start = src.indexOf(marker)
  if (start < 0) throw new Error('IPC contract not found')
  const objStart = start + marker.length - 1
  let depth = 0
  let end = -1
  for (let i = objStart; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error('IPC object not terminated')
  const body = src.slice(objStart, end)
  const channels = []
  const familyRe = /^  ([a-zA-Z]+): \{/
  const pairRe = /([a-zA-Z][a-zA-Z0-9]*):\s*'([^']+)'/g
  let family = null
  for (const line of body.split('\n')) {
    const fam = line.match(familyRe)
    if (fam) family = fam[1]
    let m
    pairRe.lastIndex = 0
    while ((m = pairRe.exec(line))) {
      channels.push({ family, key: m[1], channel: m[2] })
    }
  }
  if (channels.length === 0) throw new Error('IPC channel parse produced no entries')
  return channels
}

function parseRegistryOperations() {
  // 操作按业务族拆分在 src/shared/agent-access/ops/*，registry.ts 只做组装；
  // 审计必须扫描全部登记文件，不能只看 registry.ts 里的内联操作（否则分母被悄悄缩小）。
  const opsDirectory = path.join(root, 'src/shared/agent-access/ops')
  const files = [
    registryPath,
    ...fs
      .readdirSync(opsDirectory)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => path.join(opsDirectory, name))
  ]
  const ids = []
  let scannedBlocks = 0
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const markerRe = /export const ([A-Z_]+)_OPERATIONS = \{/g
    let marker
    while ((marker = markerRe.exec(src))) {
      const objStart = marker.index + marker[0].length - 1
      let depth = 0
      let end = -1
      for (let i = objStart; i < src.length; i++) {
        const c = src[i]
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      if (end < 0) throw new Error(`Registry operation block not terminated: ${path.basename(file)}`)
      scannedBlocks++
      const re = /'([a-zA-Z_.]+)':\s*\{/g
      let m
      while ((m = re.exec(src.slice(objStart, end)))) ids.push(m[1])
    }
  }
  if (ids.length === 0) throw new Error('Registry operation parse produced no entries')
  if (new Set(ids).size !== ids.length) {
    const seen = new Set()
    const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)))
    throw new Error(`Registry operation declared twice: ${duplicates.join(',')}`)
  }
  return ids
}

// 画布级业务动作：GUI 入口在 renderer（调色板/右键菜单/多选工具栏/侧栏/复杂工作区），
// 多数最终落到 IPC 或引擎，但 GUI 语义先于通道存在，必须独立登记，不能只扫 IPC。
const CANVAS_ACTIONS = [
  ['canvas.graph.read', '画布节点/连线/分组视图读取（呈现层承载）'],
  ['canvas.node.create', '调色板/右键菜单/拖线新建节点'],
  ['canvas.node.update-content', '节点正文与固定配置编辑（Body/Settings）'],
  ['canvas.node.move-resize', '节点移动与调整尺寸'],
  ['canvas.node.duplicate', '右键菜单复制节点'],
  ['canvas.node.delete', '右键菜单/Delete 删除节点（级联清理连线）'],
  ['canvas.node.order', '右键菜单置顶/置底'],
  ['canvas.edge.create', '拖线创建数据连线（含端口选择）'],
  ['canvas.edge.delete', '点选连线 Delete 删除'],
  ['canvas.edge.retarget', '拖动连线改接目标端口'],
  ['canvas.multiselect.connect', '多选批量连many端口'],
  ['canvas.group.toggle', '多选工具栏组合/取消组合'],
  ['canvas.backdrop.create-delete', '多选工具栏创建和删除背景板'],
  ['canvas.backdrop.configure-arrange', '背景板命名、配色和整理'],
  ['canvas.backdrop.move', '移动背景板及成员'],
  ['canvas.align', '多选工具栏对齐/均分'],
  ['canvas.flow_layout', '底部坞智能整理按钮/Shift+Alt+F（流程分层/角色泳道/网格）'],
  ['canvas.history.undo-redo', '历史坞撤销/重做'],
  ['canvas.workflow.run-all', '画布运行全部工作流'],
  ['canvas.workflow.run-selection', '多选运行所选节点及上游闭包'],
  ['canvas.workflow.cancel', '取消运行中的流程命令'],
  ['canvas.node.run', '单节点运行按钮'],
  ['canvas.node.result-select', '资产/结果集合中切换选中结果'],
  ['canvas.media.drop-import', '拖放本机文件导入素材并建节点'],
  ['canvas.chat.send', '对话侧栏发送消息'],
  ['canvas.chat.cancel', '对话流式取消'],
  ['canvas.chat.edit-message', '对话消息编辑/重新生成'],
  ['canvas.chat.attachments', '对话附件上传/引用'],
  ['canvas.chat.image-gen', '对话内生图意图与图片附件'],
  ['canvas.storyboard.edit', '分镜板表格镜头行/列编辑'],
  ['canvas.timeline.edit', '轨道线轨道/片段/分割/音量编辑'],
  ['canvas.timeline.render', '轨道线合成成片'],
  ['canvas.director.edit', '导演台场景/对象/机位/镜头编辑'],
  ['canvas.director.publish', '导演台发布帧/视频/机位'],
  ['canvas.website.open', '网址节点系统浏览器打开'],
  ['canvas.nodeLibrary.save-node', '右键菜单保存节点到节点库'],
  ['canvas.nodeLibrary.insert', '节点库条目插入画布'],
  ['canvas.snapshot.save-restore', '工作区快照保存/恢复/删除'],
  ['canvas.view.viewport', '画布缩放/平移/聚焦（呈现层）'],
  // F9 补齐的读取型业务动作：此前这些 GUI 入口没有独立登记，导致对应外部操作
  // （chat.read/chat.messages、chat.skill.*、run.get/run.wait、model.list、project.get）
  // 在分母里没有来源，被反向覆盖检查判为孤儿。
  ['canvas.chat.read-messages', '对话面板读取会话目录与消息正文'],
  ['canvas.chat.skill-bind', '对话节点绑定/查看已安装技能版本'],
  ['canvas.run.observe', '运行时间线/任务状态查询'],
  ['canvas.model.catalog', '模型设置页读取本地模型与能力验证状态'],
  ['canvas.project.read-summary', '项目页/打开项目时读取项目摘要'],
  ['canvas.node.contract-panel', '选中节点右侧 I/O 面板的类型/字段/端口/依赖查询（N1）'],
  ['canvas.model.credential-status', '模型设置里每个连接显示"已保存密钥/未保存"状态'],
  ['canvas.composite.upgrade', '右键菜单节点流实例升级：版本选择、同一预检、兼容连线迁移（W3）'],
  // 2026-11-11 用户裁决：GUI 不再提供归档入口（卡片动作收敛为 编辑/编辑节点/删除）。
  // composite.archive 外部操作保留，由 ipc.composite.archive 登记解释（仅 CLI/MCP 可用）。
  ['canvas.composite.delete', '节点流卡片删除节点流：同一引用检查（画布实例+嵌套引用）+ 二次确认（W3）']
]

const PHASES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'external', 'excluded']

/**
 * 三入口一致性的显式例外清单（AGENT_PARITY_SPEC §8「三入口目录」门禁的一部分）。
 *
 * 这里只允许两类：
 * 1) META：协议自省操作——`capability.list` 列出能力、`node.type.list` 列出节点接入状态。
 *    它们本身就是"目录查询"，不存在对应的 GUI 业务动作。
 * 2) EXTERNAL_ONLY：外部能做、GUI 当前没有等价入口的操作。**必须写原因与后续处置**，
 *    不允许悄悄存在（§1.7）；GUI 补入口或下线该操作后，这里要同步删除，
 *    否则下面的 STALE_EXCEPTION 会报错，避免例外变成永久豁免。
 */
const META_OPERATIONS = new Map([
  ['capability.list', '协议自省：列出当前已开放操作，无对应 GUI 业务动作'],
])
const EXTERNAL_ONLY_OPERATIONS = new Map([
  [
    'node.library.update',
    'GUI 节点库面板当前没有重命名入口；外部重命名复用同一 store 写口，待 GUI 补同入口或下线该操作'
  ]
])

function main() {
  const channels = parseIpcChannels()
  const operations = parseRegistryOperations()
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'))
  const errors = []
  const actions = { ...coverage.actions }

  for (const { family, key, channel } of channels) {
    const id = `ipc.${family}.${key}`
    if (!actions[id]) errors.push(`MISSING_COVERAGE:${id} (${channel})`)
    else if (actions[id].channel !== channel)
      errors.push(`CHANNEL_MISMATCH:${id} expected ${channel} got ${actions[id].channel}`)
  }
  for (const [id] of CANVAS_ACTIONS) {
    if (!actions[id]) errors.push(`MISSING_COVERAGE:${id}`)
  }
  for (const [id, entry] of Object.entries(actions)) {
    if (!PHASES.includes(entry.phase)) errors.push(`BAD_PHASE:${id}:${entry.phase}`)
    if (entry.phase === 'external') {
      for (const op of entry.external ?? []) {
        if (!operations.includes(op)) errors.push(`UNKNOWN_EXTERNAL_OP:${id}:${op}`)
      }
      if (!(entry.external ?? []).length) errors.push(`EXTERNAL_WITHOUT_MAPPING:${id}`)
      // 三入口一致性：标为已开放的动作必须写清 GUI 入口（空字符串不算）。
      if (typeof entry.gui !== 'string' || !entry.gui.trim())
        errors.push(`EXTERNAL_WITHOUT_GUI:${id}`)
    }
    const knownIpc = channels.some(({ family, key }) => `ipc.${family}.${key}` === id)
    const knownCanvas = CANVAS_ACTIONS.some(([cid]) => cid === id)
    if (!knownIpc && !knownCanvas) errors.push(`STALE_ACTION:${id}`)
  }

  // 反向覆盖：每个已登记操作都必须能被至少一个业务动作解释（否则就是"登记了但没人需要"）。
  const referenced = new Set()
  for (const entry of Object.values(actions)) {
    for (const op of entry.external ?? []) referenced.add(op)
  }
  for (const operation of operations) {
    if (referenced.has(operation)) continue
    if (META_OPERATIONS.has(operation) || EXTERNAL_ONLY_OPERATIONS.has(operation)) continue
    errors.push(`ORPHAN_EXTERNAL_OP:${operation}`)
  }
  // 例外清单不得腐化：写进清单却已不是操作 / 已被正常映射，都应报错。
  for (const operation of [...META_OPERATIONS.keys(), ...EXTERNAL_ONLY_OPERATIONS.keys()]) {
    if (!operations.includes(operation)) errors.push(`STALE_EXCEPTION:${operation}`)
    else if (referenced.has(operation)) errors.push(`STALE_EXCEPTION_MAPPED:${operation}`)
  }
  // CLI/MCP 目录派生自同一 Registry，但两种派生都可能撞名或撞保留字。
  const mcpNames = new Map()
  for (const operation of operations) {
    const mcpName = operation.replaceAll('.', '_')
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(mcpName)) errors.push(`MCP_NAME_INVALID:${operation}:${mcpName}`)
    if (mcpNames.has(mcpName)) errors.push(`MCP_NAME_DUPLICATE:${mcpName}:${mcpNames.get(mcpName)},${operation}`)
    else mcpNames.set(mcpName, operation)
    const tokens = operation.split('.')
    if (tokens.some((token) => !token)) errors.push(`CLI_TOKEN_EMPTY:${operation}`)
    // CLI 前两个令牌被保留命令占用（key / contracts / mcp serve），且 `status` 是 app.status 的别名。
    if (['key', 'contracts', 'mcp'].includes(tokens[0]))
      errors.push(`CLI_RESERVED_TOKEN:${operation}`)
    if (tokens[0] === 'status' && operation !== 'app.status')
      errors.push(`CLI_STATUS_ALIAS_CONFLICT:${operation}`)
  }

  if (errors.length) {
    process.stderr.write(errors.join('\n') + '\n')
    process.exit(1)
  }

  const byPhase = {}
  for (const entry of Object.values(actions)) byPhase[entry.phase] = (byPhase[entry.phase] ?? 0) + 1
  const inventory = {
    schemaVersion: 1,
    generatedFrom: {
      ipcChannels: channels.length,
      canvasActions: CANVAS_ACTIONS.length,
      externalOperations: operations.length
    },
    totals: { actions: Object.keys(actions).length, byPhase },
    actions
  }
  const serialized = JSON.stringify(inventory, null, 2) + '\n'
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(inventoryPath), { recursive: true })
    fs.writeFileSync(inventoryPath, serialized)
    process.stdout.write(`Action inventory written: ${inventory.totals.actions} actions\n`)
  } else {
    const existing = fs.readFileSync(inventoryPath, 'utf8')
    if (existing !== serialized) {
      process.stderr.write('Action inventory is stale; run audit-business-actions.cjs --write\n')
      process.exit(1)
    }
  }
  process.stdout.write(
    `Business action audit passed: ${channels.length} IPC channels + ${CANVAS_ACTIONS.length} canvas actions; external ops ${operations.length}; by phase ${JSON.stringify(byPhase)}\n`
  )
}
main()
