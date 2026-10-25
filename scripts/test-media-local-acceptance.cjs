/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// P1-A 桌面验收驱动：隔离数据目录 + 隐藏真实 Electron（真实主进程 IPC、SQLite、ffmpeg）。
// 阶段1 execute：导入真实素材 → 单节点/选区/全图一致性 → 拆分与截取的运行中停止 →
//          固定结果 → 保存。阶段2 reopen：持久化核对、无自动生成、明确重试。
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, readdir, writeFile, cp, rm } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join, resolve, dirname } = require('node:path')
const { qaOutputPath } = require('./qa-output.cjs')

const ENTRY = resolve('out/main/media-local.js')
const EVIDENCE = qaOutputPath('qa/local-reliability/media-local-acceptance')
const PHASE_TIMEOUT_MS = Number(process.env.CANVAS_MEDIA_ACCEPTANCE_TIMEOUT || 480000)

function ffmpegBinary() {
  return process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg'
}

function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const probe = require('node:net').createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('MEDIA_VITE_PORT_RESERVATION_FAILED')))
        return
      }
      const port = address.port
      probe.close((error) => {
        if (error) reject(error)
        else resolvePort(port)
      })
    })
  })
}

async function cleanDirectory(directory) {
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-local-media-')
  ) {
    throw new Error('MEDIA_CLEANUP_REJECTED')
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(String(code)) && attempt < 4) {
        await new Promise((done) => setTimeout(done, 250))
        continue
      }
      if (attempt === 4) throw error
    }
  }
}

/** 大尺寸 PNG：四象限纯色，便于拆分/裁剪尺寸与内容核对；PNG 压缩后体积很小。 */
async function writeFixturePng(path) {
  const { createCanvas } = require('@napi-rs/canvas')
  const width = 6000
  const height = 4000
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const quadrants = [
    ['#c0392b', 0, 0],
    ['#27ae60', width / 2, 0],
    ['#2980b9', 0, height / 2],
    ['#f39c12', width / 2, height / 2]
  ]
  for (const [color, x, y] of quadrants) {
    ctx.fillStyle = color
    ctx.fillRect(x, y, width / 2, height / 2)
  }
  await writeFile(path, canvas.toBuffer('image/png'))
}

/** 90 秒 720p 测试视频：ultrafast 生成，供快速截取（复制）与精确重编码停止验收。 */
function writeFixtureMp4(path) {
  return new Promise((resolveJob, reject) => {
    const child = spawn(
      ffmpegBinary(),
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=24:duration=90',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=90',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-shortest',
        path
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-2000)))
    child.once('error', (error) => {
      reject(
        new Error(
          (error && error.code === 'ENOENT'
            ? '未找到本机 FFmpeg；请安装或设置 CANVAS_STUDIO_FFMPEG_PATH'
            : error.message) + `（用于生成 90 秒测试视频）`
        )
      )
    })
    child.once('close', (code) => {
      if (code === 0) resolveJob()
      else reject(new Error(`fixture mp4 生成失败：${stderr.trim() || `退出码 ${code}`}`))
    })
  })
}

async function runElectronPhase(directory, phase, rendererUrl) {
  const env = { ...process.env, CANVAS_MEDIA_RENDERER_URL: rendererUrl }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((done, reject) => {
    const child = spawn(
      require('electron'),
      [ENTRY, `--media-directory=${directory}`, `--media-phase=${phase}`],
      { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`MEDIA_ELECTRON_TIMEOUT:${phase}`))
    }, PHASE_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      done({ code, stderr })
    })
  })
}

/** 递归收集 JSONL 诊断事件与 electron-log 主日志文本，供终态配对与脱敏断言。 */
async function collectDiagnostics(directory) {
  const events = []
  let mainLog = ''
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
        continue
      }
      const text = await readFile(target, 'utf8')
      if (entry.name.endsWith('.jsonl')) {
        for (const line of text.trim().split('\n')) {
          if (!line.trim()) continue
          try {
            events.push(JSON.parse(line))
          } catch {
            // 坏行计入诊断但不参与配对。
          }
        }
      }
      if (entry.name.includes('main.log') || entry.name.includes('renderer.log')) {
        mainLog += text
      }
    }
  }
  const diagnosticsDir = join(directory, 'diagnostics')
  if (existsSync(diagnosticsDir)) await walk(diagnosticsDir)
  const logsDir = join(directory, 'logs')
  if (existsSync(logsDir)) {
    for (const entry of await readdir(logsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('main')) {
        mainLog += await readFile(join(logsDir, entry.name), 'utf8')
      }
    }
  }
  return { events, mainLog }
}

async function main() {
  if (!existsSync(ENTRY)) {
    throw new Error('MEDIA_ENTRY_MISSING：先运行 electron-vite build 生成 out/main/media-local.js')
  }
  await mkdir(EVIDENCE, { recursive: true })
  const directory = await mkdtemp(join(tmpdir(), 'canvas-local-media-'))
  const rendererPort = await reserveLoopbackPort()
  const rendererUrl = `http://127.0.0.1:${rendererPort}`
  const viteServer = spawn(
    process.execPath,
    [
      join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
      '--config',
      'vite.browser.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(rendererPort),
      '--strictPort'
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  try {
    const deadline = Date.now() + 30000
    for (;;) {
      if (viteServer.exitCode !== null) throw new Error('MEDIA_VITE_UNAVAILABLE')
      try {
        const [index, editorModule] = await Promise.all([
          fetch(rendererUrl),
          fetch(`${rendererUrl}/src/stores/editor.ts`)
        ])
        const type = editorModule.headers.get('content-type') ?? ''
        if (index.ok && editorModule.ok && !type.includes('text/html')) break
      } catch {
        /* 有界等待 */
      }
      if (Date.now() > deadline) throw new Error('MEDIA_VITE_TIMEOUT')
      await new Promise((done) => setTimeout(done, 250))
    }

    process.stdout.write('生成验收素材：6000×4000 PNG + 90 秒 720p MP4…\n')
    await writeFixturePng(join(directory, 'acceptance-source.png'))
    await writeFixtureMp4(join(directory, 'acceptance-long.mp4'))

    process.stdout.write('阶段1 execute：一致性 + 运行中停止 + 固定结果…\n')
    const execute = await runElectronPhase(directory, 'execute', rendererUrl)
    const executeReportPath = join(directory, 'media-execute-report.json')
    const executeReport = existsSync(executeReportPath)
      ? JSON.parse(await readFile(executeReportPath, 'utf8'))
      : null
    if (execute.code !== 0 || executeReport?.status !== 'pass') {
      throw new Error(
        `MEDIA_EXECUTE_FAILED:code=${execute.code};report=${JSON.stringify(executeReport)};stderr=${execute.stderr.slice(-800)}`
      )
    }

    const { events, mainLog } = await collectDiagnostics(directory)
    // 主进程真终止证据：media.transform.cancelled 至少一次，且没有正文/路径/密钥。
    const cancelledEvents = mainLog
      .split('\n')
      .filter((line) => line.includes('media.transform.cancelled'))
    assert.ok(cancelledEvents.length >= 1, 'MEDIA_CANCEL_LOG_MISSING：主进程未记录本地媒体终止')
    for (const line of cancelledEvents) {
      const parsed = JSON.parse(line.slice(line.indexOf('{')))
      assert.ok(parsed.cancelled >= 1, 'MEDIA_CANCEL_COUNT_INVALID')
      assert.ok(!line.includes('acceptance-'), 'MEDIA_CANCEL_LOG_LEAKED_PATH')
    }
    // 节点取消有唯一终态；工作流开始/终态按 trace/span 配对。
    const nodeCancelled = events.filter((event) => event.event === 'node.cancelled')
    assert.ok(nodeCancelled.length >= 2, 'MEDIA_NODE_CANCELLED_DIAGNOSTIC_MISSING')
    const nodeStarted = events.filter((event) => event.event === 'node.started')
    const nodeTerminal = events.filter((event) =>
      ['node.completed', 'node.failed', 'node.cancelled', 'node.skipped'].includes(event.event)
    )
    const pairKey = (event) => `${event.traceId}/${event.nodeId}`
    const terminalKeys = new Set(nodeTerminal.map(pairKey))
    for (const start of nodeStarted) {
      assert.ok(terminalKeys.has(pairKey(start)), `MEDIA_NODE_LIFECYCLE_UNPAIRED:${pairKey(start)}`)
    }
    const workflowStarted = events.filter((event) => event.event === 'workflow.started')
    const workflowTerminal = events.filter((event) =>
      ['workflow.completed', 'workflow.failed', 'workflow.cancelled'].includes(event.event)
    )
    assert.equal(
      workflowStarted.length,
      workflowTerminal.length,
      'MEDIA_WORKFLOW_LIFECYCLE_UNPAIRED'
    )
    // 脱敏：诊断不得包含素材绝对路径或数据目录。
    const serialized = JSON.stringify(events)
    assert.ok(!serialized.includes(directory), 'MEDIA_DIAGNOSTICS_LEAKED_DIRECTORY')
    assert.ok(!serialized.includes('acceptance-source.png'), 'MEDIA_DIAGNOSTICS_LEAKED_FILE_NAME')

    process.stdout.write('阶段2 reopen：持久化核对 + 无自动生成 + 明确重试…\n')
    const reopen = await runElectronPhase(directory, 'reopen', rendererUrl)
    const reopenReportPath = join(directory, 'media-reopen-report.json')
    const reopenReport = existsSync(reopenReportPath)
      ? JSON.parse(await readFile(reopenReportPath, 'utf8'))
      : null
    if (reopen.code !== 0 || reopenReport?.status !== 'pass') {
      throw new Error(
        `MEDIA_REOPEN_FAILED:code=${reopen.code};report=${JSON.stringify(reopenReport)};stderr=${reopen.stderr.slice(-800)}`
      )
    }

    await cp(executeReportPath, join(EVIDENCE, 'media-execute-report.json'))
    await cp(reopenReportPath, join(EVIDENCE, 'media-reopen-report.json'))
    await cp(join(directory, 'media-state.json'), join(EVIDENCE, 'media-state.json'))
    await cp(join(directory, 'diagnostics'), join(EVIDENCE, 'diagnostics'), { recursive: true })
    await writeFile(
      join(EVIDENCE, 'results.json'),
      JSON.stringify(
        {
          status: 'passed',
          execute: {
            cropResultCount: executeReport.cropResultCount,
            splitResultCount: executeReport.splitResultCount,
            stopAttempts: executeReport.stopAttempts,
            clipStopAttempts: executeReport.clipStopAttempts,
            audioStopAttempts: executeReport.audioStopAttempts,
            audioStopHit: executeReport.audioStopHit,
            audioResultCount: executeReport.audioResultCount,
            vocalResultCount: executeReport.vocalResultCount,
            qualitySeparator: executeReport.qualitySeparator,
            mediaCount: executeReport.mediaCount
          },
          reopen: reopenReport,
          diagnostics: {
            events: events.length,
            nodeCancelled: nodeCancelled.length,
            mediaTransformCancelledLogs: cancelledEvents.length,
            workflowStarted: workflowStarted.length
          },
          fixture: 'real local PNG/MP4 via napi-rs + ffmpeg; isolated data dir; no provider calls'
        },
        null,
        2
      )
    )
    process.stdout.write(
      `本地媒体桌面验收通过：裁剪/拆图/截取一致性、运行中停止（拆图回滚 + ffmpeg 终止，${cancelledEvents.length} 条主进程终止记录）、保存重开与明确重试全部通过。\n`
    )
  } finally {
    viteServer.kill()
    await cleanDirectory(directory)
  }
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch((error) => {
    process.stderr.write(String(error?.stack || error) + '\n')
    process.exitCode = 1
  })
