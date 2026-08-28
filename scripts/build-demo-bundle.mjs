/* eslint-disable @typescript-eslint/explicit-function-return-type */
import AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const output = resolve('resources/demo/canvas-studio-demo.canvasbundle')
mkdirSync(dirname(output), { recursive: true })

const projectId = 'demo-source'
const imageId = 'demo-image'
const imagePath = `projects/${projectId}/media/${imageId}.png`
let nextIndex = 1
const node = (id, nodeType, title, x, y, config = '', text = '') => ({
  id,
  type: nodeType,
  contractVersion: 1,
  title,
  x,
  y,
  w: 340,
  h: 260,
  ports: [],
  params: config ? { config } : {},
  content: text ? { kind: 'text', text } : { kind: 'empty' },
  exec: { status: 'idle' },
  meta: { source: 'input', createdAt: 0 }
})

const shape = (id, nodeType, title, x, y, config = '', text = '') => ({
  id,
  typeName: 'shape',
  type: 'node-card',
  x,
  y,
  rotation: 0,
  index: `a${nextIndex++}`,
  parentId: 'page:page',
  isLocked: false,
  props: {
    w: 340,
    h: 260,
    nodeType,
    title,
    config,
    text,
    mediaId: '',
    mediaPath: '',
    mediaMime: '',
    exec: 'idle'
  },
  meta: {}
})

const snapshotStore = {
  'document:document': {
    gridSize: 10,
    name: '',
    meta: {},
    id: 'document:document',
    typeName: 'document'
  },
  'page:page': {
    name: 'Page 1',
    index: 'a1',
    meta: {},
    id: 'page:page',
    typeName: 'page'
  },
  'shape:text': shape('shape:text', 'text', '创作提示', 80, 120, '', '雨夜街头的电影感镜头'),
  'shape:ai': shape(
    'shape:ai',
    'ai-process',
    'AI 生成分镜数据',
    500,
    120,
    JSON.stringify({ outputMode: 'json', outputSchema: 'storyboard.shots@1' }),
    ''
  ),
  'shape:storyboard': shape('shape:storyboard', 'storyboard', '分镜板', 920, 120),
  'shape:list': shape(
    'shape:list',
    'json',
    '批处理列表',
    80,
    520,
    '',
    JSON.stringify(
      [
        { id: 'shot-01', prompt: '雨夜街头，低机位' },
        { id: 'shot-02', prompt: '霓虹倒影，推镜' }
      ],
      null,
      2
    )
  ),
  'shape:iterate': shape('shape:iterate', 'iterate', '批量迭代', 500, 520),
  'shape:image': {
    ...shape('shape:image', 'image', '示例图片资产', 920, 520),
    props: {
      ...shape('shape:image', 'image', '示例图片资产', 920, 520).props,
      mediaId: imageId,
      mediaPath: imagePath,
      mediaMime: 'image/png',
      exec: 'success'
    }
  }
}

const bind = (id, arrowId, toId, terminal, x) => ({
  id,
  typeName: 'binding',
  type: 'arrow',
  fromId: arrowId,
  toId,
  props: {
    terminal,
    normalizedAnchor: { x, y: 0.5 },
    isExact: false,
    isPrecise: true,
    snap: 'none'
  },
  meta: {}
})

const arrow = (id, from, to, fromPort, toPort) => ({
  id,
  typeName: 'shape',
  type: 'arrow',
  x: 420,
  y: 250,
  rotation: 0,
  index: `a${nextIndex++}`,
  parentId: 'page:page',
  isLocked: false,
  props: {
    kind: 'arc',
    color: 'light-blue',
    fill: 'none',
    dash: 'solid',
    size: 'l',
    font: 'sans',
    arrowheadStart: 'none',
    arrowheadEnd: 'arrow',
    start: { x: 0, y: 0 },
    end: { x: 420, y: 0 },
    bend: 32,
    labelPosition: 0.5,
    scale: 1
  },
  meta: { fromPort, toPort },
  bindings: { from, to }
})

snapshotStore['shape:arrow-ai'] = arrow(
  'shape:arrow-ai',
  'shape:text',
  'shape:ai',
  'out-text',
  'in-text'
)
snapshotStore['shape:arrow-storyboard'] = arrow(
  'shape:arrow-storyboard',
  'shape:ai',
  'shape:storyboard',
  'out-json',
  'in-json'
)
snapshotStore['shape:arrow-iterate'] = arrow(
  'shape:arrow-iterate',
  'shape:list',
  'shape:iterate',
  'out-json',
  'in-list'
)
for (const [id, arrowId, from, to] of [
  ['binding:arrow-ai-start', 'shape:arrow-ai', 'shape:text', 'start'],
  ['binding:arrow-ai-end', 'shape:arrow-ai', 'shape:ai', 'end'],
  ['binding:arrow-storyboard-start', 'shape:arrow-storyboard', 'shape:ai', 'start'],
  ['binding:arrow-storyboard-end', 'shape:arrow-storyboard', 'shape:storyboard', 'end'],
  ['binding:arrow-iterate-start', 'shape:arrow-iterate', 'shape:list', 'start'],
  ['binding:arrow-iterate-end', 'shape:arrow-iterate', 'shape:iterate', 'end']
]) {
  snapshotStore[id] = bind(id, arrowId, from, to, to === 'start' ? 0.98 : 0.02)
}

const project = {
  version: 1,
  meta: {
    id: projectId,
    name: 'Canvas Studio 演示项目',
    createdAt: 0,
    updatedAt: 0,
    graphVersion: 0
  },
  nodes: [
    node('shape:text', 'text', '创作提示', 80, 120, '', '雨夜街头的电影感镜头'),
    node(
      'shape:ai',
      'ai-process',
      'AI 生成分镜数据',
      500,
      120,
      JSON.stringify({ outputMode: 'json', outputSchema: 'storyboard.shots@1' })
    ),
    node('shape:storyboard', 'storyboard', '分镜板', 920, 120),
    node(
      'shape:list',
      'json',
      '批处理列表',
      80,
      520,
      '',
      JSON.stringify(
        [
          { id: 'shot-01', prompt: '雨夜街头，低机位' },
          { id: 'shot-02', prompt: '霓虹倒影，推镜' }
        ],
        null,
        2
      )
    ),
    node('shape:iterate', 'iterate', '批量迭代', 500, 520),
    {
      ...node('shape:image', 'image', '示例图片资产', 920, 520),
      content: { kind: 'media', mediaId: imageId },
      exec: { status: 'success' },
      meta: { source: 'upload', createdAt: 0 }
    }
  ],
  edges: [
    {
      id: 'shape:arrow-ai',
      from: { nodeId: 'shape:text', portId: 'out-text' },
      to: { nodeId: 'shape:ai', portId: 'in-text' }
    },
    {
      id: 'shape:arrow-storyboard',
      from: { nodeId: 'shape:ai', portId: 'out-json' },
      to: { nodeId: 'shape:storyboard', portId: 'in-json' }
    },
    {
      id: 'shape:arrow-iterate',
      from: { nodeId: 'shape:list', portId: 'out-json' },
      to: { nodeId: 'shape:iterate', portId: 'in-list' }
    }
  ],
  groups: [],
  tldrawSnapshot: {
    store: snapshotStore,
    schema: {
      schemaVersion: 2,
      sequences: {
        'com.tldraw.store': 5,
        'com.tldraw.document': 2,
        'com.tldraw.page': 1,
        'com.tldraw.shape': 4,
        'com.tldraw.shape.node-card': 1,
        'com.tldraw.binding.arrow': 1
      }
    }
  }
}

// 1×1 PNG，刻意作为真实 bundle 媒体用于导入/重映射验收。
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2XQAAAABJRU5ErkJggg==',
  'base64'
)
const zip = new AdmZip()
zip.addFile('project.json', Buffer.from(JSON.stringify(project, null, 2)))
zip.addFile(
  'bundle.json',
  Buffer.from(
    JSON.stringify({
      projectName: project.meta.name,
      sourceGraphVersion: 0,
      exportedAt: 0,
      projectVersion: 1
    })
  )
)
zip.addFile(`media/${imageId}.png`, png)
zip.writeZip(output)
writeFileSync(
  resolve('resources/demo/README.md'),
  `# 演示项目\n\n运行 \`node scripts/build-demo-bundle.mjs\` 可重新生成 \`canvas-studio-demo.canvasbundle\`。\n\n该包包含一个真实 PNG 媒体资产，用于验收导入时对节点、快照和媒体库的引用重映射。\n`
)
