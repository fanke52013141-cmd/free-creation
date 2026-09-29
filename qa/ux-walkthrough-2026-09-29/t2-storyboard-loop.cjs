/* eslint-disable */
// UX 走查 任务2：分镜板手填 2 镜 → 改台词 → 加第 3 镜 → 排序 → 删 1 镜撤销 → 接循环节点逐项跑
// 用法：BROWSER_ORIGIN=http://127.0.0.1:5211 node t2-storyboard-loop.cjs
const { chromium } = require('playwright')
const fs = require('node:fs')
const DIR = __dirname
const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5211'
const LOG = []
const note = (m) => { LOG.push(m); console.log('NOTE', m) }
const dumpLog = () => fs.writeFileSync(`${DIR}/t2-observations.log`, LOG.join('\n'), 'utf8')

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const o of attempts) { try { return await chromium.launch({ ...o, headless: true, timeout: 30_000 }) } catch (e) { lastError = e } }
  throw lastError
}
const shot = async (page, name) => { await page.screenshot({ path: `${DIR}/${name}` }); note(`截图 ${name}`) }
const safeClick = async (page, locator, tag) => {
  try { await locator.click({ timeout: 4000 }); return } catch (e) {
    note(`safeClick[${tag}] 常规点击被拦截，改用 DOM 事件序列`)
    await locator.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const base = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }))
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }))
      el.dispatchEvent(new MouseEvent('click', base))
    })
  }
}
const dumpCard = async (page, id, tag) => {
  const info = await page.evaluate((nodeId) => {
    const el = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
    if (!el) return null
    const btns = [...el.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
    const ports = [...el.querySelectorAll('.port-dot')].map((p) => `${p.classList.contains('out') ? 'out' : 'in'}:${p.dataset.portId}`)
    return { text: el.innerText.replace(/\n{2,}/g, '\n').slice(0, 1000), btns: [...new Set(btns)].slice(0, 40), ports }
  }, id)
  note(`DUMP[${tag}] ${JSON.stringify(info, null, 1)}`)
  return info
}
const dumpToasts = async (page, tag) => {
  const t = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('[class*="toast"]')) { const r = el.getBoundingClientRect(); if (r.width && r.height) out.push(el.innerText.slice(0, 200)) }
    return [...new Set(out)]
  })
  if (t.length) note(`TOASTS[${tag}] ` + JSON.stringify(t))
}
const dumpRows = async (page, id, tag) => {
  const rows = await page.evaluate((nodeId) => {
    const el = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
    if (!el) return null
    return [...el.querySelectorAll('.storyboard-table tbody tr')].map((tr) => ({
      shotId: tr.dataset.shotId,
      cells: [...tr.querySelectorAll('[data-field]')].map((c) => `${c.dataset.field}=${(c.innerText || '').trim().slice(0, 20)}`)
    }))
  }, id)
  note(`ROWS[${tag}] ` + JSON.stringify(rows))
  return rows
}
const editCell = async (page, id, shotId, field, text, tag) => {
  const wrapSel = `.node-card-wrap[data-node-id="${id}"]`
  const cellSel = `${wrapSel} [data-shot-id="${shotId}"] [data-field="${field}"]`
  const openEditor = page.locator(`${cellSel} .storyboard-cell-editor textarea`)
  if (await openEditor.count()) {
    note(`editCell[${field}]: 新行已自带打开的编辑器，直接填写`)
  } else {
    await page.locator(`${cellSel} .storyboard-cell-value`).dblclick()
    await page.waitForTimeout(300)
  }
  const editor = page.locator(`${cellSel} .storyboard-cell-editor textarea`).first()
  await editor.fill(text)
  if (tag) await shot(page, `${tag}-midedit.png`)
  await page.locator(cellSel).getByRole('button', { name: '保存', exact: true }).first().click()
  await page.waitForTimeout(400)
}
const moveNode = async (page, id, tx, ty) => {
  const box = await page.locator(`.node-card-wrap[data-node-id="${id}"]`).boundingBox()
  if (!box) throw new Error('moveNode: 卡片不存在 ' + id)
  await page.keyboard.press('Escape')
  const sx = box.x + 30, sy = box.y + 12
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(tx, ty, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(400)
}
async function addNodeViaPalette(page, category, chip) {
  const before = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const expand = page.getByRole('button', { name: `展开${category}节点`, exact: true })
  await safeClick(page, expand, `展开${category}`)
  await page.waitForTimeout(600)
  const btn = page.getByRole('button', { name: `添加${chip}节点`, exact: true })
  await safeClick(page, btn, `添加${chip}`)
  await page.waitForTimeout(900)
  const after = await page.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const fresh = after.filter((x) => !before.includes(x))
  if (!fresh.length) throw new Error(`添加${chip}失败`)
  note(`添加节点：${category} → 添加${chip}节点 → node-id=${fresh[0]}`)
  return fresh[0]
}
async function connect(page, fromId, outPort, toId, inPort) {
  await page.keyboard.press('Escape')
  const sel = (id, dir, port) => `.node-card-wrap[data-node-id="${id}"] .port-dot.${dir}[data-port-id="${port}"]`
  const hit = async (s, dbg) => {
    for (let i = 0; i < 10; i++) {
      if ((await page.locator(s).count()) === 0) { await page.waitForTimeout(300); continue }
      const b = await page.locator(s).boundingBox()
      if (b && b.width > 0 && (await page.locator(s).evaluate((el, c) => { const h = document.elementFromPoint(c.x, c.y); return h === el || el.contains(h) }, { x: b.x + b.width / 2, y: b.y + b.height / 2 }))) return b
      await page.waitForTimeout(150)
    }
    if (dbg) {
      const diag = await page.evaluate((nodeId) => {
        const w = document.querySelector(`.node-card-wrap[data-node-id="${nodeId}"]`)
        if (!w) return { wrap: 'MISSING', count: document.querySelectorAll('.node-card-wrap').length }
        const r = w.getBoundingClientRect()
        return { wrap: 'ok', rect: { x: r.x, y: r.y, w: r.width, h: r.height }, cls: w.className, ports: [...w.querySelectorAll('.port-dot')].map((p) => p.dataset.portId), cams: document.querySelector('.tl-container')?.style.transform }
      }, dbg)
      note(`connect 诊断 ${dbg}: ` + JSON.stringify(diag))
    }
    throw new Error('端口不可命中: ' + s)
  }
  const a = await hit(sel(fromId, 'out', outPort), fromId)
  const b = await hit(sel(toId, 'in', inPort), toId)
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2
  const bx = b.x + b.width / 2, by = b.y + b.height / 2
  await page.mouse.move(ax, ay); await page.mouse.down()
  await page.waitForTimeout(120)
  for (let s = 1; s <= 16; s++) { await page.mouse.move(ax + ((bx - ax) * s) / 16, ay + ((by - ay) * s) / 16); await page.waitForTimeout(16) }
  await page.mouse.move(bx, by); await page.waitForTimeout(150); await page.mouse.up()
  await page.waitForTimeout(700)
  note(`连线 ${fromId}.${outPort} → ${toId}.${inPort}`)
}

;(async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 200)))

  await page.goto(ORIGIN + '/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  // A. 默认「通用」工作区下的 流程与高级 flyout：循环是否可达
  const expandLogic = page.getByRole('button', { name: '展开流程与高级节点', exact: true })
  await safeClick(page, expandLogic, '展开流程与高级')
  await page.waitForTimeout(600)
  const logicChips = await page.getByRole('button', { name: /^添加.+节点$/ }).allTextContents()
  note('默认项目 流程与高级 flyout chips：' + JSON.stringify(logicChips))
  await shot(page, 't2-01-logic-flyout-default.png')
  await page.mouse.move(853, 620)

  // B. 经 项目菜单 → 工作台节点设置 打开循环节点可见性（真实用户路径）
  await safeClick(page, page.getByRole('button', { name: '项目菜单', exact: true }), '项目菜单')
  await page.waitForTimeout(500)
  await shot(page, 't2-02-project-menu.png')
  note('项目菜单项：' + JSON.stringify(await page.locator('.node-menu-item').allTextContents()))
  await safeClick(page, page.getByRole('button', { name: '工作台节点设置', exact: true }), '工作台节点设置')
  await page.waitForTimeout(700)
  await shot(page, 't2-03-node-visibility-dialog.png')
  const dlgTitle = await page.evaluate(() => document.querySelector('.project-create-dialog h2')?.textContent || '(无)')
  note('工作台节点设置对话框标题：' + dlgTitle)
  const itBox = page.getByRole('checkbox', { name: '循环', exact: true })
  if (await itBox.count()) {
    if (!(await itBox.isChecked())) {
      await safeClick(page, itBox, '勾选循环')
      await page.waitForTimeout(300)
    }
    note('已勾选「循环」节点')
  } else { note('可见性对话框中未找到「循环」复选框（尝试搜索框）') }
  await shot(page, 't2-03b-node-visibility-checked.png')
  await safeClick(page, page.locator('.project-create-submit'), '保存节点可见性')
  await page.waitForTimeout(1200)
  await shot(page, 't2-04-project-after-visibility.png')
  // 重新展开 流程与高级 验证 循环 chip 出现
  await safeClick(page, expandLogic, '再展开流程与高级')
  await page.waitForTimeout(600)
  note('启用后 流程与高级 flyout chips：' + JSON.stringify(await page.getByRole('button', { name: /^添加.+节点$/ }).allTextContents()))
  await page.mouse.move(853, 620)

  // C. 分镜板手填 2 镜
  const sbId = await addNodeViaPalette(page, '流程与高级', '分镜板')
  await moveNode(page, sbId, 480, 300)
  await dumpCard(page, sbId, '分镜板空态')
  await shot(page, 't2-05-storyboard-empty.png')
  const addShot = page.locator(`.node-card-wrap[data-node-id="${sbId}"]`).getByRole('button', { name: '新增镜头' }).first()
  await safeClick(page, addShot, '新增镜头1')
  await page.waitForTimeout(400)
  await safeClick(page, page.locator(`.node-card-wrap[data-node-id="${sbId}"]`).getByRole('button', { name: '新增镜头' }).first(), '新增镜头2')
  await page.waitForTimeout(400)
  await dumpRows(page, sbId, '手填两镜后')
  await shot(page, 't2-06-two-rows.png')

  // 填第 1 镜
  const rows1 = await dumpRows(page, sbId, '编辑前')
  const ids = rows1.map((r) => r.shotId)
  await editCell(page, sbId, ids[0], 'scene', '雨夜霓虹街头', 't2-07-scene1')
  await shot(page, 't2-07-scene1-saved.png')
  await editCell(page, sbId, ids[0], 'dialogue', '别回头')
  await editCell(page, sbId, ids[0], 'duration', '4s')
  await editCell(page, sbId, ids[1], 'scene', '潮湿的巷口')
  await editCell(page, sbId, ids[1], 'dialogue', '（无台词）')
  await editCell(page, sbId, ids[1], 'duration', '5s')
  await dumpRows(page, sbId, '两镜填写完成')
  await shot(page, 't2-08-filled.png')

  // D. 改台词（镜1）
  await editCell(page, sbId, ids[0], 'dialogue', '别回头，快走')
  await dumpRows(page, sbId, '改台词后')
  await shot(page, 't2-09-dialogue-changed.png')

  // E. 加第 3 镜
  await safeClick(page, page.locator(`.node-card-wrap[data-node-id="${sbId}"]`).getByRole('button', { name: '新增镜头' }).first(), '新增镜头3')
  await page.waitForTimeout(400)
  const rows3 = await dumpRows(page, sbId, '第三镜新增')
  const id3 = rows3.map((r) => r.shotId)[2]
  if (id3) {
    await editCell(page, sbId, id3, 'scene', '天台日出')
    await editCell(page, sbId, id3, 'dialogue', '结束了')
    await editCell(page, sbId, id3, 'duration', '6s')
  }
  await dumpRows(page, sbId, '第三镜填写完成')
  await shot(page, 't2-10-three-rows.png')

  // F. 排序：把第 1 镜下移
  await safeClick(page, page.getByRole('button', { name: `下移镜头 1`, exact: true }), '下移镜头1')
  await page.waitForTimeout(500)
  await dumpRows(page, sbId, '下移镜1后')
  await shot(page, 't2-11-after-move.png')

  // G. 删 1 镜 + 撤销
  await safeClick(page, page.getByRole('button', { name: `删除镜头 2`, exact: true }), '删除镜头2')
  await page.waitForTimeout(600)
  await shot(page, 't2-12-delete-confirm.png')
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('[role="alertdialog"], [role="dialog"], .confirm-mask, [class*="confirm"]')
    return d ? d.innerText.replace(/\n{2,}/g, '\n').slice(0, 300) : null
  })
  note('删除确认弹窗：' + JSON.stringify(dlg))
  const confirmBtn = page.getByRole('button', { name: '删除', exact: true }).last()
  await safeClick(page, confirmBtn, '确认删除')
  await page.waitForTimeout(600)
  await dumpRows(page, sbId, '删除后')
  await shot(page, 't2-13-after-delete.png')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(800)
  await dumpRows(page, sbId, 'Ctrl+Z 撤销后')
  await shot(page, 't2-14-after-undo.png')
  await dumpToasts(page, '撤销后')

  // H. 接循环节点逐项跑
  // H0. 已证：分镜板 out-json(storyboard.shots@1) 无法直连 循环 in-list(list.items@1)，拒绝 toast 见 t2-16
  // H1. 先把 循环体（文本节点）接到 out-item，再经 JSON 节点(json.any@1) 提供 list.items 列表
  const itId = await addNodeViaPalette(page, '流程与高级', '循环')
  await moveNode(page, itId, 1150, 300)
  await dumpCard(page, itId, '循环节点空态')
  await shot(page, 't2-15-iterate-empty.png')
  // H0. 先试自然路径：分镜板 out-json → 循环 in-list（预期契约拒绝）
  await connect(page, sbId, 'out-json', itId, 'in-list')
  await page.waitForTimeout(600)
  await dumpToasts(page, '分镜板→循环')
  await shot(page, 't2-16-storyboard-to-iterate-rejected.png')
  const edgeAfterReject = await page.evaluate(() => document.querySelectorAll('.data-edge').length)
  note(`分镜板→循环 连线后 .data-edge 数量（0=被拒绝）：${edgeAfterReject}`)
  const txtId = await addNodeViaPalette(page, '输入与 AI', '文本')
  await moveNode(page, txtId, 1560, 660)
  await connect(page, itId, 'out-item', txtId, 'in-text')
  await shot(page, 't2-17-loop-body.png')
  // H2. JSON 节点：经 工作台节点设置 再启用
  await safeClick(page, page.getByRole('button', { name: '项目菜单', exact: true }), '项目菜单2')
  await page.waitForTimeout(400)
  await safeClick(page, page.getByRole('button', { name: '工作台节点设置', exact: true }), '工作台节点设置2')
  await page.waitForTimeout(700)
  const jsonBox = page.getByRole('checkbox', { name: 'JSON', exact: true })
  if (await jsonBox.count()) {
    if (!(await jsonBox.isChecked())) await safeClick(page, jsonBox, '勾选JSON')
    note('已勾选「JSON」节点')
  } else { note('可见性对话框中未找到「JSON」复选框') }
  await safeClick(page, page.locator('.project-create-submit'), '保存节点可见性2')
  await page.waitForTimeout(1000)
  const jsonId = await addNodeViaPalette(page, '流程与高级', 'JSON')
  await moveNode(page, jsonId, 900, 660)
  await dumpCard(page, jsonId, 'JSON节点空态')
  await shot(page, 't2-18-json-empty.png')
  const jsonOpen = page.locator(`.node-card-wrap[data-node-id="${jsonId}"]`).getByRole('button', { name: '粘贴 JSON' })
  if (await jsonOpen.count()) {
    await safeClick(page, jsonOpen, '粘贴JSON入口')
    await page.waitForTimeout(500)
    note('点击「粘贴 JSON」后出现编辑区')
  }
  const jsonTa = page.locator(`.node-card-wrap[data-node-id="${jsonId}"] textarea`).first()
  await jsonTa.click()
  await jsonTa.fill(JSON.stringify([
    { index: 1, title: '雨夜霓虹街头', dialogue: '别回头，快走' },
    { index: 2, title: '潮湿的巷口', dialogue: '' },
    { index: 3, title: '天台日出', dialogue: '结束了' }
  ], null, 2))
  // JSON 节点运行入口
  const jsonRunLabels = await page.evaluate((id) => [...document.querySelectorAll(`.node-card-wrap[data-node-id="${id}"] button`)].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()), jsonId)
  note('JSON 卡片按钮：' + JSON.stringify(jsonRunLabels))
  const jsonRun = page.locator(`.node-card-wrap[data-node-id="${jsonId}"] .node-run-btn`)
  if (await jsonRun.count()) await safeClick(page, jsonRun, 'JSON运行节点')
  await page.waitForTimeout(1500)
  await dumpCard(page, jsonId, 'JSON运行后')
  await shot(page, 't2-19-json-done.png')
  await connect(page, jsonId, 'out-json', itId, 'in-list')
  await dumpCard(page, itId, '循环拿到列表后')
  await shot(page, 't2-20-iterate-ready.png')
  // H3. 运行循环节点：先卡片头「运行节点」，再试卡片体「全部运行」
  await safeClick(page, page.locator(`.node-card-wrap[data-node-id="${itId}"] .node-run-btn`), '循环运行节点')
  await page.waitForTimeout(2500)
  const afterHeaderRun = await page.evaluate((id) => document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)?.innerText.includes('尚未运行'), itId)
  note(`头「运行节点」点击后卡片仍显示「尚未运行」：${afterHeaderRun}`)
  const runAllBtn = page.locator(`.node-card-wrap[data-node-id="${itId}"]`).getByRole('button', { name: '全部运行' })
  if (await runAllBtn.count()) {
    await safeClick(page, runAllBtn, '全部运行')
    await page.waitForTimeout(400)
    await shot(page, 't2-21-iterate-running.png')
    note('循环运行中卡片文本：\n' + await page.evaluate((id) => document.querySelector(`.node-card-wrap[data-node-id="${id}"]`)?.innerText.replace(/\n{2,}/g, '\n').slice(0, 500), itId))
  }
  await page.waitForTimeout(5000)
  await dumpCard(page, itId, '循环运行后')
  await dumpToasts(page, '循环运行后')
  await shot(page, 't2-22-iterate-done.png')
  // 运行中心是否有记录
  const rcBtn = page.getByRole('button', { name: '打开运行中心', exact: true })
  if (await rcBtn.count()) {
    await safeClick(page, rcBtn, '运行中心')
    await page.waitForTimeout(900)
    await shot(page, 't2-23-run-center.png')
    note('运行中心文本：\n' + await page.evaluate(() => document.querySelector('.side-panel')?.innerText.replace(/\n{2,}/g, '\n').slice(0, 700) || '(无)'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }

  note('CONSOLE ERRORS: ' + JSON.stringify(errors.slice(0, 10)))
  dumpLog()
  await browser.close()
})().catch((e) => {
  console.error('FAIL', e)
  note('FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)))
  dumpLog()
  process.exitCode = 1
})
