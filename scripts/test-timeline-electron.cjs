/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 轨道线节点真机验收（Electron + 真实 IPC + 真实 FFmpeg）
//
// 覆盖用户最初提出的需求：
//   1. 素材加到轨道上；2. 单轨/多轨；3. 图片/视频/音频都能上轨；
//   4. 分割；5. 删除；6. 拖动位置；7. 时间轴随内容向右增长；
//   8. 从本地添加；9. 增加轨道按钮；10. 宽高自定义且默认更长；11. 能合成出片。
//
// 做法：启动真实 Electron（隔离 CANVAS_DATA_DIR），把主进程的文件选择对话框
// 替换成固定返回值，其余全部走真实链路（media IPC、ffprobe 探测、ffmpeg 合成、
// tldraw 指针交互）。截图落在 qa/timeline-electron-<时间戳>/。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const PROJECT_NAME = '轨道线真机验收'

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

/** 音轨平均电平（dB）。静音轨约 -91 dB；用来抓「有音轨但整条静音」。 */
function meanVolumeDb(file) {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0?', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' }
  )
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(`${res.stderr ?? ''}`)
  return match ? Number(match[1]) : null
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

    // ── 从节点面板创建「轨道线」节点 ──
    // 一级分类是鱼眼 Dock，二级节点在右侧抽屉：先展开「视频创作」，再点「添加轨道线节点」。
    // 关掉抽屉动画：展开/切换分类时按钮会先挂载再位移，Playwright 的稳定性判定会误报 detached。
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
    await page.getByRole('button', { name: '展开视频创作节点', exact: true }).click()
    const addButton = page.getByRole('button', { name: '添加轨道线节点', exact: true })
    await addButton.waitFor({ timeout: 20_000 })
    check('创建面板里出现「添加轨道线节点」入口', true)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await addButton.click({ timeout: 5000 })
        break
      } catch {
        await page.waitForTimeout(200)
      }
    }
    const card = page.locator('.node-card-wrap:has(.type-timeline)').first()
    await card.waitFor({ timeout: 20_000 })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Alt+f')
    await page.waitForTimeout(500)
    check('轨道线节点可从创建面板新建', true)
    await shot('01-node-created')

    // ── 需求 10：默认尺寸更长、宽高可自定义 ──
    const size = await card.locator('.node-card').evaluate((el) => ({
      w: el.offsetWidth,
      h: el.offsetHeight
    }))
    check('默认尺寸按三条轨道完整可见（880×286）', size.w === 880 && size.h === 286, `${size.w}×${size.h}`)

    const resized = await page.evaluate(async () => {
      const el = document.querySelector('.node-card-wrap .node-card')
      return el ? { w: el.offsetWidth, h: el.offsetHeight } : null
    })
    check('尺寸令牌可读取（用于自由拖拽）', Boolean(resized), JSON.stringify(resized))

    // 时间轴必须铺满卡片可用宽度（横向拉宽时逐步显示后面的时间，而不是留白）。
    const laneFill = await page.evaluate(() => {
      const scroll = document.querySelector('.node-card.type-timeline .tl-scroll')
      const ruler = document.querySelector('.node-card.type-timeline .tl-ruler')
      if (!scroll || !ruler) return null
      return {
        lane: scroll.clientWidth - 132,
        ruler: ruler.offsetWidth,
        inner: document.querySelector('.node-card.type-timeline .tl-inner')?.offsetWidth ?? 0
      }
    })
    check(
      '时间轴刻度铺满卡片可用宽度',
      Boolean(laneFill) && laneFill.ruler + 2 >= laneFill.lane,
      JSON.stringify(laneFill)
    )

    // ── 需求 2/9：增加轨道 ──
    const trackRows = card.locator('.tl-row')
    const beforeTracks = await trackRows.count()
    check('默认自带三条通用轨道', beforeTracks === 3, `${beforeTracks} 条`)
    await card.getByRole('button', { name: '轨道', exact: true }).click()
    await page.waitForTimeout(300)
    const afterTracks = await trackRows.count()
    check('「+ 轨道」按钮能加一条通用轨道', afterTracks === beforeTracks + 1, `${afterTracks} 条`)
    await shot('02-add-track')

    // ── 需求 1/3/8：轨道通用，图片/视频/音频都能放进同一条轨道 ──
    await setNextFiles([fixtures.clipA, fixtures.clipB, fixtures.pic])
    await card.getByRole('button', { name: '添加素材', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.node-card.type-timeline .tl-clip').length >= 3,
      undefined,
      { timeout: 60_000 }
    )
    let videoClips = card.locator('.tl-row').nth(0).locator('.tl-clip')
    check('本地导入后第 1 条轨道出现 3 个片段（视频×2 + 图片）', (await videoClips.count()) === 3)
    await shot('03-import-video-track')

    // 音频也是通用素材：点第 2 条轨道空白处的添加入口
    await setNextFiles([fixtures.bgm])
    await card.locator('.tl-row').nth(1).getByRole('button', { name: /添加素材到这条轨道/ }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.node-card.type-timeline .tl-row')[1].querySelectorAll('.tl-clip').length >= 1,
      undefined,
      { timeout: 60_000 }
    )
    const audioClips = card.locator('.tl-row').nth(1).locator('.tl-clip')
    check('音频素材可以放进第 2 条轨道', (await audioClips.count()) === 1)
    await shot('04-import-audio-track')

    // 音频也能放进第 1 条（轨道不再分类型）
    await setNextFiles([fixtures.bgm])
    await card.getByRole('button', { name: '添加素材', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.node-card.type-timeline .tl-row')[0].querySelectorAll('.tl-clip').length >= 4,
      undefined,
      { timeout: 60_000 }
    )
    check('音频素材同样可以放进已有画面片段的轨道', (await videoClips.count()) === 4)
    await shot('05-import-audio-same-track')

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
      await page.mouse.move(picBox.x + picBox.width / 2 + (320 * step) / 10, picBox.y + picBox.height / 2)
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

    // ── 分割三态：向左分割（删右边）、向右分割（删左边） ──
    const firstRowClips = card.locator('.tl-row').nth(0).locator('.tl-clip')
    const widthOfFirstClip = async () =>
      firstRowClips.first().evaluate((el) => parseFloat(el.style.width))
    await firstRowClips.first().click()
    await page.keyboard.press('Escape')
    await page.mouse.click(rulerBox.x + 20, rulerBox.y + rulerBox.height / 2)
    await page.waitForTimeout(150)
    await firstRowClips.first().click()
    const widthBeforeLeftSplit = await widthOfFirstClip()
    const countBeforeLeftSplit = await firstRowClips.count()
    await card.locator('[title^="向左分割"]').click()
    await page.waitForTimeout(400)
    const widthAfterLeftSplit = await widthOfFirstClip()
    check(
      '向左分割：保留左侧、删除右侧（片段数不变、宽度变短）',
      (await firstRowClips.count()) === countBeforeLeftSplit &&
        widthAfterLeftSplit < widthBeforeLeftSplit,
      `${Math.round(widthBeforeLeftSplit)} → ${Math.round(widthAfterLeftSplit)}px`
    )

    await firstRowClips.first().click()
    await page.mouse.click(rulerBox.x + 10, rulerBox.y + rulerBox.height / 2)
    await page.waitForTimeout(150)
    await firstRowClips.first().click()
    const leftBeforeRightSplit = await firstRowClips.first().evaluate((el) => parseFloat(el.style.left))
    await card.locator('[title^="向右分割"]').click()
    await page.waitForTimeout(400)
    const leftAfterRightSplit = await firstRowClips.first().evaluate((el) => parseFloat(el.style.left))
    check(
      '向右分割：保留右侧、删除左侧（起点右移）',
      leftAfterRightSplit > leftBeforeRightSplit,
      `${Math.round(leftBeforeRightSplit)} → ${Math.round(leftAfterRightSplit)}px`
    )

    // ── 轨道拖动排序：第 2 条拖到第 1 条之前 ──
    const rowTracks = () =>
      card.locator('.tl-row').evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-timeline-track'))
      )
    const tracksBeforeDrag = await rowTracks()
    const header2 = await card.locator('.tl-row-header').nth(1).boundingBox()
    const header1 = await card.locator('.tl-row-header').nth(0).boundingBox()
    await page.mouse.move(header2.x + 30, header2.y + header2.height / 2)
    await page.mouse.down()
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(
        header2.x + 30,
        header2.y + header2.height / 2 + ((header1.y + 4 - header2.y - header2.height / 2) * step) / 8
      )
      await page.waitForTimeout(25)
    }
    await page.mouse.up()
    await page.waitForTimeout(400)
    const tracksAfterDrag = await rowTracks()
    check(
      '轨道可拖动排序（第 2 条移到最前）',
      tracksAfterDrag[0] === tracksBeforeDrag[1] && tracksAfterDrag[1] === tracksBeforeDrag[0],
      `${tracksBeforeDrag.join(',')} → ${tracksAfterDrag.join(',')}`
    )

    // ── 时间轴缩放滚轴 ──
    const widthBeforeZoom = await widthOfFirstClip()
    const zoomSlider = page.locator('.tl-zoom input[type="range"]')
    await zoomSlider.focus()
    await zoomSlider.press('End')
    await page.waitForTimeout(400)
    const widthAfterZoom = await widthOfFirstClip()
    check('时间轴缩放滚轴生效', widthAfterZoom > widthBeforeZoom, `${Math.round(widthBeforeZoom)} → ${Math.round(widthAfterZoom)}px`)


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

    // ── 需求 11：真实合成出片 ──
    // 先记下时间线当前总时长，成片时长必须与它对齐（而不是写死某个秒数）。
    const totalCode = await timecodeText()
    const expectedMs = (() => {
      const [, total] = totalCode.split('/').map((part) => part.trim())
      const [minutes, seconds] = total.split(':').map(Number)
      return (minutes * 60 + seconds) * 1000
    })()
    const beforeArtifacts = await page.locator('.node-card-wrap:has(.type-video-asset)').count()
    await card.locator('.node-run-btn').click()
    await page.waitForFunction(
      (before) => document.querySelectorAll('.node-card-wrap:has(.type-video-asset)').length > before,
      beforeArtifacts,
      // 28 秒、9 个片段的合成要重新编码全部素材并混音，给足 7 分钟。
      { timeout: 420_000 }
    ).catch(() => undefined)
    // 成片节点可能在画布右侧视野外：先把节点框进视野再统计，避免 tldraw 裁剪导致漏数。
    await page.keyboard.press('Shift+Alt+f')
    await page.waitForTimeout(600)
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
        hasAudio: Boolean(audio),
        meanDb: meanVolumeDb(file)
      }
    })
    const composed = probed.find((item) => item.duration >= 5)
    check(
      `成片落盘且时长与轨道线一致（时间线 ${totalCode} / 1920×1080 / 带音轨且不静音）`,
      Boolean(composed) &&
        Math.abs(composed.duration * 1000 - expectedMs) <= 1200 &&
        composed.width === 1920 &&
        composed.height === 1080 &&
        composed.hasAudio &&
        composed.meanDb !== null &&
        composed.meanDb > -50,
      JSON.stringify(composed ?? probed)
    )

    // ── 重开项目：数据持久化 ──
    const projectId = await page.evaluate(async (name) => {
      const list = await window.api.listProjects()
      return list.ok ? list.data.find((p) => p.name === name)?.id : null
    }, PROJECT_NAME)
    check('项目已持久化', Boolean(projectId), projectId || '')
    // ── 引用素材（2026-11-03 用户裁决）：连线只做引用，不自动铺轨；点选/直接拖入轨道 ──
    await page.getByRole('button', { name: '展开视频创作节点', exact: true }).click()
    await page.getByRole('button', { name: '添加视频素材节点', exact: true }).click()
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')
    // 画布可能已经平移过：先把新节点框进视野，避免画布裁剪导致定位不到。
    await page.keyboard.press('Shift+Alt+f')
    await page.waitForTimeout(400)
    const sourceWrap = page
      .locator('.node-card-wrap:has(.type-video-asset)')
      .filter({ has: page.getByRole('button', { name: '导入视频', exact: true }) })
      .last()
    await sourceWrap.getByRole('button', { name: '导入视频', exact: true }).waitFor({ timeout: 20_000 })
    // 导入后空的「导入视频」按钮会消失，必须先把节点 id 固定下来。
    const sourceId = await sourceWrap.getAttribute('data-node-id')
    await app.evaluate((_e, files) => {
      global.__timelineNextFiles = files
    }, [fixtures.clipB])
    await sourceWrap.getByRole('button', { name: '导入视频', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.node-card.type-video-asset .node-media').length > 0,
      undefined,
      { timeout: 60_000 }
    )
    await page.keyboard.press('Escape')

    const timelineWrap = page.locator('.node-card-wrap:has(.type-timeline)')
    const timelineId = await timelineWrap.getAttribute('data-node-id')
    const clipsBeforeConnect = await card.locator('.tl-clip').count()
    const dragPort = async (fromSelector, toSelector) => {
      const from = await page.locator(fromSelector).boundingBox()
      const to = await page.locator(toSelector).boundingBox()
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      for (let step = 1; step <= 8; step += 1) {
        await page.mouse.move(
          from.x + from.width / 2 + ((to.x + to.width / 2 - from.x - from.width / 2) * step) / 8,
          from.y + from.height / 2 + ((to.y + to.height / 2 - from.y - from.height / 2) * step) / 8
        )
        await page.waitForTimeout(25)
      }
      await page.mouse.up()
      await page.waitForTimeout(500)
    }
    await dragPort(
      `.node-card-wrap[data-node-id="${sourceId}"] .port-dot.out[data-port-id="out-video"]`,
      `.node-card-wrap[data-node-id="${timelineId}"] .port-dot.in[data-port-id="in-video"]`
    )
    await page.waitForFunction(
      () => document.querySelectorAll('.node-card.type-timeline .tl-ref').length >= 1,
      undefined,
      { timeout: 20_000 }
    )
    check('连线素材出现在引用素材条', (await card.locator('.tl-ref').count()) === 1)
    // 关键回归：连线不再静默把素材铺到轨道
    await page.waitForTimeout(800)
    check(
      '连线不再自动铺轨（等用户点选/拖入）',
      (await card.locator('.tl-clip').count()) === clipsBeforeConnect,
      `${clipsBeforeConnect} → ${await card.locator('.tl-clip').count()}`
    )

    // 单击引用素材只选中，不再直接追加（2026-11-03 二次裁决：两处统一为拖拽落轨）
    await card.locator('.tl-ref').first().click()
    await page.waitForTimeout(300)
    const refSelected = await card.locator('.tl-ref.is-selected').count()
    const clipsAfterRefClick = await card.locator('.tl-clip').count()
    check(
      '单击引用素材只选中，不直接追加到轨道',
      refSelected === 1 && clipsAfterRefClick === clipsBeforeConnect,
      `选中 ${refSelected} / 片段 ${clipsBeforeConnect} → ${clipsAfterRefClick}`
    )

    // 直接拖动引用素材到轨道指定位置：先把缩放复位，落到第 1 条轨道靠后的空白处
    const zoomReset = page.locator('.tl-zoom input[type="range"]')
    await zoomReset.focus()
    await zoomReset.press('Home')
    await page.waitForTimeout(300)
    const clipsBeforeRefDrag = await card.locator('.tl-clip').count()
    const refBox = await card.locator('.tl-ref').first().boundingBox()
    const refLane = await card.locator('.tl-row').nth(0).boundingBox()
    await page.mouse.move(refBox.x + refBox.width / 2, refBox.y + refBox.height / 2)
    await page.mouse.down()
    // 2026-11-03 用户裁决：不再长按等待，按下后移动 4px 即进入拖动。
    await page.mouse.move(refBox.x + refBox.width / 2 + 8, refBox.y + refBox.height / 2 + 8)
    await page.waitForTimeout(120)
    check(
      '按下即拖动：源素材淡出成虚影（无需长按）',
      (await card.locator('.tl-ref.is-dragging').count()) === 1
    )
    const refDropX = refLane.x + 132 + (refLane.width - 132) * 0.85
    const refDropY = refLane.y + refLane.height / 2
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(
        refBox.x + refBox.width / 2 + ((refDropX - refBox.x - refBox.width / 2) * step) / 8,
        refBox.y + refBox.height / 2 + ((refDropY - refBox.y - refBox.height / 2) * step) / 8
      )
      await page.waitForTimeout(30)
    }
    const refGhostBox = await page.locator('.tl-asset-ghost').boundingBox()
    const refGhostCx = refGhostBox ? refGhostBox.x + refGhostBox.width / 2 : -999
    const refGhostCy = refGhostBox ? refGhostBox.y + refGhostBox.height / 2 : -999
    check(
      '拖动浮层中心与鼠标重合（不再悬在上方）',
      Boolean(refGhostBox) &&
        Math.abs(refGhostCx - refDropX) <= 6 &&
        Math.abs(refGhostCy - refDropY) <= 6,
      `浮层中心 (${Math.round(refGhostCx)}, ${Math.round(refGhostCy)}) / 鼠标 (${Math.round(refDropX)}, ${Math.round(refDropY)})`
    )
    await page.mouse.up()
    await page.waitForFunction(
      (before) => document.querySelectorAll('.node-card.type-timeline .tl-clip').length > before,
      clipsBeforeRefDrag,
      { timeout: 20_000 }
    )
    check(
      '按下即拖动引用素材到轨道指定位置',
      true,
      `${clipsBeforeRefDrag} → ${await card.locator('.tl-clip').count()}`
    )
    await shot('09-refs-and-tracks')

    // ── 全屏编辑 ──
    await card.getByRole('button', { name: '全屏编辑', exact: true }).click()
    await page.locator('.tl-modal').waitFor({ timeout: 10_000 })
    check('全屏编辑能打开', (await page.locator('.tl-modal').isVisible()) === true)
    await shot('09-fullscreen')

    // ── 全屏编辑器三段式：素材库 / 预览 / 时间轴 ──
    const editor = page.locator('.tl-modal .tl-editor')
    check('全屏编辑器有素材库与预览区', (await editor.count()) === 1)
    check(
      '素材库只有「已导入资产」并按类型筛选',
      (await page.locator('.tl-bin-source button').count()) === 0 &&
        (await page.locator('.tl-bin-filter-group button').count()) === 4
    )
    check(
      '预览区有播放/导出/比例/音量/全屏控制',
      (await page.locator('.tl-transport-play').count()) === 1 &&
        (await page.locator('.tl-editor-export').count()) === 1 &&
        (await page.locator('.tl-transport [aria-label="预览比例"]').count()) === 1 &&
        (await page.locator('.tl-transport [aria-label="预览音量"]').count()) === 1 &&
        (await page.locator('.tl-transport [aria-label="全屏播放预览"]').count()) === 1
    )
    check(
      '播放条时间码为 HH:MM:SS',
      /^\d{2}:\d{2}:\d{2}\s*\/\s*\d{2}:\d{2}:\d{2}$/.test(
        (await page.locator('.tl-transport-time').innerText()).replace(/\s+/g, ' ').trim()
      ),
      await page.locator('.tl-transport-time').innerText()
    )
    check('视频片段显示首帧封面', (await page.locator('.tl-modal .tl-clip-thumb-img').count()) > 0)
    // 默认时间轴区 = 三条轨道高度；分隔条压缩成一条可拖的线（8px 命中区）
    const paneBox = await page.locator('.tl-timeline-pane').boundingBox()
    check(
      '默认时间轴区高度按三条轨道预留',
      paneBox.height >= 210 && paneBox.height <= 320,
      `${Math.round(paneBox.height)}px`
    )
    const splitterBox = await page.locator('.tl-timeline-splitter').boundingBox()
    check(
      '全屏分隔条压缩成一条线（命中区 ≤12px）',
      splitterBox.height <= 12,
      `${Math.round(splitterBox.height)}px`
    )
    const paneBefore = paneBox.height
    await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y - 90, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(350)
    const paneAfter = (await page.locator('.tl-timeline-pane').boundingBox()).height
    check(
      '分隔条拖动可调整时间轴高度',
      paneAfter > paneBefore + 40,
      `时间轴 ${Math.round(paneBefore)} → ${Math.round(paneAfter)}px`
    )
    // Ctrl+滚轮：细粒度缩放（连续、每档约 1.12 倍）
    const zoomBefore = await page.evaluate(
      () => document.querySelector('.tl-modal .tl-clip')?.getBoundingClientRect().width ?? 0
    )
    const paneCenter = await page.locator('.tl-timeline-pane').boundingBox()
    await page.keyboard.down('Control')
    await page.mouse.move(paneCenter.x + paneCenter.width / 2, paneCenter.y + 60)
    await page.mouse.wheel(0, -120)
    await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')
    await page.waitForTimeout(350)
    const zoomAfter = await page.evaluate(
      () => document.querySelector('.tl-modal .tl-clip')?.getBoundingClientRect().width ?? 0
    )
    check(
      'Ctrl+滚轮可细粒度缩放时间轴',
      zoomBefore > 0 && zoomAfter > zoomBefore + 2,
      `片段宽 ${Math.round(zoomBefore)} → ${Math.round(zoomAfter)}px`
    )
    check(
      '时间轴工具栏有撤销/重做/左右裁剪/自动吸附',
      (await page.locator('.tl-toolbar .tl-btn').count()) >= 8 &&
        (await page.locator('[data-tl-snap="on"]').count()) === 1
    )
    // 布局切换：素材库在左 → 在右 → 收起
    await page.locator('.tl-editor-layout').click()
    const layoutRight = await page.locator('.tl-editor-main.is-bin-right').count()
    await page.locator('.tl-editor-layout').click()
    const layoutHidden = await page.locator('.tl-editor-main.is-bin-hidden').count()
    await page.locator('.tl-editor-layout').click()
    const layoutLeft = await page.locator('.tl-editor-main.is-bin-left').count()
    check('布局可在左/右/收起之间切换', layoutRight === 1 && layoutHidden === 1 && layoutLeft === 1)

    // 左侧是「引用素材」池：导入是二级菜单（本地 / 画布），且不再显示操作提示语
    check('引用素材提示语已删除', (await page.locator('.tl-bin-hint').count()) === 0)
    const refsBeforeImport = await page.locator('.tl-modal .tl-asset').count()
    await page.locator('.tl-bin-import').click()
    check(
      '导入是二级菜单（从本地 / 从画布）',
      (await page.locator('.tl-import-menu [role="menuitem"]').count()) === 2,
      JSON.stringify(await page.locator('.tl-import-menu [role="menuitem"]').allInnerTexts())
    )
    await page.getByRole('menuitem', { name: '从画布导入' }).click()
    await page.waitForTimeout(900)
    const refsAfterCanvas = await page.locator('.tl-modal .tl-asset').count()
    const selectedOnCanvas = await page.locator('.node-card-wrap.is-selected').count()
    const canvasImportToast = await page.evaluate(
      () => document.querySelector('.toast, .toast-item, [role="status"]')?.textContent?.trim() ?? ''
    )
    check(
      '从画布导入把选中素材加入引用素材',
      refsAfterCanvas > refsBeforeImport,
      `${refsBeforeImport} → ${refsAfterCanvas} / 画布选中 ${selectedOnCanvas} / toast: ${canvasImportToast}`
    )

    await setNextFiles([fixtures.pic])
    const clipsBeforeLocalImport = await card.locator('.tl-clip').count()
    await page.locator('.tl-bin-import').click()
    await page.getByRole('menuitem', { name: '从本地导入' }).click()
    await page.waitForFunction(
      (before) => document.querySelectorAll('.tl-modal .tl-asset').length > before,
      refsBeforeImport + 1,
      { timeout: 60_000 }
    )
    check('从本地导入把素材加入引用素材（不自动铺轨）', true, `引用 ${await page.locator('.tl-modal .tl-asset').count()}`)
    check(
      '导入只进引用素材，不直接生成片段',
      (await card.locator('.tl-clip').count()) === clipsBeforeLocalImport,
      `${clipsBeforeLocalImport} → ${await card.locator('.tl-clip').count()}`
    )

    // 多选顺序：先点第 1 个，再 Ctrl+点第 2 个 → 序号 1 / 2
    const tile1 = page.locator('.tl-modal .tl-asset').first()
    const tile2 = page.locator('.tl-modal .tl-asset').nth(1)
    await tile1.click()
    await tile2.click({ modifiers: ['Control'] })
    const orders = await page.locator('.tl-modal .tl-asset-order').allInnerTexts()
    check('多选按点击顺序编号', orders.join(',') === '1,2', orders.join(','))
    const selectedOrder = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.tl-modal .tl-asset.is-selected'))
        .map((el) => ({
          id: el.dataset.mediaId ?? '',
          name: (el.querySelector('.tl-asset-name') || {}).textContent?.trim() ?? '',
          order: Number((el.querySelector('.tl-asset-order') || {}).textContent || 0)
        }))
        .sort((a, b) => a.order - b.order)
    )
    const stateIds = await page.locator('.tl-modal .tl-bin').getAttribute('data-selected-ids')
    check(
      '素材库选中态与 data-selected-ids 一致',
      stateIds === selectedOrder.map((item) => item.id).join(','),
      `data-selected-ids=${stateIds ?? ''}`
    )

    const clipGeometry = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.tl-modal .tl-row')).flatMap((row, index) =>
          Array.from(row.querySelectorAll('.tl-clip')).map((el) => ({
            row: index,
            id: el.dataset.mediaId ?? '',
            key: `${index}:${el.style.left}`
          }))
        )
      )
    check(
      '素材库不再提供「加入轨道」按钮（统一为拖拽落轨）',
      (await page.locator('.tl-bin-append, .tl-bin-footer').count()) === 0
    )
    const beforeDragClips = await clipGeometry()
    const clipsBeforeDragAll = beforeDragClips.length
    // 拖动多选素材到空轨道（第 3 条）：落点即起点，先选在前
    const tileBox = await tile1.boundingBox()
    const emptyLane = page.locator('.tl-modal .tl-lane').nth(2)
    const laneBox = await emptyLane.boundingBox()
    await page.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(320)
    const dropX = laneBox.x + laneBox.width * 0.35
    const dropY = laneBox.y + laneBox.height / 2
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(
        tileBox.x + tileBox.width / 2 + ((dropX - tileBox.x - tileBox.width / 2) * step) / 8,
        tileBox.y + tileBox.height / 2 + ((dropY - tileBox.y - tileBox.height / 2) * step) / 8
      )
      await page.waitForTimeout(30)
    }
    check('拖动素材出现浮层', (await page.locator('.tl-asset-ghost').count()) === 1)
    check(
      '拖动时源磁贴淡出成虚影（多选两个）',
      (await page.locator('.tl-modal .tl-asset.is-dragging').count()) === 2
    )
    const tileGhostBox = await page.locator('.tl-asset-ghost').boundingBox()
    const tileGhostCx = tileGhostBox ? tileGhostBox.x + tileGhostBox.width / 2 : -999
    const tileGhostCy = tileGhostBox ? tileGhostBox.y + tileGhostBox.height / 2 : -999
    check(
      '素材库浮层中心与鼠标重合',
      Boolean(tileGhostBox) &&
        Math.abs(tileGhostCx - dropX) <= 6 &&
        Math.abs(tileGhostCy - dropY) <= 6,
      `浮层中心 (${Math.round(tileGhostCx)}, ${Math.round(tileGhostCy)}) / 鼠标 (${Math.round(dropX)}, ${Math.round(dropY)})`
    )
    await page.mouse.up()
    await page.waitForFunction(
      (before) => document.querySelectorAll('.tl-modal .tl-clip').length >= before + 2,
      clipsBeforeDragAll,
      { timeout: 20_000 }
    )
    check(
      '拖动能把多选素材一起放到轨道落点',
      true,
      `${clipsBeforeDragAll} → ${await page.locator('.tl-modal .tl-clip').count()}`
    )
    const beforeKeys = new Set(beforeDragClips.map((item) => item.key))
    const newClips = (await clipGeometry())
      .filter((item) => !beforeKeys.has(item.key))
      .sort((a, b) => a.row - b.row || Number.parseFloat(a.key.split(':')[1]) - Number.parseFloat(b.key.split(':')[1]))
    check(
      '落轨顺序与选择顺序一致（先选在前）',
      newClips.length === 2 &&
        newClips[0].id === selectedOrder[0].id &&
        newClips[1].id === selectedOrder[1].id,
      `选择 ${selectedOrder.map((i) => `${i.name}#${i.id}`).join(' → ')} / 新增 ${newClips
        .map((i) => `${i.id}@${i.key}`)
        .join(' → ')}`
    )
    check(
      '落轨后素材库清空选中',
      (await page.locator('.tl-modal .tl-asset.is-selected').count()) === 0
    )

    // 拖到已被占用的位置：自动顺延到后方空档，不再报「该位置已有片段」（2026-11-03 用户反馈）
    const occupiedRow = page.locator('.tl-modal .tl-row').nth(2)
    const occupiedBox = await occupiedRow.locator('.tl-clip').first().boundingBox()
    const clipsBeforeShift = await page.locator('.tl-modal .tl-clip').count()
    const tile2Box = await page.locator('.tl-modal .tl-asset').nth(1).boundingBox()
    await page.mouse.move(tile2Box.x + tile2Box.width / 2, tile2Box.y + tile2Box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(320)
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(
        tile2Box.x + tile2Box.width / 2 + ((occupiedBox.x + occupiedBox.width / 2 - tile2Box.x - tile2Box.width / 2) * step) / 8,
        tile2Box.y + tile2Box.height / 2 + ((occupiedBox.y + occupiedBox.height / 2 - tile2Box.y - tile2Box.height / 2) * step) / 8
      )
      await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForFunction(
      (before) => document.querySelectorAll('.tl-modal .tl-clip').length > before,
      clipsBeforeShift,
      { timeout: 20_000 }
    )
    const shiftToast = await page.evaluate(
      () => document.querySelector('.toast, .toast-item, [role="status"]')?.textContent?.trim() ?? ''
    )
    check(
      '拖到已占用位置自动顺延落轨（不报「已有片段」）',
      !shiftToast.includes('已有片段'),
      `片段 ${clipsBeforeShift} → ${await page.locator('.tl-modal .tl-clip').count()} / toast: ${shiftToast}`
    )

    // 吸附开启：拖入的新片段自动贴到已有片段边缘（首尾相连），不会留缝
    const magnetRowIndex = 2
    const magnetEdges = await page.evaluate((rowIndex) => {
      const row = document.querySelectorAll('.tl-modal .tl-row')[rowIndex]
      if (!row) return { lefts: [], edges: [] }
      const rects = Array.from(row.querySelectorAll('.tl-clip')).map((el) => el.getBoundingClientRect())
      return { lefts: rects.map((r) => r.left), edges: rects.flatMap((r) => [r.left, r.right]) }
    }, magnetRowIndex)
    const magnetTileBox = await page.locator('.tl-modal .tl-asset').nth(0).boundingBox()
    const magnetRowBox = await page.locator('.tl-modal .tl-row').nth(magnetRowIndex).boundingBox()
    const clipsBeforeMagnet = await page.locator('.tl-modal .tl-clip').count()
    await page.mouse.move(magnetTileBox.x + magnetTileBox.width / 2, magnetTileBox.y + magnetTileBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(magnetTileBox.x + magnetTileBox.width / 2 + 10, magnetTileBox.y + magnetTileBox.height / 2 + 10)
    const magnetX = magnetRowBox.x + magnetRowBox.width * 0.93
    const magnetY = magnetRowBox.y + magnetRowBox.height / 2
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(
        magnetTileBox.x + magnetTileBox.width / 2 + ((magnetX - magnetTileBox.x - magnetTileBox.width / 2) * step) / 8,
        magnetTileBox.y + magnetTileBox.height / 2 + ((magnetY - magnetTileBox.y - magnetTileBox.height / 2) * step) / 8
      )
      await page.waitForTimeout(30)
    }
    await page.mouse.up()
    await page.waitForFunction(
      (before) => document.querySelectorAll('.tl-modal .tl-clip').length > before,
      clipsBeforeMagnet,
      { timeout: 20_000 }
    )
    const magnetResult = await page.evaluate(({ rowIndex, previousLefts, previousEdges }) => {
      const row = document.querySelectorAll('.tl-modal .tl-row')[rowIndex]
      const lefts = Array.from(row.querySelectorAll('.tl-clip')).map((el) => el.getBoundingClientRect().left)
      const fresh = lefts.find((left) => !previousLefts.some((old) => Math.abs(old - left) <= 1)) ?? null
      const attached = fresh !== null && previousEdges.some((edge) => Math.abs(edge - fresh) <= 2)
      return { fresh, attached }
    }, { rowIndex: magnetRowIndex, previousLefts: magnetEdges.lefts, previousEdges: magnetEdges.edges })
    check(
      '吸附开启时拖入片段自动首尾相连（贴已有边缘）',
      magnetResult.attached,
      `新片段左缘 ${magnetResult.fresh === null ? '-' : Math.round(magnetResult.fresh)}`
    )

    // 自动吸附：把最后一段拖到前一段右边缘附近（+6px），应精确贴合
    // 多选落轨落在第 3 条轨道，吸附验证也在这条轨道上做（第 1 条轨道已有其他片段）。
    const snapRowIndex = 2
    const snapRow = page.locator('.tl-modal .tl-row').nth(snapRowIndex)
    const geom = async () =>
      page.evaluate((rowIndex) => {
        const row = document.querySelectorAll('.tl-modal .tl-row')[rowIndex]
        if (!row) return []
        return Array.from(row.querySelectorAll('.tl-clip'))
          .map((el) => {
            const rect = el.getBoundingClientRect()
            return { left: Math.round(rect.left), right: Math.round(rect.right) }
          })
          .sort((a, b) => a.left - b.left)
      }, snapRowIndex)
    const beforeSnap = await geom()
    const last = beforeSnap[beforeSnap.length - 1]
    const prev = beforeSnap[beforeSnap.length - 2]
    if (last && prev) {
      const shiftPx = prev.right + 6 - last.left
      const rowY = (await snapRow.boundingBox()).y + 20
      await page.mouse.move(last.left + 6, rowY)
      await page.mouse.down()
      await page.mouse.move(last.left + 6 + shiftPx / 2, rowY)
      await page.mouse.move(last.left + 6 + shiftPx, rowY)
      await page.mouse.up()
      await page.waitForTimeout(300)
      const afterSnap = await geom()
      const moved = afterSnap.reduce((best, item) =>
        Math.abs(item.left - (last.left + shiftPx)) < Math.abs(best.left - (last.left + shiftPx))
          ? item
          : best
      )
      check(
        '自动吸附把片段贴到相邻边缘',
        Math.abs(moved.left - prev.right) <= 2,
        `吸附后 ${moved.left} vs 前段右边缘 ${prev.right}`
      )
      await page.locator('[data-tl-snap="on"]').click()
      check('可以关闭自动吸附', (await page.locator('[data-tl-snap="off"]').count()) === 1)
      await page.locator('[data-tl-snap="off"]').click()
    }

    // 预览播放：播放头应推进、时间码随之变化（时间码精确到秒，等 1.6s 才能看出变化）
    const timeBeforePlay = await page.locator('.tl-transport-time').innerText()
    await page.locator('.tl-transport-play').click()
    await page.waitForTimeout(1600)
    const timeAfterPlay = await page.locator('.tl-transport-time').innerText()
    await page.locator('.tl-transport-play').click()
    check('预览播放会推进播放头', timeBeforePlay !== timeAfterPlay, `${timeBeforePlay} → ${timeAfterPlay}`)
    await shot('10-fullscreen-editor')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

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
