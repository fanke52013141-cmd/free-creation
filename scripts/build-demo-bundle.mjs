// WP4 可回归示例项目生成脚本（R0）
// 纯 JS 构建脚本，不参与 TS 编译，函数签名以 JSDoc 标注：
/* eslint-disable @typescript-eslint/explicit-function-return-type */
//
// 用途：node scripts/build-demo-bundle.mjs
// 产出 resources/demo/canvas-studio-demo.canvasbundle —— 自包含 zip（project.json +
// bundle.json），应用内"打开示例项目"导入后即为带新 id 的可运行副本。
//
// 覆盖链路（R0_PLAN WP4）：
//   1. 文本 → 生图
//   2. 文本 → 对话 → JSON
//   3. JSON → 分镜
//   4. 处理 → 代码 → 循环（R4 批处理回归样本，链 4/5 连成一条）
//   5. 循环 → AI 处理 → 生图（循环体：逐项生成提示词后生图）
//
// 技术说明：
// - tldrawSnapshot 在纯 Node 环境 headless 构建：document/page 记录经内置 schema
//   校验后入库；node-card / arrow / binding 为应用自定义记录，手工拼装（结构与
//   NodeCardUtil.getDefaultProps / canvas/graph.ts createEdge 完全镜像），应用端
//   loadStoreSnapshot 按应用 schema 校验恢复。
// - 媒体决策：bundle 不含媒体节点。importProject 只重映射 file.nodes 里的
//   content.mediaId，不处理 tldrawSnapshot 内 shape.props.mediaId，跨机导入媒体
//   引用会断链（R7 既有缺口）；示例项目先避开，待该缺口修复后再补充媒体链路。
import { createTLSchema, createTLStore, DocumentRecordType, PageRecordType } from 'tldraw'
import AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'resources', 'demo')
const OUT_FILE = join(OUT_DIR, 'canvas-studio-demo.canvasbundle')

const W = 340
const H = 260
const PAGE = 'page:page'

// ── 端口定义（与 src/renderer/src/nodes/specs/index.tsx 保持一致） ──────────
const JSON_ANY = { id: 'json.any', version: 1 }
const STORYBOARD_SHOTS = { id: 'storyboard.shots', version: 1 }
const LIST_ITEMS = { id: 'list.items', version: 1 }

/** @returns {{ id: string, name: string, dir: string, type: string, description: string, required: boolean, cardinality: string, schema?: object }} */
const port = (id, dir, type, name, o = {}) => ({
  id,
  name,
  dir,
  type,
  description: name,
  required: o.required ?? dir === 'out',
  cardinality: o.cardinality ?? 'one',
  ...(o.schema ? { schema: o.schema } : {})
})

const NODE_PORTS = {
  text: {
    in: [port('in-text', 'in', 'text', '文本', { cardinality: 'many', required: false })],
    out: [port('out-text', 'out', 'text', '文本')]
  },
  'image-gen': {
    in: [
      port('in-image', 'in', 'image', '参考图', { required: false }),
      port('in-text', 'in', 'text', '提示词', { cardinality: 'many', required: false })
    ],
    out: [port('out-image', 'out', 'image', '图片')]
  },
  chat: {
    in: [port('in-text', 'in', 'text', '文本', { cardinality: 'many', required: false })],
    out: [port('out-markdown', 'out', 'markdown', '回复')]
  },
  json: {
    in: [
      port('in-json', 'in', 'json', '数据', {
        cardinality: 'many',
        required: false,
        schema: JSON_ANY
      }),
      port('in-text', 'in', 'text', '文本', { required: false })
    ],
    out: [port('out-json', 'out', 'json', '数据', { schema: JSON_ANY })]
  },
  storyboard: {
    in: [
      port('in-json', 'in', 'json', '分镜数据', { required: false, schema: STORYBOARD_SHOTS }),
      port('in-text', 'in', 'text', '分镜文本', { required: false })
    ],
    out: [
      port('out-json', 'out', 'json', '分镜数据', { schema: STORYBOARD_SHOTS }),
      port('out-text', 'out', 'text', '合成文本', { required: false })
    ]
  },
  processor: {
    in: [port('in-value', 'in', 'any', '输入变量', { required: false })],
    out: [port('out-value', 'out', 'any', '输出变量')]
  },
  code: {
    in: [
      port('in-text', 'in', 'text', '文本输入', { cardinality: 'many', required: false }),
      port('in-json', 'in', 'json', '数据输入', {
        cardinality: 'many',
        required: false,
        schema: JSON_ANY
      })
    ],
    out: [
      port('out-text', 'out', 'text', '文本输出', { required: false }),
      port('out-json', 'out', 'json', '数据输出', { required: false, schema: JSON_ANY })
    ]
  },
  iterate: {
    in: [port('in-list', 'in', 'json', '列表', { required: false, schema: LIST_ITEMS })],
    out: [port('out-items', 'out', 'json', '逐项结果', { schema: LIST_ITEMS })]
  },
  'ai-process': {
    in: [
      port('in-text', 'in', 'text', '文本', { cardinality: 'many', required: false }),
      port('in-json', 'in', 'json', 'JSON 上下文', { required: false, schema: JSON_ANY })
    ],
    out: [
      port('out-text', 'out', 'text', '文本', { required: false }),
      port('out-markdown', 'out', 'markdown', 'Markdown', { required: false }),
      port('out-json', 'out', 'json', 'JSON', { required: false, schema: JSON_ANY })
    ]
  }
}

const EDGE_COLORS = {
  text: 'light-blue',
  markdown: 'light-blue',
  json: 'violet',
  image: 'green',
  video: 'light-red',
  audio: 'yellow',
  any: 'grey'
}

// ── 示例节点内容（保证未配置供应商时给出明确缺模型提示、配置后可一键运行） ──
/** @param {unknown} v @returns {string} */
const j = (v) => JSON.stringify(v)

const NODES = [
  // 链 1：文本 → 生图
  {
    id: 'n-text-img',
    type: 'text',
    title: '① 生图提示词',
    x: 80,
    y: 80,
    text: '一只戴宇航员头盔的柴犬，坐在月球表面，背景是蓝色的地球，电影感光效'
  },
  {
    id: 'n-imagegen',
    type: 'image-gen',
    title: '① 生图',
    x: 560,
    y: 80,
    text: j({
      prompt: '一只戴宇航员头盔的柴犬坐在月球表面，背景是蓝色地球，电影感光效',
      modelKey: '',
      size: 'auto'
    })
  },

  // 链 2：文本 → 对话 → JSON
  {
    id: 'n-text-chat',
    type: 'text',
    title: '② 对话提问',
    x: 80,
    y: 460,
    text: '请严格只输出一个 JSON 对象，不要输出其它内容，格式：{"summary":"一句话总结","keywords":["关键词"]}}。主题：介绍分镜脚本的作用。'
  },
  {
    id: 'n-chat',
    type: 'chat',
    title: '② 对话',
    x: 560,
    y: 460,
    text: j({ system: '你是严谨的助手，必须只输出合法 JSON。', modelKey: '', messages: [] })
  },
  { id: 'n-json-out', type: 'json', title: '② 结果 JSON', x: 1040, y: 460, text: '' },

  // 链 3：JSON → 分镜
  {
    id: 'n-json-shots',
    type: 'json',
    title: '③ 分镜数据',
    x: 80,
    y: 840,
    text: j([
      {
        id: 's1',
        scene: '清晨的城市天台，主角望向远方',
        dialogue: '又是新的一天。',
        duration: '3s'
      },
      { id: 's2', scene: '主角转身走向镜头，微笑', dialogue: '这次一定能行。', duration: '4s' }
    ])
  },
  { id: 'n-storyboard', type: 'storyboard', title: '③ 分镜板', x: 560, y: 840, text: '' },

  // 链 4+5：处理 → 代码 → 循环 → AI 处理 → 生图（批处理回归样本）
  {
    id: 'n-processor',
    type: 'processor',
    title: '④ 主题列表',
    x: 80,
    y: 1220,
    text: j({
      inputName: 'input',
      outputName: 'themes',
      valueType: 'any',
      fallback: '["柴犬宇航员在月球","赛博朋克雨夜街道","水墨山水间的小舟"]'
    })
  },
  {
    id: 'n-code',
    type: 'code',
    title: '④ 规整列表',
    x: 560,
    y: 1220,
    text: j({
      source:
        'async function main({ input }) {\n  const list = Array.isArray(input) ? input : [input]\n  return list\n}',
      inputName: 'input',
      inputType: 'any',
      outputName: 'list',
      outputType: 'array',
      params: []
    })
  },
  {
    id: 'n-iterate',
    type: 'iterate',
    title: '⑤ 批量循环',
    x: 1040,
    y: 1220,
    text: j({ itemVar: 'item', onFailure: 'skip', maxRetries: 0, concurrency: 2, limit: 0 })
  },
  {
    id: 'n-aiprocess',
    type: 'ai-process',
    title: '⑤ 逐项写提示词',
    x: 1520,
    y: 1220,
    text: j({
      modelKey: '',
      system: '你是图片提示词专家。根据给到的主题，输出一句简洁的中文图片提示词，不要任何解释。',
      mode: 'text',
      temperature: 0.7,
      maxTokens: 512
    })
  },
  {
    id: 'n-imagegen-batch',
    type: 'image-gen',
    title: '⑤ 批量生图',
    x: 2000,
    y: 1220,
    text: j({ prompt: '高质量插画，细节丰富', modelKey: '', size: 'auto' })
  }
]

// [fromNode, fromPort, toNode, toPort]
const EDGES = [
  ['n-text-img', 'out-text', 'n-imagegen', 'in-text'],
  ['n-text-chat', 'out-text', 'n-chat', 'in-text'],
  ['n-chat', 'out-markdown', 'n-json-out', 'in-text'],
  ['n-json-shots', 'out-json', 'n-storyboard', 'in-json'],
  ['n-processor', 'out-value', 'n-code', 'in-json'],
  ['n-code', 'out-json', 'n-iterate', 'in-list'],
  ['n-iterate', 'out-items', 'n-aiprocess', 'in-json'],
  ['n-aiprocess', 'out-text', 'n-imagegen-batch', 'in-text']
]

const byId = new Map(NODES.map((n) => [n.id, n]))
/** @returns {string} */
const portType = (nodeId, portId) => {
  const node = byId.get(nodeId)
  const ports = [...NODE_PORTS[node.type].in, ...NODE_PORTS[node.type].out]
  return ports.find((p) => p.id === portId)?.type ?? 'any'
}

/** @returns {number[]} */
function portOffsets(count, cardH) {
  if (count <= 0) return []
  if (count === 1) return [cardH / 2]
  if (count === 2) return [cardH / 4, (cardH * 3) / 4]
  return Array.from({ length: count }, (_, i) => (cardH * (i + 1)) / (count + 1))
}

/** @returns {number} */
const clamp01 = (v) => Math.max(0.02, Math.min(0.98, v))

// ── tldraw 记录拼装 ─────────────────────────────────────────────────────────
/** @returns {object} */
function makeShapeRecord(node, z) {
  return {
    id: `shape:${node.id}`,
    typeName: 'shape',
    type: 'node-card',
    x: node.x,
    y: node.y,
    rotation: 0,
    index: z,
    isLocked: false,
    opacity: 1,
    parentId: PAGE,
    props: {
      w: W,
      h: H,
      nodeType: node.type,
      title: node.title,
      text: node.text,
      mediaId: '',
      mediaPath: '',
      mediaMime: '',
      exec: 'idle'
    },
    meta: {}
  }
}

/** @returns {object[]} */
function makeArrowRecords([fromId, fromPort, toId, toPort], z) {
  const from = byId.get(fromId)
  const to = byId.get(toId)
  const fromPorts = NODE_PORTS[from.type].out
  const toPorts = NODE_PORTS[to.type].in
  const fromY =
    portOffsets(fromPorts.length, H)[
      Math.max(
        0,
        fromPorts.findIndex((p) => p.id === fromPort)
      )
    ] ?? H / 2
  const toY =
    portOffsets(toPorts.length, H)[
      Math.max(
        0,
        toPorts.findIndex((p) => p.id === toPort)
      )
    ] ?? H / 2
  const start = { x: from.x + W, y: from.y + fromY }
  const end = { x: to.x, y: to.y + toY }
  const dist = Math.hypot(end.x - start.x, end.y - start.y)
  const bend = Math.max(20, Math.min(84, dist * 0.16))
  const arrowId = `shape:edge-${fromId}-${toId}`

  const arrow = {
    id: arrowId,
    typeName: 'shape',
    type: 'arrow',
    x: start.x,
    y: start.y,
    rotation: 0,
    index: z,
    isLocked: false,
    opacity: 1,
    parentId: PAGE,
    props: {
      kind: 'arc',
      color: EDGE_COLORS[portType(fromId, fromPort)] ?? 'grey',
      fill: 'none',
      dash: 'solid',
      size: 'l',
      font: 'sans',
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      start: { x: 0, y: 0 },
      end: { x: end.x - start.x, y: end.y - start.y },
      bend,
      labelPosition: 0.5,
      scale: 1
    },
    meta: { fromPort, toPort }
  }
  /** @returns {object} */
  const binding = (terminal, toShapeId, anchorX, anchorY) => ({
    id: `binding:${arrowId.replace('shape:', '')}-${terminal}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: arrowId,
    toId: toShapeId,
    props: {
      terminal,
      normalizedAnchor: { x: anchorX, y: clamp01(anchorY / H) },
      isExact: false,
      isPrecise: true,
      snap: 'none'
    }
  })
  return [
    arrow,
    binding('start', `shape:${fromId}`, 0.98, fromY),
    binding('end', `shape:${toId}`, 0.02, toY)
  ]
}

// ── ProjectFile 图数据（nodes/edges 与快照同源生成，保证一致） ──────────────
/** @returns {{ nodes: object[], edges: object[], groups: object[] }} */
function buildGraphData() {
  const nodes = NODES.map((n) => ({
    id: `shape:${n.id}`,
    type: n.type,
    contractVersion: 1,
    title: n.title,
    x: n.x,
    y: n.y,
    w: W,
    h: H,
    ports: [...NODE_PORTS[n.type].in, ...NODE_PORTS[n.type].out],
    params: {},
    content: n.text ? { kind: 'text', text: n.text } : { kind: 'empty' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 }
  }))
  const edges = EDGES.map(([fromId, fromPort, toId, toPort]) => ({
    id: `shape:edge-${fromId}-${toId}`,
    from: { nodeId: `shape:${fromId}`, portId: fromPort },
    to: { nodeId: `shape:${toId}`, portId: toPort }
  }))
  return { nodes, edges, groups: [] }
}

// ── 组装快照：document/page 经内置 schema 校验，自定义记录手工拼 ────────────
const schema = createTLSchema()
const store = createTLStore({ schema })
store.put([
  DocumentRecordType.create({ id: 'document:document' }),
  PageRecordType.create({ id: PAGE, name: 'Page 1', index: 'a1' })
])
const { schema: serializedSchema } = store.getStoreSnapshot()

const records = {}
let z = 0
for (const node of NODES) {
  const rec = makeShapeRecord(node, `a${String(++z).padStart(2, '0')}`)
  records[rec.id] = rec
}
for (const edge of EDGES) {
  for (const rec of makeArrowRecords(edge, `a${String(++z).padStart(2, '0')}`)) {
    records[rec.id] = rec
  }
}

const tldrawSnapshot = { schema: serializedSchema, store: records }

const now = Date.now()
const projectFile = {
  version: 1,
  meta: {
    id: 'demo-bundle',
    name: 'Canvas Studio 示例项目',
    createdAt: now,
    updatedAt: now,
    graphVersion: 3
  },
  ...buildGraphData(),
  tldrawSnapshot
}

// ── 打包 ────────────────────────────────────────────────────────────────────
const zip = new AdmZip()
zip.addFile('project.json', Buffer.from(JSON.stringify(projectFile, null, 2), 'utf-8'))
zip.addFile(
  'bundle.json',
  Buffer.from(
    JSON.stringify({
      projectName: projectFile.meta.name,
      sourceGraphVersion: projectFile.meta.graphVersion,
      exportedAt: now,
      projectVersion: 1
    })
  )
)
mkdirSync(OUT_DIR, { recursive: true })
zip.writeZip(OUT_FILE)
writeFileSync(
  join(OUT_DIR, 'README.md'),
  Buffer.from(
    [
      '# Canvas Studio 示例项目',
      '',
      '`canvas-studio-demo.canvasbundle` 由 `node scripts/build-demo-bundle.mjs` 生成，',
      '应用内项目列表"打开示例项目"导入为带新 id 的副本。',
      '',
      '覆盖链路：文本→生图 / 文本→对话→JSON / JSON→分镜 / 处理→代码→循环→AI处理→生图（批处理）。',
      '不含媒体节点（导入重映射缺口，见脚本头注释）。',
      ''
    ].join('\n'),
    'utf-8'
  )
)

console.log(`demo bundle written: ${OUT_FILE}`)
console.log(
  `nodes: ${NODES.length}, edges: ${EDGES.length}, snapshot records: ${Object.keys(records).length + 2}`
)
