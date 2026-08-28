import AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const output = resolve('resources/demo/canvas-studio-demo.canvasbundle')
mkdirSync(dirname(output), { recursive: true })

const projectId = 'demo-source'
const imageId = 'demo-image'
const imagePath = `projects/${projectId}/media/${imageId}.png`
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
    {
      id: 'shape:text',
      type: 'text',
      contractVersion: 1,
      title: '创作提示',
      x: 80,
      y: 120,
      w: 340,
      h: 260,
      ports: [],
      params: {},
      content: { kind: 'text', text: '雨夜街头的电影感镜头' },
      exec: { status: 'idle' },
      meta: { source: 'input', createdAt: 0 }
    },
    {
      id: 'shape:image',
      type: 'image',
      contractVersion: 1,
      title: '示例图片资产',
      x: 520,
      y: 120,
      w: 340,
      h: 260,
      ports: [],
      params: {},
      content: { kind: 'media', mediaId: imageId },
      exec: { status: 'success' },
      meta: { source: 'upload', createdAt: 0 }
    }
  ],
  edges: [],
  groups: [],
  tldrawSnapshot: {
    store: {
      'shape:demo-image': {
        id: 'shape:demo-image',
        typeName: 'shape',
        type: 'node-card',
        x: 520,
        y: 120,
        rotation: 0,
        index: 'a1',
        parentId: 'page:page',
        isLocked: false,
        props: {
          w: 340,
          h: 260,
          nodeType: 'image',
          title: '示例图片资产',
          config: '',
          text: '',
          mediaId: imageId,
          mediaPath: imagePath,
          mediaMime: 'image/png',
          exec: 'success'
        },
        meta: {}
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
