/* eslint-disable @typescript-eslint/explicit-function-return-type -- 构建脚本为无 TS 编译步骤的 ESM。 */
// 画布性能基准：生成可导入的 100 / 500 / 1000 节点项目，并测量纯数据层的
// 构造、序列化与解析成本。渲染流畅度仍需按 docs/INTERACTION_ACCEPTANCE.md
// 在真实 Electron 中人工验证；本脚本不把机器相关帧率伪装成通用结论。
import AdmZip from 'adm-zip'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { makeBenchmarkProject } from './canvas-fixtures.mjs'

const SIZES = [100, 500, 1000]
const outFlagIndex = process.argv.indexOf('--out')
const requestedOut = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : undefined
if (outFlagIndex >= 0 && !requestedOut) throw new Error('--out 后必须提供输出目录')
const outputDir = requestedOut
  ? resolve(requestedOut)
  : mkdtempSync(resolve(tmpdir(), 'canvas-benchmark-'))
const temporary = !requestedOut

function round(value) {
  return Math.round(value * 100) / 100
}

function writeBundle(project, count) {
  const zip = new AdmZip()
  zip.addFile('project.json', Buffer.from(JSON.stringify(project)))
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
  const path = resolve(outputDir, `canvas-${count}-nodes.canvasbundle`)
  mkdirSync(dirname(path), { recursive: true })
  zip.writeZip(path)
  return path
}

const results = []
try {
  for (const count of SIZES) {
    const started = performance.now()
    const project = makeBenchmarkProject(count)
    const constructedAt = performance.now()
    const encoded = JSON.stringify(project)
    const serializedAt = performance.now()
    JSON.parse(encoded)
    const parsedAt = performance.now()
    const bundlePath = writeBundle(project, count)
    const bundledAt = performance.now()
    results.push({
      nodes: count,
      edges: project.edges.length,
      snapshotRecords: Object.keys(project.tldrawSnapshot.store).length,
      jsonBytes: Buffer.byteLength(encoded),
      constructMs: round(constructedAt - started),
      serializeMs: round(serializedAt - constructedAt),
      parseMs: round(parsedAt - serializedAt),
      bundleMs: round(bundledAt - parsedAt),
      bundlePath
    })
  }
  console.log(JSON.stringify({ outputDir, temporary, results }, null, 2))
} finally {
  // 默认只输出测量结果；避免把基准二进制误加入工作树。需要人工导入时才显式 --out。
  if (temporary) rmSync(outputDir, { recursive: true, force: true })
}
