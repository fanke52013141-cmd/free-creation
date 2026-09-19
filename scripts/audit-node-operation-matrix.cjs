/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// §8 P2 逐节点操作矩阵（真实 Electron，全程免费通道：不配置供应商、不调用任何模型）
//
// 回答的问题很具体：每个节点在真实桌面上能不能「新建 → 看到契约端口 → 无输入时诚实拦截 →
// 配置 → 连单输入 → 连多输入 → 运行成功 → 失败有原因 → 保存重载后不丢」。
// 任何一步做不到就是缺陷，本门禁同时给出界面证据（截图）与磁盘真值（tldrawSnapshot）。
//
// 隔离：默认在 %LOCALAPPDATA%\canvas-node-matrix-<时间戳> 建全新数据目录，绝不读写用户
// 真实项目库；也可用 E2E_DATA_DIR 指定。
// 节点间有依赖（循环吃结构数据的列表输出），因此按 RECIPES 顺序整跑；
// MATRIX=text,json 可只跑前几项做定位。
const { _electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = 'D:/Program Files (x86)/free-creation'
const DATA_DIR =
  process.env.E2E_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), `canvas-node-matrix-${Date.now()}`)
const SHOT_DIR = path.join(ROOT, 'artifacts/node-matrix-2026-09-19')
const SELECTED = (process.env.MATRIX || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const results = []
const pageErrors = new Map()
const firstStack = new Map()
const log = (...a) => console.log('[matrix]', ...a)
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
  log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${String(detail).slice(0, 240)}`}`
  )
}

let win
let projectId
let shotSeq = 0

async function shot(name) {
  shotSeq += 1
  const file = path.join(SHOT_DIR, `${String(shotSeq).padStart(2, '0')}-${name}.png`)
  try {
    await win.screenshot({ path: file })
  } catch (error) {
    log('截图失败', name, error.message)
  }
}

/** 磁盘真值：主进程存结构化对象，浏览器 mock 才存字符串，两种都要能读。 */
function obj(v) {
  if (v === undefined || v === null || v === '') return {}
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    // 代码节点的 config 允许是一段裸源码（历史兼容），执行器同样按原文处理。
    return { raw: v }
  }
}

/** 读一次落库快照，节点卡与连线都从这里派生。 */
async function readDoc() {
  return win.evaluate(async ({ pid }) => {
    const r = await window.api.openProject(pid)
    if (!r.ok || !r.data) return { error: r.error ? r.error.message : 'openProject 没有返回项目' }
    const s = r.data.tldrawSnapshot
    const doc = typeof s === 'string' ? JSON.parse(s) : s
    if (!doc) return []
    return Object.values(doc.store || doc)
  }, { pid: projectId })
}

async function readShapes() {
  const raw = await readDoc()
  if (!Array.isArray(raw)) throw new Error(`读取磁盘快照失败：${raw.error}`)
  return new Map(
    raw
      .filter((v) => v && v.props && typeof v.props === 'object' && 'nodeType' in v.props)
      .map((v) => [
        v.id,
        {
          id: v.id,
          nodeType: v.props.nodeType,
          title: v.props.title,
          text: v.props.text ?? '',
          exec: v.props.exec,
          config: obj(v.props.config),
          run: obj((v.meta || {}).nodeRun),
          resultRaw:
            typeof (v.meta || {}).nodeResult === 'string'
              ? (v.meta || {}).nodeResult
              : (v.meta || {}).nodeResult
        }
      ])
  )
}

/** 等自动保存落库；predicate 不满足就继续轮询（最多约 15s）。 */
async function disk(id, predicate) {
  let shape = null
  for (let round = 0; round < 25; round += 1) {
    const shapes = await readShapes()
    shape = shapes.get(id) ?? null
    if (shape && (!predicate || predicate(shape))) return shape
    await win.waitForTimeout(600)
  }
  return shape
}

function card(id) {
  return win.locator(`.node-card-wrap[data-node-id="${id}"]`)
}

async function hittable(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      ok: Boolean(hit && el.contains(hit)),
      cx,
      cy,
      rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}`
    }
  })
}

/** 布局快照：卡片落在屏幕哪里、视口多大、某个坐标上压着哪一层。遮挡类失败靠它定位。 */
async function dumpLayout(x, y) {
  return win.evaluate(
    ({ px, py }) => {
      const chain = []
      let el = document.elementFromPoint(px, py)
      for (let i = 0; el && i < 6; i += 1) {
        chain.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`)
        el = el.parentElement
      }
      return {
        viewport: `${innerWidth}×${innerHeight}`,
        cards: Array.from(document.querySelectorAll('.node-card-wrap')).map((node) => {
          const r = node.getBoundingClientRect()
          return `${node.querySelector('.node-card')?.dataset.nodeType ?? '?'}:${String(node.dataset.nodeId).slice(-4)}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}`
        }),
        atPoint: chain.join(' < ')
      }
    },
    { px: x, py: y }
  )
}

/** 控件是否真的可点：命中不了就直接中止本配方，盲点会落到别的卡片上，制造假失败。 */
async function ensureClickable(locator, label) {
  for (let i = 0; i < 4; i += 1) {
    if ((await hittable(locator)).ok) return true
    await win.waitForTimeout(250)
  }
  // 卡片内容超过最高档位时底部工具条会落在卡片的内部滚动区里，先像用户那样滚出来。
  await locator.scrollIntoViewIfNeeded().catch(() => undefined)
  await win.waitForTimeout(300)
  for (let i = 0; i < 4; i += 1) {
    if ((await hittable(locator)).ok) return true
    await win.waitForTimeout(250)
  }
  const r = await hittable(locator)
  const layout = await dumpLayout(r.cx, r.cy)
  check(
    `${label}：控件可命中（不被顶栏/别的卡片遮挡）`,
    false,
    `${r.rect}｜视口 ${layout.viewport}｜卡片 ${layout.cards.join(' ')}｜压在上面：${layout.atPoint}`
  )
  throw new Error(`${label} 点不到（${r.rect}），后面的点击会落到别的卡片上，直接中止本配方`)
}

/** 只按「缩小」把相机降到指定比例以下。 */
async function shrinkTo(percent) {
  for (let i = 0; i < 14; i += 1) {
    const current = Number((await win.locator('.dock-zoom-label').innerText()).replace('%', ''))
    if (current <= percent) return current / 100
    await win.getByRole('button', { name: '缩小', exact: true }).click()
    await win.waitForTimeout(320)
  }
  return Number((await win.locator('.dock-zoom-label').innerText()).replace('%', '')) / 100
}

/** 先把相机复位到 100%，再退到指定比例以下，网格布局才是确定的。 */
async function zoomAtMost(percent) {
  const reset = win.getByRole('button', { name: '重置缩放到 100%', exact: true })
  await reset.waitFor({ timeout: 10000 })
  await reset.click()
  await win.waitForTimeout(450)
  return shrinkTo(percent)
}

// 拖拽创建用固定网格：让每张卡都落在视口内且互不重叠，端口坐标才是确定的。
// 60% 缩放下一张卡是 204×156（内容多时最长 264），3 列 × 2 行正好铺满视口安全区。
const GRID = { cols: 3, cellW: 320, cellH: 300, originX: 240, originY: 150 }
const NODE_W = 340
const NODE_H = 260
let zoom = 1
let slot = 0

/**
 * 每条配方开一个全新项目：画布天生空白、相机天生归位，
 * 不需要「删卡片」或「平移镜头」这类本身也要验收的能力来给矩阵铺路。
 */
async function freshProject(key) {
  const home = win.getByRole('button', { name: '回到主页' })
  if (await home.count()) await home.click()
  const create = win.getByRole('button', { name: '新建项目' })
  await create.waitFor({ timeout: 15000 })
  await create.click()
  const name = `矩阵-${key}`
  await win.locator('input[placeholder="项目名称"]').fill(name)
  await win.getByRole('button', { name: '创建', exact: true }).click()
  await win.locator('.node-palette').waitFor({ timeout: 30000 })
  projectId = await win.evaluate(
    async (projectName) =>
      (await window.api.listProjects()).data.find((p) => p.name === projectName).id,
    name
  )
  check(`${name}：全新项目可创建并进入画布`, Boolean(projectId), projectId)
  zoom = await zoomAtMost(60)
  slot = 0
  const visible = await win.locator('.node-card-wrap').count()
  check('新项目的画布是空的', visible === 0, `${visible} 张卡片`)
}

async function addNode(label) {
  // 落点给的是卡片中心：exactCentered 建卡时以光标为中心放置。
  const where = GRID.originX + (slot % GRID.cols) * GRID.cellW + (NODE_W * zoom) / 2
  const y =
    GRID.originY + Math.floor(slot / GRID.cols) * GRID.cellH + (NODE_H * zoom) / 2
  const before = await win.$$eval('.node-card-wrap', (els) => els.map((e) => e.dataset.nodeId))
  const btn = win.getByRole('button', { name: `添加${label}节点`, exact: true })
  await btn.scrollIntoViewIfNeeded()
  slot += 1
  // 从面板按住拖到画布指定位置松手：走的是真实用户的第二种创建手势，
  // 且落点由光标决定，不像点击那样会被避让算法堆到同一处。
  const from = await btn.boundingBox()
  if (!from) throw new Error(`创建面板里没有「${label}」按钮`)
  await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await win.mouse.down()
  for (let step = 1; step <= 12; step += 1) {
    await win.mouse.move(
      from.x + ((where - from.x) * step) / 12,
      from.y + ((y - from.y) * step) / 12
    )
    await win.waitForTimeout(20)
  }
  await win.mouse.up()
  for (let i = 0; i < 40; i += 1) {
    await win.waitForTimeout(120)
    const after = await win.$$eval('.node-card-wrap', (els) =>
      els.map((e) => e.dataset.nodeId)
    )
    const fresh = after.filter((x) => !before.includes(x))
    if (fresh.length) {
      await card(fresh[0]).waitFor({ timeout: 5000 })
      return fresh[0]
    }
  }
  throw new Error(`点击「添加${label}节点」后没有出现新卡片`)
}

async function portBox(id, dir, portId) {
  const sel = `.node-card-wrap[data-node-id="${id}"] .port-dot.${dir}[data-port-id="${portId}"]`
  const loc = win.locator(sel)
  await loc.waitFor({ timeout: 5000 })
  // 圆点的命中区是外层 18px span，可见小圆点只是 ::after；坐标必须真的落在这个口上，
  // 否则拖线会变成画布框选或误连相邻端口。
  let hitInfo = '（从未命中）'
  for (let i = 0; i < 12; i += 1) {
    const box = await loc.boundingBox()
    if (box) {
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      const probe = await win.evaluate(({ x, y, s }) => {
        const el = document.elementFromPoint(x, y)
        return {
          ok: Boolean(el && el.closest(s)),
          what: el
            ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}#${el.dataset?.portId ?? ''}#${el.closest('.node-card-wrap')?.dataset?.nodeId?.slice(-4) ?? ''}`
            : 'null'
        }
      }, { x: cx, y: cy, s: sel })
      hitInfo = probe.what
      if (probe.ok) return { cx, cy }
    }
    await win.waitForTimeout(150)
  }
  const box = await loc.boundingBox()
  const layout = await dumpLayout(box ? box.x + box.width / 2 : 0, box ? box.y + box.height / 2 : 0)
  throw new Error(
    `端口 ${portId} 无法命中（缩放重叠或被遮挡）｜${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` : '无盒子'}｜命中到：${hitInfo}｜视口 ${layout.viewport}｜卡片 ${layout.cards.join(' ')}`
  )
}

async function edgeCount() {
  const raw = await readDoc()
  if (!Array.isArray(raw)) return -1
  return raw.filter((v) => v.typeName === 'shape' && v.type === 'arrow' && v.meta?.fromPort).length
}

/** 连线的磁盘真值：端口对 + 两端绑在哪张卡上。用于区分「没连上」和「连错口」。 */
async function describeEdges() {
  const raw = await readDoc()
  if (!Array.isArray(raw)) return []
  const label = (id) => {
    const hit = raw.find((v) => v && v.id === id)
    return hit && hit.props ? `${hit.props.nodeType}:${String(id).slice(-4)}` : String(id).slice(-6)
  }
  const arrows = raw.filter((v) => v.typeName === 'shape' && v.type === 'arrow')
  const bindings = raw.filter((v) => v.typeName === 'binding' && v.type === 'arrow')
  return arrows.map((a) => {
    const ends = bindings.filter((b) => b.fromId === a.id)
    const at = (terminal) =>
      label((ends.find((b) => b.props?.terminal === terminal) || {}).toId ?? '?')
    return {
      from: `${at('start')}.${a.meta?.fromPort ?? '?'}`,
      to: `${at('end')}.${a.meta?.toPort ?? '?'}`
    }
  })
}

/** 从 A 的输出端口拖线到 B 的输入端口；返回是否真的多了一条连线。 */
async function connect(fromId, outPort, toId, inPort) {
  await win.keyboard.press('Escape')
  const a = await portBox(fromId, 'out', outPort)
  const b = await portBox(toId, 'in', inPort)
  const before = await edgeCount()
  await win.mouse.move(a.cx, a.cy)
  await win.mouse.down()
  for (let step = 1; step <= 20; step += 1) {
    await win.mouse.move(
      a.cx + ((b.cx - a.cx) * step) / 20,
      a.cy + ((b.cy - a.cy) * step) / 20
    )
    await win.waitForTimeout(16)
  }
  await win.mouse.move(b.cx, b.cy)
  await win.waitForTimeout(150)
  await win.mouse.up()
  for (let i = 0; i < 12; i += 1) {
    await win.waitForTimeout(250)
    if ((await edgeCount()) > before) return true
  }
  // 拖到空白处会留下「待建节点」的连线草稿和创建菜单，不清掉会污染后面的操作。
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  return false
}

async function statusOf(id) {
  const aria = (await card(id).locator('.node-status').getAttribute('aria-label')) || ''
  const btn = card(id).locator('.node-run-btn')
  const disabled = (await btn.count()) === 0 ? null : await btn.isDisabled()
  return { aria, disabled }
}

async function portsOf(id) {
  return card(id).evaluate((el) => ({
    in: Array.from(el.querySelectorAll('.port-dot.in[data-port-id]')).map((n) => n.dataset.portId),
    out: Array.from(el.querySelectorAll('.port-dot.out[data-port-id]')).map(
      (n) => n.dataset.portId
    )
  }))
}

/** NODE_COMPLIANCE_MATRIX.md 声明的端口必须与画布实际渲染的一致。 */
async function checkPorts(id, nodeType, expectedIn, expectedOut) {
  const got = await portsOf(id)
  const same = (a, b) => JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort())
  check(
    `${nodeType}：端口渲染与契约矩阵一致`,
    same(got.in, expectedIn) && same(got.out, expectedOut),
    `实际 in=${got.in.join('/') || '无'} out=${got.out.join('/') || '无'}｜期望 in=${expectedIn.join('/')} out=${expectedOut.join('/')}`
  )
}

/** 点击运行并等待「这一次」的运行落库；返回磁盘上的节点真值。 */
async function runNode(id) {
  const st = await statusOf(id)
  if (st.disabled !== false) return { blocked: true, aria: st.aria }
  const btn = card(id).locator('.node-run-btn')
  if (!(await ensureClickable(btn, `${id} 运行按钮`))) return { blocked: true, aria: '被遮挡' }
  // 自动保存有防抖：只等「状态已落定」会读到上一次运行留下的旧记录。runId 每次运行都换，
  // 用它当栅栏才是真的等到了这一次。
  const previous = await disk(id)
  await btn.click()
  const shape = await disk(
    id,
    (s) =>
      s.exec !== 'running' &&
      s.exec !== 'queued' &&
      Boolean(s.run && s.run.status) &&
      s.run.runId !== (previous?.run ?? {}).runId
  )
  return { blocked: false, shape: shape ?? (await disk(id)) }
}

async function fillInto(ta, value) {
  await ta.fill(value)
  await ta.blur()
  await win.waitForTimeout(600)
}

/** 文本类节点：双击正文 → textarea → 填 → blur 提交。 */
async function setText(id, value) {
  const target = card(id).locator('.node-text').first()
  await ensureClickable(target, '文本正文区')
  await target.dblclick()
  const ta = card(id).locator('textarea.node-textarea')
  await ta.waitFor({ timeout: 5000 })
  await fillInto(ta, value)
}

/** 折叠态的 JSON/代码/分镜节点：先点「编辑…」按钮进入 textarea。 */
async function editCodeLike(id, buttonText, value) {
  const c = card(id)
  const btn = c.getByRole('button', { name: new RegExp(buttonText) }).first()
  if (await btn.count()) {
    await ensureClickable(btn, `${buttonText} 按钮`)
    await btn.click()
  }
  const ta = c.locator('textarea').last()
  await ta.waitFor({ timeout: 5000 })
  await fillInto(ta, value)
}

async function reload() {
  await win.waitForTimeout(1500)
  await win.reload()
  await win.waitForLoadState()
  for (let i = 0; i < 30; i += 1) {
    await win.waitForTimeout(400)
    if ((await win.locator('.node-card-wrap').count()) > 0) return true
    const open = win.locator('[aria-label^="打开项目"]')
    if (await open.count()) await open.first().click()
  }
  return false
}

// ============================ 节点配方 ============================

/** 文本：无必填输入，靠正文与上游合并。 */
async function recipeText() {
  const a = await addNode('文本')
  await checkPorts(a, '文本', ['in-text'], ['out-text'])
  check('文本：空卡片给出可发现的输入提示', /双击输入/.test(await card(a).innerText()))

  const empty = await runNode(a)
  const emptyShape = empty.shape ?? (await disk(a))
  check(
    '文本：空正文运行不产生假成功',
    emptyShape && emptyShape.run.status !== undefined && emptyShape.run.status !== 'success',
    JSON.stringify({ exec: emptyShape.exec, run: emptyShape.run.status })
  )

  await setText(a, '上游甲：一句话')
  const b = await addNode('文本')
  await setText(b, '下游乙：另一句话')
  check('文本：out-text → in-text 拖线成功建连', await connect(a, 'out-text', b, 'in-text'))
  check('文本：连上后状态灯不再报缺少输入', !/缺少输入/.test((await statusOf(b)).aria), (await statusOf(b)).aria)
  const r = await runNode(b)
  const sourceA = await disk(a)
  check(
    '文本：运行后真的并入上游正文',
    r.shape.text.includes('上游甲') && r.shape.text.includes('下游乙'),
    JSON.stringify({
      run: r.shape.run.status,
      err: r.shape.run.error,
      a: sourceA.text,
      b: r.shape.text,
      edges: await describeEdges()
    })
  )
  await shot('text-consumed-upstream')

  const c = await addNode('文本')
  await setText(c, '上游丙：第三条')
  check('文本：同一输入端口可接第二个上游', await connect(c, 'out-text', b, 'in-text'))
  const r2 = await runNode(b)
  check('文本：多上游全部被消费', r2.shape.text.includes('上游丙'), JSON.stringify(r2.shape.text))

  await reload()
  check('文本：重载后卡片数不丢', (await win.locator('.type-text').count()) >= 3)
  const persisted = await disk(b, (s) => s.text.includes('上游丙'))
  check('文本：重载后正文里的上游内容仍在', persisted.text.includes('上游丙'), JSON.stringify(persisted.text))
  await shot('text-reload')
  return b
}

/** JSON：正文即输入；非法 JSON 必须给原因；可消费上游结构化值。 */
async function recipeJson() {
  const a = await addNode('JSON')
  await checkPorts(a, 'JSON', ['in-json', 'in-text'], ['out-json'])
  await editCodeLike(a, '粘贴 JSON', '{"title":"开场","shots":[{"n":1},{"n":2}]}')
  const cards = await card(a).locator('.json-data-card').count()
  check('JSON：合法正文渲染结构化卡片', cards === 2, `${cards} 张`)
  const r = await runNode(a)
  check('JSON：合法正文运行成功', r.shape.run.status === 'success', JSON.stringify(r.shape.run))
  check(
    'JSON：输出被格式化回正文（两位缩进）',
    r.shape.text.includes('\n  "title"'),
    JSON.stringify(r.shape.text.slice(0, 40))
  )

  const bad = await addNode('JSON')
  await editCodeLike(bad, '粘贴 JSON', '{"broken":')
  check(
    'JSON：非法正文在界面即时标红',
    (await card(bad).locator('.json-status.invalid').count()) === 1
  )
  const rb = await runNode(bad)
  check(
    'JSON：非法正文运行失败且给出原因',
    rb.shape.run.status === 'failed' && /JSON/.test(JSON.stringify(rb.shape.run.error ?? '')),
    JSON.stringify(rb.shape.run.error ?? rb.shape.run.status)
  )
  await shot('json-invalid-reason')

  const consumer = await addNode('JSON')
  check('JSON：out-json → in-json 建连', await connect(a, 'out-json', consumer, 'in-json'))
  const rc = await runNode(consumer)
  check(
    'JSON：消费上游结构化值而不是自身空正文',
    rc.shape.text.includes('"title"') && rc.shape.run.status === 'success',
    JSON.stringify(rc.shape.text.slice(0, 40))
  )
  await reload()
  const after = await disk(a, (s) => s.text.includes('"title"'))
  check('JSON：重载后格式化结果仍在', after.text.includes('"title"'))
  await shot('json-reload')
}

/** 处理：固定值兜底、字段提取的成功/失败两态。 */
async function recipeProcessor() {
  const a = await addNode('处理')
  await checkPorts(a, '处理', ['in-value'], ['out-value'])
  const empty = await runNode(a)
  const emptyShape = empty.shape ?? (await disk(a))
  check(
    '处理：无连线且无固定值时不假成功',
    emptyShape.run.status !== 'success',
    JSON.stringify(emptyShape.run.status)
  )

  const fix = card(a).locator('input[aria-label="固定值"]')
  await ensureClickable(fix, '固定值输入框')
  await fix.fill('直接传递的固定文本')
  await win.waitForTimeout(600)
  const portState = await card(a).locator('.processor-port-state').first().innerText()
  check('处理：填固定值后界面说明「未连线，用固定值」', /固定值/.test(portState), portState)
  const r1 = await runNode(a)
  check('处理：固定值原样传递成功', r1.shape.run.status === 'success', JSON.stringify(r1.shape.run.status))
  check(
    '处理：结果里能看到输出值',
    String(r1.shape.resultRaw).includes('直接传递的固定文本'),
    JSON.stringify(r1.shape.resultRaw)
  )

  const feeder = await addNode('JSON')
  await editCodeLike(feeder, '粘贴 JSON', '{"scene":"雨夜街道"}')

  const pick = await addNode('处理')
  await card(pick).locator('select[aria-label="处理方式"]').selectOption('pick')
  await win.waitForTimeout(500)
  const pathInput = card(pick).locator('input[aria-label="字段路径"]')
  await pathInput.waitFor({ timeout: 5000 })
  await pathInput.fill('不存在的字段')
  await win.waitForTimeout(600)
  check('处理：JSON 输出可接入 any 输入端口', await connect(feeder, 'out-json', pick, 'in-value'))
  const r2 = await runNode(pick)
  check(
    '处理：字段路径不存在时报出具体路径',
    r2.shape.run.status === 'failed' && /不存在的字段/.test(JSON.stringify(r2.shape.run.error ?? '')),
    JSON.stringify(r2.shape.run.error ?? r2.shape.run.status)
  )
  await shot('processor-pick-missing-path')

  await pathInput.fill('scene')
  await win.waitForTimeout(600)
  const r3 = await runNode(pick)
  check(
    '处理：路径修正后取到字段',
    r3.shape.run.status === 'success' && String(r3.shape.resultRaw).includes('雨夜街道'),
    JSON.stringify(r3.shape.resultRaw)
  )
  await reload()
  const persisted = await disk(pick, (s) => s.run.status === 'success')
  check('处理：重载后运行记录仍在', persisted.run.status === 'success', JSON.stringify(persisted.run.status))
  await shot('processor-reload')
}

/** 分镜板：粘贴 JSON → 镜头卡渲染 → 合成文本流入下游。 */
async function recipeStoryboard() {
  const a = await addNode('分镜板')
  await checkPorts(a, '分镜板', ['in-json', 'in-text'], ['out-json', 'out-text'])
  await editCodeLike(
    a,
    '编辑 JSON',
    '{"shots":[{"scene":"雨夜街景","dialogue":"走吧。","duration":"3s"},{"scene":"天台","dialogue":"","duration":"5s"}]}'
  )
  const shots = await card(a).locator('.storyboard-num').count()
  check('分镜板：粘贴后渲染两张镜头卡', shots === 2, `${shots} 张`)
  const r = await runNode(a)
  check('分镜板：运行成功', r.shape.run.status === 'success', JSON.stringify(r.shape.run))
  check(
    '分镜板：画面描述没有被静默丢掉',
    JSON.stringify(r.shape.config).includes('雨夜街景') || r.shape.text.includes('雨夜街景'),
    JSON.stringify({ config: r.shape.config, text: r.shape.text.slice(0, 60) })
  )
  const b = await addNode('文本')
  await setText(b, '下游占位')
  check('分镜板：out-text 可供文本节点消费', await connect(a, 'out-text', b, 'in-text'))
  const rb = await runNode(b)
  check(
    '分镜板：合成文本真的流入下游',
    rb.shape.text.includes('走吧') || rb.shape.text.includes('雨夜街景'),
    JSON.stringify(rb.shape.text.slice(0, 90))
  )
  await shot('storyboard-flows-downstream')
  await reload()
  const afterShots = await card(a).locator('.storyboard-num').count()
  check('分镜板：重载后镜头卡仍渲染', afterShots === 2, `${afterShots} 张`)
  await shot('storyboard-reload')
}

/** 结构数据：按 Schema 校验，合法/非法两态即时可见。 */
async function recipeStructured() {
  const a = await addNode('结构数据')
  await checkPorts(a, '结构数据', ['in-context', 'in-text'], ['out-json'])
  await card(a).locator('select[aria-label="结构 Schema"]').selectOption('list.items@1')
  await win.waitForTimeout(500)
  await editCodeLike(a, '输入 JSON', '[{"id":"s1"},{"id":"s2"},{"id":"s3"}]')
  const badge = card(a).locator('.json-status').first()
  check(
    '结构数据：符合对象列表 Schema 时给出可用提示',
    (await card(a).locator('.json-status.valid').count()) === 1,
    (await badge.count()) ? await badge.innerText() : '（无状态徽标）'
  )
  const r = await runNode(a)
  check('结构数据：合法结构运行成功', r.shape.run.status === 'success', JSON.stringify(r.shape.run))

  const bad = await addNode('结构数据')
  await card(bad).locator('select[aria-label="结构 Schema"]').selectOption('list.items@1')
  await win.waitForTimeout(500)
  await editCodeLike(bad, '输入 JSON', '{"not":"a list"}')
  check(
    '结构数据：不符合 Schema 即时标红而不是静默通过',
    (await card(bad).locator('.json-status.invalid').count()) === 1
  )
  const rb = await runNode(bad)
  check(
    '结构数据：不符合 Schema 的运行不记为成功',
    rb.shape.run.status !== 'success',
    JSON.stringify(rb.shape.run.status)
  )
  await shot('structured-invalid-schema')
  await reload()
  const after = await disk(a)
  check(
    '结构数据：重载后 Schema 与正文仍在',
    JSON.stringify(after.config).includes('list.items') && after.text.includes('s1'),
    JSON.stringify({ config: after.config, text: after.text.slice(0, 40) })
  )
  await shot('structured-reload')
}

/** 代码：命名输入/输出、受限运行时、自定义参数端口。 */
async function recipeCode() {
  const a = await addNode('代码')
  const ports = await portsOf(a)
  check(
    '代码：默认契约端口渲染（命名输入 + 单个命名输出）',
    ports.in.includes('in-text') && ports.in.includes('in-json') && ports.out.length === 1,
    `in=${ports.in.join('/')} out=${ports.out.join('/')}`
  )

  const bad = await addNode('代码')
  await editCodeLike(bad, '编写代码', 'async function main(args) { return 1 +')
  const rb = await runNode(bad)
  check(
    '代码：语法错误运行失败且原因可见',
    rb.shape.run.status === 'failed' && Boolean(rb.shape.run.error),
    JSON.stringify(rb.shape.run.error ?? rb.shape.run.status)
  )
  check('代码：卡片上能看到失败标记', (await card(bad).locator('.code-result.error').count()) === 1)
  await shot('code-syntax-error')

  const feeder = await addNode('文本')
  await setText(feeder, '代码输入内容')
  await editCodeLike(
    a,
    '编写代码',
    'async function main(args) {\n  const text = String(args.text || "")\n  return { len: text.length, head: text.slice(0, 2) }\n}'
  )
  check('代码：out-text → in-text 建连', await connect(feeder, 'out-text', a, 'in-text'))
  const r = await runNode(a)
  check('代码：合法代码运行成功', r.shape.run.status === 'success', JSON.stringify(r.shape.run))
  check(
    '代码：运行时真的读到上游文本（长度 6、前两个字）',
    String(r.shape.resultRaw).includes('6') && String(r.shape.resultRaw).includes('代码'),
    JSON.stringify(r.shape.resultRaw)
  )
  check('代码：卡片显示成功结果条', (await card(a).locator('.code-result.success').count()) === 1)
  await shot('code-run-success')

  await card(a).locator('.code-params-header button').click()
  await win.waitForTimeout(600)
  await card(a).locator('input.code-param-name').last().fill('prefix')
  await win.waitForTimeout(800)
  const withParam = await portsOf(a)
  check(
    '代码：声明参数后浮出对应输入端口',
    withParam.in.includes('in-param-prefix'),
    `in=${withParam.in.join('/')}`
  )
  const feedJson = await addNode('JSON')
  await editCodeLike(feedJson, '粘贴 JSON', '{"k":"v"}')
  check('代码：自定义参数端口可被连线接入', await connect(feedJson, 'out-json', a, 'in-param-prefix'))
  await reload()
  const persisted = await disk(a)
  check(
    '代码：重载后自定义参数与端口仍在',
    JSON.stringify(persisted.config).includes('prefix') &&
      (await portsOf(a)).in.includes('in-param-prefix'),
    JSON.stringify(persisted.config).slice(0, 140)
  )
  await shot('code-reload')
}

/** 循环：in-list 必填（未连时按钮必须置灰），循环体逐项执行。 */
async function recipeIterate() {
  const a = await addNode('循环')
  await checkPorts(a, '循环', ['in-list'], ['out-item', 'out-items'])
  const st = await statusOf(a)
  check(
    '循环：未接列表时运行按钮置灰并写明缺少输入',
    st.disabled === true && /缺少输入/.test(st.aria),
    st.aria
  )
  await shot('iterate-blocked')

  // 列表来源：结构数据节点选「对象列表」Schema，它的 out-json 才是 list.items@1。
  const list = await addNode('结构数据')
  await card(list).locator('select[aria-label="结构 Schema"]').selectOption('list.items@1')
  await win.waitForTimeout(500)
  await editCodeLike(list, '输入 JSON', '[{"id":"s1"},{"id":"s2"},{"id":"s3"}]')
  check('循环：符合 list.items 的结构数据可接入 in-list', await connect(list, 'out-json', a, 'in-list'))
  check('循环：接上列表后按钮解除置灰', (await statusOf(a)).disabled === false, (await statusOf(a)).aria)

  // 没接循环体时必须说明为什么什么都没跑（而不是静默成功）。
  const noBody = await runNode(a)
  check(
    '循环：未接循环体时给出可执行的提示而不是假成功',
    noBody.shape.run.status !== 'success' &&
      /循环体/.test(JSON.stringify(noBody.shape.run.error ?? '')),
    JSON.stringify(noBody.shape.run.error ?? noBody.shape.run.status)
  )
  await shot('iterate-no-body')

  const body = await addNode('JSON')
  check(
    '循环：out-item 可标记循环体（连到 JSON 节点的数据输入）',
    await connect(a, 'out-item', body, 'in-json')
  )
  const r = await runNode(a)
  check('循环：批量执行成功', r.shape.run.status === 'success', JSON.stringify(r.shape.run))
  const result = obj(r.shape.resultRaw)
  const items = Array.isArray(result.items) ? result.items : []
  check(
    '循环：三项列表逐项产出且进度一致',
    items.length === 3 && result.progress && result.progress.total === 3,
    JSON.stringify(result.progress ?? { items: items.length })
  )
  check(
    '循环：每项结果带来源序号可追溯',
    items.length > 0 && items.every((it) => typeof (it.source || {}).index === 'number'),
    JSON.stringify(items.map((it) => (it.source || {}).index))
  )
  await shot('iterate-items')
  await reload()
  const after = obj((await disk(a)).resultRaw)
  check(
    '循环：重载后逐项结果不丢',
    Array.isArray(after.items) && after.items.length === 3,
    JSON.stringify((after.items || []).length)
  )
  await shot('iterate-reload')
}

const RECIPES = [
  ['text', '文本', recipeText],
  ['json', 'JSON', recipeJson],
  ['processor', '处理', recipeProcessor],
  ['storyboard', '分镜板', recipeStoryboard],
  ['structured', '结构数据', recipeStructured],
  ['iterate', '循环', recipeIterate],
  ['code', '代码', recipeCode]
]

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  log('数据目录（与用户真实库隔离）', DATA_DIR)
  const app = await _electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(ROOT, 'out/main/index.js')],
    env: { ...process.env, CANVAS_DATA_DIR: DATA_DIR, NODE_ENV: 'production' }
  })
  win = await app.firstWindow()
  win.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !/Content Security Policy|cdn\.tldraw|NetworkError/.test(t)) {
      log('renderer>', t.slice(0, 200))
    }
  })
  win.on('pageerror', (e) => {
    const msg = String(e.message).slice(0, 160)
    pageErrors.set(msg, (pageErrors.get(msg) || 0) + 1)
    if (!firstStack.has(msg)) firstStack.set(msg, String(e.stack || '').slice(0, 500))
  })
  await win.waitForLoadState()
  // 首条配方自己会建项目；这里只确认落地页可用。
  await win.getByRole('button', { name: '新建项目' }).waitFor({ timeout: 30000 })
  check('全新数据目录进入项目列表页', true, DATA_DIR)

  for (const [key, label, fn] of RECIPES) {
    if (SELECTED.length && !SELECTED.includes(key)) continue
    log(`---- ${label} ----`)
    try {
      await freshProject(key)
      await fn()
    } catch (error) {
      check(`${label}：配方执行未中断`, false, error.message)
      await shot(`${key}-aborted`)
    }
  }
  // 已知未修：tldraw 把默认字体/图片资源指向 cdn.tldraw.com，桌面离线（且 CSP 受限）时
  // 会反复抛「The source image cannot be decoded」和「Failed to fetch」。
  // 它们与节点无关、也不影响本矩阵的断言，另计一条并留在日志里（见 §7.9），
  // 但不能混进「未预期异常」，否则这条门禁就永远是红的、盖住真正的新异常。
  const KNOWN = [/source image cannot be decoded/, /^Failed to fetch$/]
  const knownErrors = new Map()
  const unexpected = new Map()
  for (const [msg, n] of pageErrors) {
    if (KNOWN.some((re) => re.test(msg))) knownErrors.set(msg, n)
    else unexpected.set(msg, n)
  }
  check(
    '整轮没有未预期的前端异常',
    unexpected.size === 0,
    Array.from(unexpected)
      .map(([m, n]) => `${n}× ${m}`)
      .join(' | ')
  )
  if (knownErrors.size) {
    log('已知未修的前端异常（另计，见 §7.9）：')
    for (const [m, n] of knownErrors) log(`  ${n}× ${m}`)
  }
  await app.close()
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    console.log('\n==== 节点操作矩阵 SUMMARY ====')
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`)
    if (pageErrors.size) {
      console.log('\n---- 未捕获的前端异常（去重计数）----')
      for (const [msg, n] of pageErrors) {
        console.log(`${n}× ${msg}`)
        console.log(firstStack.get(msg))
      }
    }
    console.log(`\n${results.length - failed.length}/${results.length} passed · ${SHOT_DIR}`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.log('\n==== SUMMARY（异常中断）====')
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`)
    for (const [msg, n] of pageErrors) console.log(`${n}× 未捕获异常 ${msg}`)
    console.error('[matrix] ABORT:', e.stack || e.message)
    process.exit(2)
  })
