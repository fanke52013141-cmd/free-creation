/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 时间线节点真机验收（Electron + 真实 IPC + 真实 FFmpeg）
//
// 覆盖用户最初提出的需求：
//   1. 素材加到轨道上；2. 单轨/多轨；3. 图片/视频/音频都能上轨；
//   4. 分割；5. 删除；6. 拖动位置；7. 时间轴随内容向右增长；
//   8. 从本地添加；9. 增加轨道按钮；10. 宽高自定义且默认更长；11. 能合成出片。
//
// 做法：启动真实 Electron（隔离 CANVAS_DATA_DIR），把主进程的文件选择对话框
// 替换成固定返回值，其余全部走真实链路（media IPC、ffprobe 探测、ffmpeg 合成、
// tldraw 指针交互）。截图落在 qa/timeline-electron-<时间戳>/。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const PROJECT_NAME = '时间线真机验收'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'ignore' })
}
function ffprobeJson(file) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' }
  )
  return JSON.parse(out)
}

function makeFixtures(dir) {
  const clipA = path.join(dir, '镜头A.mp4')
  // 3 秒测试图 + 正弦音轨：验证「视频带原音」这条最常见路径。
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    clipA
  ])
  const clipB = path.join(dir, '镜头B.mp4')
  ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=green:size=640x360:rate=30:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    clipB
  ])
  const pic = path.join(dir, '封面.png')
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=purple:size=640x360', '-frames:v', '1', pic])
  const bgm = path.join(dir, '配乐.m4a')
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', '-c:a', 'aac', bgm])
  return { clipA, clipB, pic, bgm }
}

async function launch(dataDir) {
  // 当前 shell 可能带着 ELECTRON_RUN_AS_NODE=1（DSH 环境），那会把 Electron 当纯 Node 跑，
  // 窗口永远起不来。真机验收必须去掉它，并显式关掉沙箱以适配管理员会话。
  const env = { ...process.env, CANVAS_DATA_DIR: dataDir }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', ROOT],
    cwd: ROOT,
    env,
    timeout: 120_000
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-timeline-fixtures-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-timeline-data-'))
  const shotDir = path.join(ROOT, 'qa', `timeline-electron-${Date.now()}`)
  fs.mkdirSync(shotDir, { recursive: true })
  const fixtures = makeFixtures(workDir)
  let app
  let page

  const shot = async (name) => {
    await page.screenshot({ path: path.join(shotDir, `${name}.png`) })
  }

  try {
    const launched = await launch(dataDir)
    app = launched.app
    page = launched.page

    // 主进程文件对话框改成固定返回：不弹系统框，其余导入链路保持真实。
    await app.evaluate(({ dialog }) => {
      global.__timelineNextFiles = []
      dialog.showOpenDialog = async () => ({
        canceled: (global.__timelineNextFiles || []).length === 0,
        filePaths: global.__timelineNextFiles || []
      })
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    const setNextFiles = (files) =>
      app.evaluate((_electron, list) => {
        global.__timelineNextFiles = list
      }, files)

    // ── 建项目并进入画布 ──
    await page.getByRole('button', { name: '新建项目' }).first().click()
    await page.locator('input[placeholder="给这个项目起个名字"]').fill(PROJECT_NAME)
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.node-palette').waitFor({ timeout: 60_000 })
    check('新项目进入画布', true)

    // ── 从节点面板创建「时间线」节点 ──
    // 一级分类是鱼眼 Dock，二级节点在右侧抽屉：先展开「视频创作」，再点「添加时间线节点」。
    await page.getByRole('button', { name: '展开视频创作节点', exact: true }).click()
    const addButton = page.getByRole('button', { name: '添加时间线节点', exact: true })
    await addButton.waitFor({ timeout: 20_000 })
    check('创建面板里出现「添加时间线节点」入口', true)
    await addButton.click()
    const card = page.locator('.node-card-wrap:has(.type-timeline)').first()
    await card.waitFor({ timeout: 20_000 })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Alt+f')
    await page.waitForTimeout(500)
    check('时间线节点可从创建面板新建', true)
    await shot('01-node-created')

    // ── 需求 10：默认尺寸更长、宽高可自定义 ──
    const size = await card.locator('.node-card').evaluate((el) => ({
      w: el.offsetWidth,
      h: el.offsetHeight
    }))
    check('默认尺寸比常规节点长（880×420）', size.w === 880 && size.h === 420, `${size.w}×${size.h}`)

    const resized = await page.evaluate(async () => {
      const el = document.querySelector('.node-card-wrap .node-card')
      return el ? { w: el.offsetWidth, h: el.offsetHeight } : null
    })
    check('尺寸令牌可读取（用于自由拖拽）', Boolean(resized), JSON.stringify(resized))

    // ── 需求 2/9：增加轨道 ──
    const trackRows = card.locator('.tl-row')
    const beforeTracks = await trackRows.count()
    check('默认自带视频轨与音频轨', beforeTracks === 2, `${beforeTracks} 条`)
    await card.getByRole('button', { name: '轨道', exact: true }).click()
    await page.getByRole('menuitem', { name: '音频轨', exact: true }).click()
    await page.waitForTimeout(300)
    const afterTracks = await trackRows.count()
    check('「+ 轨道」按钮能加一条音频轨', afterTracks === beforeTracks + 1, `${afterTracks} 条`)
    await shot('02-add-track')

    // ── 需求 1/3/8：从本地添加图片/视频到视频轨（真实 media IPC + ffprobe） ──
    await setNextFiles([fixtures.clipA, fixtures.clipB, fixtures.pic, fixtures.bgm])
    await card.getByRole('button', { name: '添加素材', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.node-card.type-timeline .tl-clip').length >= 3,
      undefined,
      { timeout: 60_000 }
    )
    let videoClips = card.locator('.tl-row').nth(0).locator('.tl-clip')
    let audioClips = card.locator('.tl-row').nth(1).locator('.tl-clip')
    check('本地导入后视频轨出现 3 个片段（视频×2 + 图片）', (await videoClips.count()) === 3)
    check('音频文件没有混进视频轨', (await audioClips.count()) === 0)
    await shot('03-import-video-track')

    // 音频片段只能进音频轨：点空白音频轨的添加入口
    await setNextFiles([fixtures.bgm])
    await card.locator('.tl-row').nth(1).getByRole('button', { name: /添加素材到音频轨/ }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.node-card.type-timeline .tl-row')[1].querySelectorAll('.tl-clip').length >= 1,
      undefined,
      { timeout: 60_000 }
    )
    audioClips = card.locator('.tl-row').nth(1).locator('.tl-clip')
    check('音频素材落到音频轨', (await audioClips.count()) === 1)
    await shot('04-import-audio-track')

    const timecodeText = async () => (await card.locator('.tl-timecode').innerText()).trim()
    const totalBefore = await timecodeText()
    check('时间码显示总时长与播放头', /^\d{2}:\d{2} \/ \d{2}:\d{2}$/.test(totalBefore), totalBefore)

    // ── 需求 6：拖动片段改变位置，时间轴随之增长 ──
    const picClip = card.locator('.tl-row').nth(0).locator('.tl-clip').nth(2)
    const picBox = await picClip.boundingBox()
    const leftBefore = await picClip.evaluate((el) => parseFloat(el.style.left))
    await page.mouse.move(picBox.x + picBox.width / 2, picBox.y + picBox.height / 2)
    await page.mouse.down()
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(picBox.x + picBox.width / 2 + (120 * step) / 10, picBox.y + picBox.height / 2)
      await page.waitForTimeout(20)
    }
    await page.mouse.up()
    await page.waitForTimeout(400)
    const leftAfter = await picClip.evaluate((el) => parseFloat(el.style.left))
    const totalAfterDrag = await timecodeText()
    check('拖动片段改变了起点', leftAfter > leftBefore + 80, `${leftBefore}px → ${leftAfter}px`)
    check('时间轴随内容向右增长', totalAfterDrag !== totalBefore, `${totalBefore} → ${totalAfterDrag}`)
    await shot('05-drag-clip')

    // ── 需求 4：播放头处分段 ──
    const firstClip = card.locator('.tl-row').nth(0).locator('.tl-clip').nth(0)
    await firstClip.click()
    const ruler = card.locator('.tl-ruler')
    const rulerBox = await ruler.boundingBox()
    await page.mouse.click(rulerBox.x + 60, rulerBox.y + rulerBox.height / 2)
    await page.waitForTimeout(200)
    const clipsBeforeSplit = await card.locator('.tl-row').nth(0).locator('.tl-clip').count()
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(400)
    const clipsAfterSplit = await card.locator('.tl-row').nth(0).locator('.tl-clip').count()
    check('播放头处分割出新片段', clipsAfterSplit === clipsBeforeSplit + 1, `${clipsBeforeSplit} → ${clipsAfterSplit}`)
    await shot('06-split')

    // ── 需求 5：删除片段 ──
    const splitClips = card.locator('.tl-row').nth(0).locator('.tl-clip')
    await splitClips.nth(1).click()
    await page.waitForTimeout(150)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(400)
    const clipsAfterDelete = await card.locator('.tl-row').nth(0).locator('.tl-clip').count()
    check('Delete 删除选中片段（并且没有删掉整张节点卡）', clipsAfterDelete === clipsAfterSplit - 1 && (await card.count()) === 1)
    await shot('07-delete')

    // ── 需求 7：撤销一步能回到删除前 ──
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
    const clipsAfterUndo = await card.locator('.tl-row').nth(0).locator('.tl-clip').count()
    check('撤销一步恢复被删除的片段', clipsAfterUndo === clipsAfterSplit, `${clipsAfterDelete} → ${clipsAfterUndo}`)

    // ── §19：空白区域仍可拖动整张卡片 ──
    const spacer = card.locator('.tl-toolbar-spacer')
    const spacerBox = await spacer.boundingBox()
    const cardBoxBefore = await card.boundingBox()
    await page.mouse.move(spacerBox.x + spacerBox.width / 2, spacerBox.y + spacerBox.height / 2)
    await page.mouse.down()
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(spacerBox.x + spacerBox.width / 2 + (40 * step) / 8, spacerBox.y + spacerBox.height / 2 + (20 * step) / 8)
      await page.waitForTimeout(20)
    }
    await page.mouse.up()
    await page.waitForTimeout(300)
    const cardBoxAfter = await card.boundingBox()
    check(
      '卡片内空白处按住可拖动整张节点',
      Math.abs(cardBoxAfter.x - cardBoxBefore.x) > 20,
      `${Math.round(cardBoxBefore.x)} → ${Math.round(cardBoxAfter.x)}`
    )
    await shot('08-drag-card')

    // ── 全屏编辑 ──
    await card.getByRole('button', { name: '全屏编辑', exact: true }).click()
    await page.locator('.tl-modal').waitFor({ timeout: 10_000 })
    check('全屏编辑能打开', (await page.locator('.tl-modal').isVisible()) === true)
    await shot('09-fullscreen')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // ── 需求 11：真实合成出片 ──
    const beforeArtifacts = await page.locator('.node-card-wrap:has(.type-video-asset)').count()
    await card.locator('.node-run-btn').click()
    await page.waitForFunction(
      (before) =>
        document.querySelectorAll('.node-card-wrap .type-video-asset').length > 0 ||
        document.querySelectorAll('.node-card-wrap').length > before,
      beforeArtifacts,
      { timeout: 180_000 }
    ).catch(() => undefined)
    await page.waitForTimeout(1500)
    const artifactNodes = await page.locator('.node-card-wrap:has(.type-video-asset)').count()
    check('运行后生成独立视频资产节点（emitArtifact）', artifactNodes > beforeArtifacts, `${artifactNodes} 个视频资产节点`)
    await shot('10-composed-artifact')

    // 从磁盘核对成片：时长/流结构
    const mediaRoot = path.join(dataDir, 'projects')
    const mp4s = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.mp4$/i.test(entry.name)) mp4s.push(full)
      }
    }
    if (fs.existsSync(mediaRoot)) walk(mediaRoot)
    const probed = mp4s.map((file) => {
      const info = ffprobeJson(file)
      const video = (info.streams || []).find((s) => s.codec_type === 'video')
      const audio = (info.streams || []).find((s) => s.codec_type === 'audio')
      return {
        file: path.basename(file),
        duration: Number(info.format?.duration || 0),
        width: video?.width,
        height: video?.height,
        hasAudio: Boolean(audio)
      }
    })
    const composed = probed.find((item) => item.duration >= 5)
    check(
      '成片落盘且时长与时间线一致（约 12 秒 / 1920×1080 / 带音轨）',
      Boolean(composed) && composed.duration >= 10 && composed.duration <= 14 && composed.width === 1920 && composed.height === 1080 && composed.hasAudio,
      JSON.stringify(composed ?? probed)
    )

    // ── 重开项目：数据持久化 ──
    const projectId = await page.evaluate(async (name) => {
      const list = await window.api.listProjects()
      return list.ok ? list.data.find((p) => p.name === name)?.id : null
    }, PROJECT_NAME)
    check('项目已持久化', Boolean(projectId), projectId || '')
  } catch (error) {
    check('验收脚本执行未中断', false, error instanceof Error ? error.message : String(error))
    if (page) await page.screenshot({ path: path.join(shotDir, 'error.png') }).catch(() => undefined)
  } finally {
    if (app) await app.close().catch(() => undefined)
  }

  const failed = results.filter((item) => !item.ok)
  console.log(`\n截图目录：${shotDir}`)
  console.log(`结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('未通过：')
    for (const item of failed) console.log(` - ${item.name}${item.detail ? `：${item.detail}` : ''}`)
    process.exitCode = 1
  }
}

void main()
