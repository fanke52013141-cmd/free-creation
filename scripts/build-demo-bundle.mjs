/* eslint-disable @typescript-eslint/explicit-function-return-type -- 构建脚本为无 TS 编译步骤的 ESM。 */
import AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { makeArrow, makeNodeCard, makeProject } from './canvas-fixtures.mjs'

const output = resolve('resources/demo/canvas-studio-demo.canvasbundle')
const projectId = 'demo-source'
const imageId = 'demo-reference-image'
const imagePath = `projects/${projectId}/media/${imageId}.png`

const shotList = {
  shots: [
    {
      id: 'shot-1',
      scene: '雨夜街头，人物在霓虹灯下回头',
      dialogue: '我们还会再见吗？',
      duration: 5
    }
  ]
}

const directorProject = {
  version: 1,
  activeShotId: 'shot-1',
  shots: [
    {
      id: 'shot-1',
      name: '镜头 01',
      scene: shotList.shots[0].scene,
      dialogue: shotList.shots[0].dialogue,
      referenceMediaIds: [imageId],
      referenceMediaPaths: [imagePath],
      actors: [],
      camera: {
        x: 0,
        y: 1.6,
        z: 5,
        heading: 0,
        pitch: 0,
        focalLengthMm: 35,
        aspectRatio: '16:9',
        durationSec: 5,
        fps: 25
      }
    }
  ]
}

const cards = [
  makeNodeCard({
    id: 'shape:demo-prompt',
    nodeType: 'text',
    title: '创作提示',
    x: 80,
    y: 100,
    text: '雨夜街头的电影感镜头，人物在霓虹灯下转身，浅景深。'
  }),
  makeNodeCard({
    id: 'shape:demo-ai',
    nodeType: 'ai-process',
    title: '结构化分镜',
    x: 500,
    y: 100,
    config: JSON.stringify({
      modelKey: '',
      system: '把创作提示整理成符合分镜 Schema 的 JSON。',
      mode: 'json',
      jsonSchema: { id: 'storyboard.shots', version: 1 },
      temperature: 0.7,
      maxTokens: 1024
    })
  }),
  makeNodeCard({
    id: 'shape:demo-storyboard',
    nodeType: 'storyboard',
    title: '分镜板',
    x: 920,
    y: 100,
    text: JSON.stringify(shotList)
  }),
  makeNodeCard({
    id: 'shape:demo-reference',
    nodeType: 'image',
    title: '场景参考',
    x: 80,
    y: 480,
    media: { mediaId: imageId, mediaPath: imagePath, mediaMime: 'image/png' },
    exec: 'success'
  }),
  makeNodeCard({
    id: 'shape:demo-image-gen',
    nodeType: 'image-gen',
    title: '生图',
    x: 500,
    y: 480,
    config: JSON.stringify({ prompt: '电影感雨夜街头，人物回头，霓虹灯，浅景深', modelKey: '' })
  }),
  makeNodeCard({
    id: 'shape:demo-video',
    nodeType: 'video',
    title: '视频',
    x: 920,
    y: 480,
    config: JSON.stringify({ prompt: '人物缓慢回头，雨滴在霓虹灯下闪烁', modelKey: '' })
  }),
  makeNodeCard({
    id: 'shape:demo-iterate',
    nodeType: 'iterate',
    title: '循环',
    x: 1340,
    y: 100,
    config: JSON.stringify({ itemVar: 'shot', onFailure: 'skip', maxRetries: 0, limit: 3 })
  }),
  makeNodeCard({
    id: 'shape:demo-director',
    nodeType: 'director',
    title: '导演台',
    x: 1340,
    y: 480,
    config: JSON.stringify(directorProject)
  })
]

const byId = new Map(cards.map((card) => [card.id, card]))
const link = (id, fromId, toId, fromPort, toPort, color) =>
  makeArrow({
    id,
    from: byId.get(fromId),
    to: byId.get(toId),
    fromPort,
    toPort,
    color
  })

const project = makeProject({
  id: projectId,
  name: 'Canvas Studio 创作链路演示',
  cards,
  edges: [
    link(
      'shape:demo-edge-prompt-ai',
      'shape:demo-prompt',
      'shape:demo-ai',
      'out-text',
      'in-text',
      'blue'
    ),
    link(
      'shape:demo-edge-ai-storyboard',
      'shape:demo-ai',
      'shape:demo-storyboard',
      'out-json',
      'in-json',
      'violet'
    ),
    link(
      'shape:demo-edge-storyboard-director',
      'shape:demo-storyboard',
      'shape:demo-director',
      'out-json',
      'in-storyboard',
      'blue'
    ),
    link(
      'shape:demo-edge-reference-imagegen',
      'shape:demo-reference',
      'shape:demo-image-gen',
      'out-image',
      'in-image',
      'green'
    ),
    link(
      'shape:demo-edge-prompt-imagegen',
      'shape:demo-prompt',
      'shape:demo-image-gen',
      'out-text',
      'in-text',
      'blue'
    ),
    link(
      'shape:demo-edge-imagegen-video',
      'shape:demo-image-gen',
      'shape:demo-video',
      'out-image',
      'in-image',
      'green'
    ),
    link(
      'shape:demo-edge-storyboard-director-ref',
      'shape:demo-reference',
      'shape:demo-director',
      'out-image',
      'in-reference-images',
      'green'
    )
  ]
})

// 1×1 PNG：真实 bundle 媒体，用于导入时的媒体引用重映射与预览验收。
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
mkdirSync(dirname(output), { recursive: true })
zip.writeZip(output)
writeFileSync(
  resolve('resources/demo/README.md'),
  '# 演示项目\n\n运行 `pnpm build:demo` 可重新生成 `canvas-studio-demo.canvasbundle`。\n\n该项目展示两条真实数据链：\n\n- 文本 → AI 处理 → 分镜 → 导演台\n- 图片资产/文本 → 生图 → 视频\n\n包内包含一个真实 PNG 媒体，用于验收导入时对节点、快照、导演台引用和媒体库路径的重映射。模型节点不预置 API Key 或供应商配置。\n'
)
