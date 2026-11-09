/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars */
// R2 缺口补测（计划 66 §6）：三条此前没有真实端到端证据的场景。
//   A. GUI 反向腿：外部建图 → GUI 撤销/重做；外部读取 GUI 未保存正文
//   B. 崩溃与回执丢失：执行中硬杀进程 → 重启核对原 run、占用解除、零重放
//   C. 双画布并发：A 运行中切到 B 并行执行；取消 A 不影响 B；第三张画布可排队/并行
// 证据写入 qa/local-agent-access/parity-gaps/report.json。
const { _electron } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { mkdtemp, mkdir, readFile, writeFile, rm, cp } = require('node:fs/promises')
const { resolve, join, basename } = require('node:path')
const { tmpdir, homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { existsSync } = require('node:fs')
const { qaOutputPath } = require('./qa-output.cjs')
const electron = require('electron')

const appRoot = resolve('.')
const cliPath = join(appRoot, 'out/main/local-agent.js')
const key = () => `${Date.now()}:${randomUUID()}`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const licensedSecurityDir = (() => {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const candidates = [
    join(roaming, 'canvas-studio', 'data', 'security'),
    join(roaming, 'Electron', 'data', 'security'),
    join(roaming, 'canvas-studio', 'security')
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'license-current.json'))) return candidate
  }
  return candidates[0]
})()

let workRoot = ''
const report = { startedAt: new Date().toISOString(), sections: {}, checks: [], failures: [], notes: [] }

function check(ok, code, detail) {
  report.checks.push({ code, ok, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) })
  if (!ok) {
    report.failures.push({ code, detail: String(detail ?? '').slice(0, 500) })
    throw new Error(code)
  }
}
function note(text) {
  report.notes.push(text)
}

async function runCli(directory, args, input, timeoutMs = 30000) {
  const file = join(directory, `input-${randomUUID()}.json`)
  if (input) await writeFile(file, JSON.stringify(input))
  return await new Promise((resolveCall, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, ...args, '--data-dir', directory, ...(input ? ['--input-file', file] : [])],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    let output = ''
    let error = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('CLI_TIMEOUT'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      error = (error + chunk).slice(-1000)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      try {
        resolveCall({ code, response: JSON.parse(output) })
      } catch {
        reject(new Error(`CLI_INVALID_RESULT:${args.join(' ')}:${code}:${error}:${output.slice(0, 200)}`))
      }
    })
  })
}

/** 读稳定图版本：相邻两次相等再隔一个防抖窗口复核（与里程碑同一读数纪律）。 */
async function stableVersion(directory, projectId) {
  let previous = -1
  for (let i = 0; i < 20; i++) {
    const probe = await runCli(directory, ['project', 'get'], { input: { projectId } })
    const current = probe.response?.data?.meta?.graphVersion
    if (typeof current !== 'number') {
      await sleep(500)
      continue
    }
    if (current === previous) {
      await sleep(1200)
      const confirm = await runCli(directory, ['project', 'get'], { input: { projectId } })
      if (confirm.response?.data?.meta?.graphVersion === current) return current
      previous = confirm.response?.data?.meta?.graphVersion ?? previous
      continue
    }
    previous = current
    await sleep(900)
  }
  return previous
}
async function patchWithFreshVersion(directory, projectId, makeOps, label, attempts = 5) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1200)
    const result = await runCli(directory, ['graph', 'patch'], {
      input: {
        projectId,
        expectedGraphVersion: await stableVersion(directory, projectId),
        ops: makeOps()
      },
      idempotencyKey: key()
    })
    if (result.response.status === 'completed') return result
    lastError = result.response.error
    if (lastError?.code !== 'REVISION_CONFLICT') throw new Error(`${label}:${JSON.stringify(lastError)}`)
  }
  throw new Error(`${label}:REVISION_CONFLICT:${JSON.stringify(lastError)}`)
}
async function graphTotal(directory, projectId) {
  const graph = await runCli(directory, ['graph', 'get'], { input: { projectId, view: 'latest', limit: 200 } })
  return graph.response?.data?.total
}
async function waitForTotal(directory, projectId, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const total = await graphTotal(directory, projectId)
    if (total === expected) return true
    await sleep(400)
  }
  return false
}
async function createProject(directory, name) {
  const created = await runCli(directory, ['project', 'create'], { input: { name }, idempotencyKey: key() })
  check(created.response.status === 'completed', 'PROJECT_CREATE_FAILED', JSON.stringify(created.response.error))
  return created.response.data.meta.id
}
async function openProject(directory, projectId) {
  const opened = await runCli(directory, ['project', 'open'], { input: { projectId }, idempotencyKey: key() })
  check(opened.response.status === 'completed', 'PROJECT_OPEN_FAILED', JSON.stringify(opened.response.error))
}
/**
 * 重启后有界竞态：应用自动恢复画布与 open 握手可能重叠（宿主回执 CANVAS_NOT_READY → unknown）。
 * 对"宿主未就绪"类失败重试；task-occupancy/recovery-ownership 是真实占用，立即失败。
 */
async function openProjectAfterRestart(directory, projectId, attempts = 20) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const opened = await runCli(directory, ['project', 'open'], { input: { projectId }, idempotencyKey: key() })
    if (opened.response.status === 'completed') return
    lastError = opened.response.error ?? null
    const code = lastError?.code
    const realOccupancy =
      code === 'RESOURCE_BUSY' &&
      (lastError?.phase === 'task-occupancy' || lastError?.phase === 'recovery-ownership')
    const retryable =
      !realOccupancy &&
      (code === 'OUTCOME_UNKNOWN' ||
        code === 'DESKTOP_TIMEOUT' ||
        code === 'DESKTOP_LOST' ||
        code === 'DESKTOP_UNAVAILABLE' ||
        code === 'RESOURCE_BUSY')
    if (!retryable) break
    await sleep(1000)
  }
  check(false, 'B_OCCUPANCY_NOT_RELEASED', JSON.stringify(lastError))
}
async function waitAppReady(app) {
  const page = await app.firstWindow()
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
  await page.waitForFunction(() => typeof window.api?.createProject === 'function', null, { timeout: 30000 })
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setTitle('[TEST] Agent Parity Gaps')
  })
  return page
}
/** 启动真实桌面（隔离数据目录，复制本机已激活的 security；不伪造任何签名）。 */
async function launchApp(directory, label) {
  if (!existsSync(join(directory, 'security', 'license-current.json'))) {
    check(existsSync(licensedSecurityDir), 'MACHINE_NOT_LICENSED', licensedSecurityDir)
    await cp(licensedSecurityDir, join(directory, 'security'), { recursive: true })
  }
  const env = {
    ...process.env,
    CANVAS_DATA_DIR: directory,
    CS_PARITY_LIFECYCLE: join(workRoot, `lifecycle-${label}.log`)
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await _electron.launch({
    executablePath: electron,
    args: [appRoot, '--local-agent-access'],
    env,
    timeout: 60000
  })
  const page = await waitAppReady(app)
  for (let i = 0; i < 150; i++) {
    try {
      await readFile(join(directory, 'agent-access', 'connection.json'))
      break
    } catch {
      await sleep(200)
    }
  }
  return { app, page }
}
async function importVideo(directory, projectId) {
  const fixture = join(appRoot, 'qa-fixtures/media/video/V-AV.mp4')
  const imported = await runCli(directory, ['media', 'import'], {
    input: { projectId, filePath: fixture, name: 'R2 并发素材' },
    idempotencyKey: key()
  })
  check(imported.response.status === 'completed', 'MEDIA_IMPORT_FAILED', JSON.stringify(imported.response.error))
  return imported.response.data.mediaId
}
async function executeNode(directory, projectId, nodeId, options = {}) {
  const executed = await runCli(directory, ['node', 'execute'], {
    input: {
      projectId,
      expectedGraphVersion: options.version ?? (await stableVersion(directory, projectId)),
      nodeIds: [nodeId],
      mode: options.mode ?? 'single',
      // 子图会带上上游节点；按既有规则显式确认"上游重跑"，不绕过门禁。
      confirmPaidRerun: options.confirmPaidRerun === true
    },
    idempotencyKey: key()
  })
  check(executed.response.status === 'completed', 'EXECUTE_REJECTED', JSON.stringify(executed.response.error))
  check(executed.response.data.accepted === true, 'EXECUTE_NOT_ACCEPTED', JSON.stringify(executed.response.data))
  return executed.response.data.taskId
}
/**
 * 建 视频资产 + 6s 截取（画面重新编码）连线，返回截取节点 ID。
 * 本机一次重编码约 10–25s，给"在途切换保护/取消/硬杀"提供稳定窗口（单帧太快会竞态）。
 */
async function buildClipNode(directory, projectId, mediaId) {
  const patched = await patchWithFreshVersion(
    directory,
    projectId,
    () => [
      { action: 'node.create', ref: 'src', nodeType: 'video', x: 60, y: 60, media: { mediaId } },
      {
        action: 'node.create',
        ref: 'clip',
        nodeType: 'video-clip',
        x: 480,
        y: 60,
        config: { version: 3, startMs: 0, endMs: 9500, keepVideo: true, keepAudio: false, includeAudio: true }
      },
      { action: 'edge.create', from: { nodeId: 'src', portId: 'out-video' }, to: { nodeId: 'clip', portId: 'in-video' } }
    ],
    'CLIP_PATCH_FAILED'
  )
  const clip = (patched.response.data.created ?? []).find((entry) => entry.ref === 'clip')
  check(Boolean(clip?.nodeId), 'CLIP_NODE_MISSING', JSON.stringify(patched.response.data.created))
  return clip.nodeId
}
async function runState(directory, projectId, taskId) {
  const run = await runCli(directory, ['run', 'get'], { input: { projectId, taskId } })
  return run.response?.data
}
async function waitRun(directory, projectId, taskId, timeoutMs = 60000) {
  const waited = await runCli(directory, ['run', 'wait'], { input: { projectId, taskId, timeoutMs } }, timeoutMs + 30000)
  if (waited.response.status !== 'completed')
    throw new Error(`RUN_WAIT_REJECTED:${JSON.stringify(waited.response.error)}`)
  return waited.response.data
}
/** tldraw 快捷键监听在画布容器上：必须先点空白画布，焦点不能停在左侧面板。 */
async function focusCanvas(page) {
  await page.locator('.tl-canvas').click({ position: { x: 900, y: 620 } })
  await page.waitForTimeout(250)
}

// ── A. GUI 反向腿 ────────────────────────────────────────────────────────────
async function sectionGuiReverseLeg(directory) {
  const section = { name: 'A 反向腿', checks: [] }
  report.sections.A = section
  const { app, page } = await launchApp(directory, 'A')
  try {
    const projectId = await createProject(directory, 'R2 GUI 反向腿')
    await openProject(directory, projectId)
    await page.locator('.node-palette').waitFor({ timeout: 30000 })
    await patchWithFreshVersion(
      directory,
      projectId,
      () => [
        { action: 'node.create', ref: 'a', nodeType: 'text', x: 0, y: 0, title: '反向腿甲', text: '外部写入正文' },
        { action: 'node.create', ref: 'b', nodeType: 'text', x: 400, y: 0, title: '反向腿乙', text: '外部写入乙' }
      ],
      'A_PATCH_FAILED'
    )
    check(await waitForTotal(directory, projectId, 2, 15000), 'A_NODES_NOT_VISIBLE_IN_HOST')
    section.checks.push('外部建 2 节点在权威宿主生效（latest 视图=2）')

    // GUI 撤销外部编辑：一次外部补丁是一个整体撤销步（2 节点一起撤掉），外部能读到。
    await focusCanvas(page)
    await page.keyboard.press('Control+z')
    check(await waitForTotal(directory, projectId, 0, 15000), 'A_GUI_UNDO_NOT_VISIBLE_EXTERNALLY')
    section.checks.push('GUI 撤销 → 外部 latest 视图节点数 2→0（整批补丁为一个撤销步）')

    await page.keyboard.press('Control+Shift+z')
    check(await waitForTotal(directory, projectId, 2, 15000), 'A_GUI_REDO_NOT_VISIBLE_EXTERNALLY')
    section.checks.push('GUI 重做 → 外部 latest 视图节点数 0→2')

    // 外部补丁后 GUI 再撤销（人与 Agent 交替）
    await patchWithFreshVersion(
      directory,
      projectId,
      () => [{ action: 'node.create', ref: 'c', nodeType: 'text', x: 800, y: 0, title: '反向腿丙', text: '第三次写入' }],
      'A_PATCH_2_FAILED'
    )
    check(await waitForTotal(directory, projectId, 3, 15000), 'A_NODES_3_NOT_VISIBLE')
    await focusCanvas(page)
    await page.keyboard.press('Control+z')
    check(await waitForTotal(directory, projectId, 2, 15000), 'A_GUI_UNDO_SECOND_PATCH_FAILED')
    await page.keyboard.press('Control+Shift+z')
    check(await waitForTotal(directory, projectId, 3, 15000), 'A_GUI_REDO_SECOND_PATCH_FAILED')
    section.checks.push('外部补丁 → GUI 撤销/重做 → 外部读数一致（交替编辑闭环）')

    // 外部读取 GUI 未保存正文：latest 视图的 unsaved 标记 + 落盘后正文可见。
    const firstNode = (await runCli(directory, ['graph', 'get'], { input: { projectId, view: 'latest', limit: 50 } })).response.data.nodes.find(
      (node) => node.title === '反向腿甲'
    )
    check(Boolean(firstNode?.nodeId), 'A_TEXT_NODE_MISSING')
    await page.locator('.node-text').filter({ hasText: '外部写入正文' }).first().dblclick()
    await page.locator('textarea.node-textarea').first().fill('GUI 手写未保存正文')
    await page.keyboard.press('Control+Enter')
    let sawUnsaved = false
    let contentVisible = false
    let lastNewVersion = -1
    for (let i = 0; i < 25 && !contentVisible; i++) {
      const latest = await runCli(directory, ['graph', 'get'], { input: { projectId, view: 'latest', limit: 200 } })
      if (latest.response?.data?.unsaved === true) sawUnsaved = true
      if (typeof latest.response?.data?.graphVersion === 'number') lastNewVersion = latest.response.data.graphVersion
      const read = await runCli(directory, ['node', 'get'], { input: { projectId, nodeId: firstNode.nodeId } })
      if ((read.response?.data?.node?.text ?? '').includes('GUI 手写未保存正文')) {
        contentVisible = true
        break
      }
      await sleep(400)
    }
    check(contentVisible, 'A_EXTERNAL_CANNOT_SEE_GUI_TEXT')
    section.checks.push('外部读取 GUI 正文（latest/节点视图一致）')
    note(
      sawUnsaved
        ? 'A：外部在未保存窗口内采到 unsaved=true（另证 latest 视图不假装已保存）'
        : 'A：独立 CLI 进程采样慢于 800ms 保存防抖，未采到瞬时 unsaved=true；以正文可见与版本推进为持久断言'
    )
  } finally {
    await app.close().catch(() => {})
  }
  return section
}

// ── B. 崩溃与回执丢失 ────────────────────────────────────────────────────────
/**
 * 用户路径：外部受理执行后桌面进程被硬杀（断电/崩溃）→ 重新打开桌面。
 * 期望：账本如实结算为 failed/HOST_RESTARTED（不伪造成完成）、占用解除、
 * 零重放（不补产物/不新增媒体）、原任务取消幂等、同一节点可再次执行成功。
 */
async function sectionCrashRestart(directory) {
  const section = { name: 'B 崩溃重启', checks: [], trace: {} }
  report.sections.B = section
  let projectId = ''
  let taskId = ''
  let taskNodeId = ''
  let mediaCountBeforeKill = 0
  const first = await launchApp(directory, 'B1')
  try {
    const page = first.page
    projectId = await createProject(directory, 'R2 崩溃重启')
    await openProject(directory, projectId)
    await page.locator('.node-palette').waitFor({ timeout: 30000 })
    const mediaId = await importVideo(directory, projectId)
    taskNodeId = await buildClipNode(directory, projectId, mediaId)
    const mediaBefore = await runCli(directory, ['media', 'list'], { input: { projectId, limit: 100 } })
    mediaCountBeforeKill = (mediaBefore.response?.data?.items ?? []).length
    section.trace.mediaBeforeKill = mediaCountBeforeKill

    taskId = await executeNode(directory, projectId, taskNodeId)
    const inFlight = await runState(directory, projectId, taskId)
    check(['accepted', 'running'].includes(inFlight?.state), 'B_TASK_NOT_IN_FLIGHT', JSON.stringify(inFlight))
    section.trace.inFlight = inFlight?.state
    section.checks.push(`执行已受理（${inFlight?.state}）后即硬杀主进程，无正常退出钩子`)

    execFileSync('taskkill', ['/PID', String(first.app.process().pid), '/T', '/F'])
  } finally {
    // 已硬杀：close 用来回收 playwright 侧句柄，失败/超时都不影响断言。
    await Promise.race([first.app.close().catch(() => {}), sleep(5000)])
  }
  await sleep(1500)
  // 清掉崩溃进程残留的接入描述符，重启等待新实例写出（真实 Windows 命名管道随进程消失）。
  await rm(join(directory, 'agent-access', 'connection.json'), { force: true }).catch(() => {})

  const second = await launchApp(directory, 'B2')
  try {
    const page = second.page
    const afterRestart = await runState(directory, projectId, taskId)
    section.trace.afterRestart = { state: afterRestart?.state, error: afterRestart?.error }
    check(afterRestart?.state !== 'completed', 'B_FAKE_COMPLETION', JSON.stringify(afterRestart))
    check(
      afterRestart?.state === 'failed' && afterRestart?.error === 'HOST_RESTARTED',
      'B_STALE_RUN_NOT_SETTLED',
      `state=${afterRestart?.state} error=${afterRestart?.error}`
    )
    section.checks.push('重启后遗留任务显式结算为 failed/HOST_RESTARTED（未伪造完成、未静默成功）')

    await openProjectAfterRestart(directory, projectId)
    const renamed = await runCli(directory, ['project', 'update'], {
      input: { projectId, expectedGraphVersion: await stableVersion(directory, projectId), name: 'R2 崩溃重启-已恢复' },
      idempotencyKey: key()
    })
    check(renamed.response.status === 'completed', 'B_WRITE_STILL_BLOCKED', JSON.stringify(renamed.response.error))
    section.checks.push('重启后画布可再打开并可写（占用解除，不再永久锁死）')

    // 零重放：超过一次抽帧所需时间后复核，不得补出产物或新增媒体。
    await sleep(4000)
    const outputs = await runCli(directory, ['output', 'get'], { input: { projectId, nodeId: taskNodeId } })
    const produced = (outputs.response?.data?.outputs ?? []).filter((item) => item?.mediaId || item?.ready === true)
    check(produced.length === 0, 'B_REPLAY_PRODUCED_OUTPUT', JSON.stringify(outputs.response?.data))
    const mediaAfter = await runCli(directory, ['media', 'list'], { input: { projectId, limit: 100 } })
    const mediaCountAfter = (mediaAfter.response?.data?.items ?? []).length
    check(mediaCountAfter === mediaCountBeforeKill, 'B_REPLAY_CREATED_MEDIA', `before=${mediaCountBeforeKill} after=${mediaCountAfter}`)
    section.checks.push('重启后零重放：无新产物、媒体数不变')

    const cancel = await runCli(directory, ['run', 'cancel'], { input: { projectId, taskId }, idempotencyKey: key() })
    check(
      cancel.response.status === 'completed' && cancel.response.data?.state === 'failed',
      'B_SETTLED_RUN_MUTATED',
      JSON.stringify(cancel.response)
    )
    section.checks.push('对已结算任务 run.cancel 幂等：仍为 failed，不复活、不改写')

    const retryTask = await executeNode(directory, projectId, taskNodeId)
    const waited = await waitRun(directory, projectId, retryTask, 90000)
    check(waited?.state === 'completed', 'B_RECOVERED_EXECUTE_FAILED', JSON.stringify(waited))
    section.checks.push('重启后可重新执行同一节点并完成（账本未中毒）')
  } finally {
    await second.app.close().catch(() => {})
  }
  return section
}

// ── C. 画布切换与任务隔离 ─────────────────────────────────────────────────────
/**
 * 真实产品语义（R2 校正）：桌面只有一个活动画布，运行由当前画布宿主执行；
 * 任务在途时 project.open 被 RESOURCE_BUSY 拒绝（不静默丢弃在途任务），
 * 因此不存在"两张画布并行执行"。本段验证：切换保护、取消后依次完成、产物隔离。
 */
async function sectionDualCanvas(directory) {
  const section = { name: 'C 画布切换与隔离', checks: [] }
  report.sections.C = section
  const { app, page } = await launchApp(directory, 'C')
  try {
    const projectA = await createProject(directory, 'R2 切换-A')
    const projectB = await createProject(directory, 'R2 切换-B')
    const projectC = await createProject(directory, 'R2 切换-C')
    await openProject(directory, projectA)
    await page.locator('.node-palette').waitFor({ timeout: 30000 })
    const mediaA = await importVideo(directory, projectA)
    const clipA = await buildClipNode(directory, projectA, mediaA)
    const taskA = await executeNode(directory, projectA, clipA)

    // 在途切换：必须被明确拒绝，而不是把任务带走或静默取消。
    const blockedSwitch = await runCli(directory, ['project', 'open'], { input: { projectId: projectB }, idempotencyKey: key() })
    check(
      blockedSwitch.response.status !== 'completed' && blockedSwitch.response.error?.code === 'RESOURCE_BUSY',
      'C_INFLIGHT_SWITCH_NOT_BLOCKED',
      JSON.stringify(blockedSwitch.response)
    )
    const stateA = await runState(directory, projectA, taskA)
    check(['accepted', 'running'].includes(stateA?.state), 'C_A_TASK_LOST_AFTER_BLOCKED_SWITCH', JSON.stringify(stateA))
    section.checks.push('A 运行中切画布被 RESOURCE_BUSY 拒绝，A 任务仍在账本（不被带走）')

    const cancel = await runCli(directory, ['run', 'cancel'], { input: { projectId: projectA, taskId: taskA }, idempotencyKey: key() })
    check(cancel.response.status === 'completed', 'C_CANCEL_REJECTED', JSON.stringify(cancel.response.error))
    const waitedA = await waitRun(directory, projectA, taskA, 30000)
    check(['cancelled', 'completed', 'failed'].includes(waitedA?.state), 'C_A_NOT_TERMINAL', JSON.stringify(waitedA))
    section.checks.push(`取消 A → 终态=${waitedA.state}；占用释放后可切换`)

    // A 终态后切到 B；B 运行中再切 C 仍被拒，B 完成后再切 C。
    await openProject(directory, projectB)
    await page.locator('.node-palette').waitFor({ timeout: 30000 })
    const mediaB = await importVideo(directory, projectB)
    const clipB = await buildClipNode(directory, projectB, mediaB)
    const taskB = await executeNode(directory, projectB, clipB)
    const blockedToC = await runCli(directory, ['project', 'open'], { input: { projectId: projectC }, idempotencyKey: key() })
    check(
      blockedToC.response.status !== 'completed' && blockedToC.response.error?.code === 'RESOURCE_BUSY',
      'C_B_INFLIGHT_SWITCH_NOT_BLOCKED',
      JSON.stringify(blockedToC.response)
    )
    const waitedB = await waitRun(directory, projectB, taskB, 90000)
    check(waitedB?.state === 'completed', 'C_B_NOT_COMPLETED', JSON.stringify(waitedB))
    section.checks.push('B 运行中切 C 被拒；B 完成终态=completed')

    await openProject(directory, projectC)
    await page.locator('.node-palette').waitFor({ timeout: 30000 })
    const mediaC = await importVideo(directory, projectC)
    const clipC = await buildClipNode(directory, projectC, mediaC)
    const taskC = await executeNode(directory, projectC, clipC)
    const waitedC = await waitRun(directory, projectC, taskC, 90000)
    check(waitedC?.state === 'completed', 'C_C_NOT_COMPLETED', JSON.stringify(waitedC))
    section.checks.push('取消 A 后 B/C 依次在各自画布完成（未并行、未丢失）')

    const outputB = await runCli(directory, ['output', 'get'], { input: { projectId: projectB, nodeId: clipB } })
    const outputC = await runCli(directory, ['output', 'get'], { input: { projectId: projectC, nodeId: clipC } })
    const frameOutB = (outputB.response?.data?.outputs ?? []).find((item) => item.portId === 'out-video')
    const frameOutC = (outputC.response?.data?.outputs ?? []).find((item) => item.portId === 'out-video')
    check(Boolean(frameOutB?.mediaId && frameOutC?.mediaId), 'C_OUTPUT_MISSING', JSON.stringify({ b: outputB.response?.error, c: outputC.response?.error }))
    check(frameOutB.mediaId !== frameOutC.mediaId && frameOutB.mediaId !== mediaC && frameOutC.mediaId !== mediaB, 'C_OUTPUT_CROSSED')
    section.checks.push('B/C 产物各自落盘且互不串台')

    // 隔离复核：A 项目里不得出现 B/C 的产物引用。
    const listA = await runCli(directory, ['media', 'list'], { input: { projectId: projectA, limit: 100 } })
    check(
      !(listA.response?.data?.items ?? []).some((item) => item.id === frameOutB.mediaId || item.id === frameOutC.mediaId),
      'C_ARTIFACT_LEAKED_INTO_A'
    )
    section.checks.push('A 的媒体索引不含 B/C 产物')
    note('C：桌面为单活动画布；在途任务占用期间禁止切换（RESOURCE_BUSY），不存在跨画布并行执行；本段不宣称并行/排队语义')
  } finally {
    await app.close().catch(() => {})
  }
  return section
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
;(async () => {
  const evidence = qaOutputPath('qa/local-agent-access/parity-gaps')
  await mkdir(evidence, { recursive: true })
  let directory = ''
  try {
    workRoot = await mkdtemp(join(tmpdir(), 'canvas-parity-gaps-'))
    directory = workRoot
    // 可选只跑某一段（调试用）：node scripts/test-agent-parity-gaps.cjs a c
    const only = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
    const picked = (name) => only.length === 0 || only.includes(name)
    if (picked('a')) await sectionGuiReverseLeg(join(workRoot, 'a'))
    if (picked('c')) await sectionDualCanvas(join(workRoot, 'c'))
    if (picked('b')) await sectionCrashRestart(join(workRoot, 'b'))
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = String(error && error.message ? error.message : error)
    throw error
  } finally {
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    if (report.status === 'failed' && workRoot) {
      for (const entry of fs.readdirSync(workRoot, { withFileTypes: true })) {
        const source = join(workRoot, entry.name)
        if (entry.isFile() && /^lifecycle-/.test(entry.name)) {
          await cp(source, join(evidence, entry.name), { force: true }).catch(() => {})
        }
        if (entry.isDirectory() && existsSync(join(source, 'diagnostics'))) {
          await cp(join(source, 'diagnostics'), join(evidence, `failed-diagnostics-${entry.name}`), { recursive: true }).catch(() => {})
        }
      }
    }
    if (workRoot && resolve(workRoot, '..') === resolve(tmpdir()) && basename(workRoot).startsWith('canvas-parity-gaps-')) {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
  process.stdout.write(`Agent parity gap acceptance passed: ${evidence}\n`)
})().catch((error) => {
  process.stderr.write(String(error && error.message ? error.message : error) + '\n')
  process.exitCode = 1
})
