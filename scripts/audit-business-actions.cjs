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
  ['canvas.align', '多选工具栏对齐/均分'],
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
  ['canvas.view.viewport', '画布缩放/平移/聚焦（呈现层）']
]

const PHASES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'external', 'excluded']

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
    }
    const knownIpc = channels.some(({ family, key }) => `ipc.${family}.${key}` === id)
    const knownCanvas = CANVAS_ACTIONS.some(([cid]) => cid === id)
    if (!knownIpc && !knownCanvas) errors.push(`STALE_ACTION:${id}`)
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
