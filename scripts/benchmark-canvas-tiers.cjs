/**
 * 大画布真机桌面性能基准脚本（50 / 200 / 500 节点）。
 *
 * 直接启动已构建的 Electron 生产包（无需 vite dev server），在隔离临时数据目录中：
 * 1) 通过 Local Agent CLI 写入 50 / 200 / 500 节点的真实拓扑图（混合 text/image-gen/video 节点与连线）；
 * 2) 在真实桌面画布打开并测量：
 *    - 自动激活的性能档位（Tier 0 / Tier 2 / Tier 3）与离屏休眠激活状态；
 *    - 30 帧连续拖拽节点的 FPS、P50/P95 帧耗时（ms）；
 *    - 30 帧连续平移/缩放视口的 FPS、P50/P95 帧耗时（ms）；
 *    - 主进程异步保存耗时（asyncSaveMs）与快照体积（snapshotKB）；
 *    - 渲染进程与主进程真实内存占用（workingSetMB）。
 *
 * 用法：node scripts/benchmark-canvas-tiers.cjs [--sizes 50,200,500] [--out qa/benchmark-canvas-tiers.json]
 */
const { _electron } = require('playwright')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { resolve, join, dirname } = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')

const key = () => `${Date.now()}:${randomUUID()}`

function licensedSecurityDir() {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const candidates = [
    join(roaming, 'canvas-studio', 'data', 'security'),
    join(roaming, 'Electron', 'data', 'security'),
    join(roaming, 'canvas-studio', 'security')
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'license-current.json'))) return candidate
  }
  throw new Error('MACHINE_NOT_LICENSED')
}

function parseOption(name) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function round(n) {
  return Math.round(n * 100) / 100
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return round(sorted[idx])
}

async function runCli(electron, cliPath, dataDir, args, payload) {
  const inputFile = join(dataDir, `bench-input-${randomUUID()}.json`)
  if (payload) await writeFile(inputFile, JSON.stringify(payload))
  return await new Promise((resolveCall, reject) => {
    const child = spawn(
      electron,
      [cliPath, ...args, '--data-dir', dataDir, ...(payload ? ['--input-file', inputFile] : [])],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI_TIMEOUT:${args.join(' ')}`))
    }, 60000)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err = (err + c).slice(-1000)))
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try {
        resolveCall({ code, response: JSON.parse(out) })
      } catch {
        reject(new Error(`CLI_BAD_JSON:${code}:${err}`))
      }
    })
  })
}

async function seedLargeProject(electron, cliPath, dataDir, count) {
  const created = await runCli(electron, cliPath, dataDir, ['project', 'create'], {
    input: { name: `Bench-${count}-nodes` },
    idempotencyKey: key()
  })
  if (created.response.status !== 'completed') {
    throw new Error(`CREATE_FAILED:${JSON.stringify(created.response)}`)
  }
  const projectId = created.response.data.meta.id
  const opened = await runCli(electron, cliPath, dataDir, ['project', 'open'], {
    input: { projectId },
    idempotencyKey: key()
  })
  if (opened.response.status !== 'completed') {
    throw new Error(`OPEN_FAILED:${JSON.stringify(opened.response)}`)
  }

  const applyPatchBatch = async (ops, initialGv, label) => {
    let expected = initialGv
    for (let attempt = 0; attempt < 3; attempt++) {
      const patched = await runCli(electron, cliPath, dataDir, ['graph', 'patch'], {
        input: { projectId, expectedGraphVersion: expected, ops },
        idempotencyKey: key()
      })
      if (patched.response.status === 'completed') return patched.response.data
      if (
        patched.response.error?.code === 'REVISION_CONFLICT' &&
        typeof patched.response.error.currentGraphVersion === 'number'
      ) {
        expected = patched.response.error.currentGraphVersion
        continue
      }
      throw new Error(`${label}:${JSON.stringify(patched.response)}`)
    }
    throw new Error(`${label}:REVISION_CONFLICT_RETRY_EXHAUSTED`)
  }

  // 分批（每批 <= 150 ops，满足 GRAPH_PATCH_MAX_OPS=200）写入真实拓扑节点与连线
  let gv = 0
  const nodeIds = []
  const batchNodeSize = 80
  for (let start = 0; start < count; start += batchNodeSize) {
    const end = Math.min(count, start + batchNodeSize)
    const ops = []
    for (let i = start; i < end; i++) {
      const col = i % 10
      const row = Math.floor(i / 10)
      const mod = i % 3
      const nodeType = mod === 0 ? 'text' : mod === 1 ? 'image-gen' : 'video'
      ops.push({
        action: 'node.create',
        ref: `n${i}`,
        nodeType,
        title: `节点 ${i + 1}`,
        x: col * 420,
        y: row * 360,
        ...(nodeType === 'text' ? { text: `性能测试分镜文案 #${i + 1}` } : {})
      })
    }
    const data = await applyPatchBatch(ops, gv, 'PATCH_NODES_FAILED')
    gv = data.graphVersion
    for (const item of data.created) {
      nodeIds.push(item.nodeId)
    }
  }

  // 连线：每个 text(3k) -> image-gen(3k+1) -> video(3k+2)，构造密集真实连线（约 1N 条边；>200 边触发 Tier 2/3 边优化）
  const edgeOpsAll = []
  for (let i = 0; i + 2 < nodeIds.length; i += 3) {
    edgeOpsAll.push(
      {
        action: 'edge.create',
        from: { nodeId: nodeIds[i], portId: 'out-text' },
        to: { nodeId: nodeIds[i + 1], portId: 'in-text' }
      },
      {
        action: 'edge.create',
        from: { nodeId: nodeIds[i], portId: 'out-text' },
        to: { nodeId: nodeIds[i + 2], portId: 'in-text' }
      },
      {
        action: 'edge.create',
        from: { nodeId: nodeIds[i + 1], portId: 'out-image' },
        to: { nodeId: nodeIds[i + 2], portId: 'in-images' }
      }
    )
  }
  const batchEdgeSize = 150
  for (let start = 0; start < edgeOpsAll.length; start += batchEdgeSize) {
    const ops = edgeOpsAll.slice(start, start + batchEdgeSize)
    const data = await applyPatchBatch(ops, gv, 'PATCH_EDGES_FAILED')
    gv = data.graphVersion
  }
  return { projectId, graphVersion: gv, edgeCount: edgeOpsAll.length }
}

async function measureCanvas(app, page, electron, cliPath, dataDir, projectId, graphVersion, expectedNodes, edgeCount) {
  // 等待卡片渲染稳定
  await page.waitForTimeout(800)

  const perfInfo = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    await frame()
    await frame()
    const host = document.querySelector('.canvas-host[data-perf-tier]')
    const perfTier = host ? Number(host.getAttribute('data-perf-tier')) : null
    const mountedCards = document.querySelectorAll('.node-card').length
    const dormantCards = document.querySelectorAll('.node-card-dormant-shell').length
    const edgePaths = document.querySelectorAll('.data-edge-path').length
    return { perfTier, mountedCards, dormantCards, edgePaths }
  })

  // 先测量 30 帧连续节点拖拽（寻找视口内可见的卡片，真实鼠标按住顶部拖动）
  const dragBox = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.node-card'))
    for (const el of cards) {
      const r = el.getBoundingClientRect()
      if (r.width >= 100 && r.height >= 80 && r.left >= 40 && r.top >= 40 && r.right <= 1240 && r.bottom <= 760) {
        return { x: r.left, y: r.top, width: r.width, height: r.height }
      }
    }
    return null
  })
  let dragFrames = []
  if (dragBox) {
    const startX = dragBox.x + Math.min(80, dragBox.width / 2)
    const startY = dragBox.y + 18
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    const framePromise = page.evaluate(async () => {
      const times = []
      let prev = performance.now()
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => requestAnimationFrame(() => r()))
        const now = performance.now()
        times.push(now - prev)
        prev = now
      }
      return times
    })
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(startX + i * 4, startY + (i % 4) * 2)
    }
    await page.mouse.up()
    dragFrames = await framePromise
  }

  // 测量 30 帧连续滚轮平移/缩放（真实驱动 tldraw 视口、DataEdgeLayer 与离屏休眠）
  const panFrames = await page.evaluate(async () => {
    const target = document.querySelector('.tl-container') || document.body
    const times = []
    let prev = performance.now()
    for (let i = 0; i < 30; i++) {
      target.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 640,
          clientY: 360,
          deltaX: i % 2 === 0 ? 120 : -80,
          deltaY: i % 3 === 0 ? 90 : -60
        })
      )
      await new Promise((r) => requestAnimationFrame(() => r()))
      const now = performance.now()
      times.push(now - prev)
      prev = now
    }
    return times
  })

  // 经正式异步 IPC saveProject 测量落盘耗时（独立进程即将退出，不影响后续规模测试）
  const saveMetrics = await page.evaluate(async (pid) => {
    const opened = await window.api.openProject(pid)
    if (!opened.ok || !opened.data) return { ok: false, asyncSaveMs: -1, snapshotKB: 0 }
    const file = opened.data
    const bytes = new Blob([JSON.stringify(file)]).size
    const t0 = performance.now()
    const saved = await window.api.saveProject({
      id: pid,
      tldrawSnapshot: file.tldrawSnapshot,
      graph: { nodes: file.nodes, edges: file.edges, groups: file.groups },
      expectedGraphVersion: file.meta.graphVersion
    })
    const asyncSaveMs = performance.now() - t0
    return {
      ok: saved.ok,
      asyncSaveMs,
      snapshotKB: Math.round((bytes / 1024) * 100) / 100
    }
  }, projectId)

  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      type: m.type,
      workingSetMB: Math.round((m.memory.workingSetSize / 1024) * 100) / 100
    }))
  )

  const sortedPan = [...panFrames].sort((a, b) => a - b)
  const sortedDrag = [...dragFrames].sort((a, b) => a - b)
  const avgPan = panFrames.reduce((s, v) => s + v, 0) / Math.max(1, panFrames.length)
  const avgDrag = dragFrames.reduce((s, v) => s + v, 0) / Math.max(1, dragFrames.length)

  return {
    nodes: expectedNodes,
    edges: edgeCount,
    perfTier: perfInfo.perfTier,
    mountedCards: perfInfo.mountedCards,
    dormantCards: perfInfo.dormantCards,
    edgePaths: perfInfo.edgePaths,
    panZoom: {
      avgFps: round(1000 / Math.max(1, avgPan)),
      p50Ms: percentile(sortedPan, 0.5),
      p95Ms: percentile(sortedPan, 0.95)
    },
    drag: {
      avgFps: dragFrames.length ? round(1000 / Math.max(1, avgDrag)) : null,
      p50Ms: dragFrames.length ? percentile(sortedDrag, 0.5) : null,
      p95Ms: dragFrames.length ? percentile(sortedDrag, 0.95) : null
    },
    asyncSave: {
      ok: saveMetrics.ok,
      ms: round(saveMetrics.asyncSaveMs),
      snapshotKB: saveMetrics.snapshotKB
    },
    memory: {
      mainWorkingSetMB: metrics.find((m) => m.type === 'Browser')?.workingSetMB ?? null,
      rendererWorkingSetMB: metrics.find((m) => m.type === 'Tab')?.workingSetMB ?? null
    }
  }
}

async function main() {
  const sizesRaw = parseOption('--sizes') ?? '50,200,500'
  const sizes = sizesRaw
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  const outPath = parseOption('--out')

  const appRoot = resolve(__dirname, '..')
  const electron = require('electron')
  const cliPath = join(appRoot, 'out/main/local-agent.js')
  const results = []

  // 每个节点规模在独立隔离的 Electron 实例中测量，避免 V8 堆与缓存跨规模互相干扰。
  for (const count of sizes) {
    const dataDir = await mkdtemp(join(tmpdir(), `canvas-tier-bench-${count}-`))
    if (process.env.CANVAS_OWNER !== '1') {
      await cp(licensedSecurityDir(), join(dataDir, 'security'), { recursive: true })
    }
    const env = { ...process.env, CANVAS_DATA_DIR: dataDir }
    delete env.ELECTRON_RUN_AS_NODE

    let app
    try {
      app = await _electron.launch({
        executablePath: electron,
        args: [appRoot, '--local-agent-access'],
        env
      })
      const page = await app.firstWindow()
      await page.waitForLoadState()
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) win.setSize(1280, 800)
      })

      for (let i = 0; i < 100; i++) {
        try {
          await readFile(join(dataDir, 'agent-access/connection.json'))
          break
        } catch {
          await new Promise((r) => setTimeout(r, 200))
        }
      }

      const seeded = await seedLargeProject(electron, cliPath, dataDir, count)
      const measured = await measureCanvas(
        app,
        page,
        electron,
        cliPath,
        dataDir,
        seeded.projectId,
        seeded.graphVersion,
        count,
        seeded.edgeCount
      )
      results.push(measured)
      process.stderr.write(
        `[bench] ${count} nodes (tier=${measured.perfTier}, edges=${measured.edges}, mounted=${measured.mountedCards}, dormant=${measured.dormantCards}): pan=${measured.panZoom.avgFps}fps (p95=${measured.panZoom.p95Ms}ms), drag=${measured.drag.avgFps}fps (p95=${measured.drag.p95Ms}ms), asyncSave=${measured.asyncSave.ms}ms (${measured.asyncSave.snapshotKB}KB), mem(main/tab)=${measured.memory.mainWorkingSetMB}/${measured.memory.rendererWorkingSetMB}MB\n`
      )
    } finally {
      if (app) await app.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    viewport: { width: 1280, height: 800 },
    results
  }
  if (outPath) {
    const absOut = resolve(appRoot, outPath)
    await mkdir(dirname(absOut), { recursive: true })
    await writeFile(absOut, JSON.stringify(report, null, 2), 'utf-8')
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error('BENCHMARK_FAILED:', err)
  process.exitCode = 1
})
