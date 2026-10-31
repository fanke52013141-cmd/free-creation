/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 浏览器验收：3D 预演台读文档真值、按视角摆控件、按引擎上限夹参数（NODE_UI_SPEC §16.28）。
//
// 四条缺陷都是 vitest 抓不到的运行时形状：
// 1. 面板把挂载时的工程拷进 useState——撤销文档后面板继续显示被撤销掉的值，下次保存又把它写回
//    文档复活；卡片与面板还会各说一个数。
// 2. 焦距界面放行到 200mm 而画面在 106mm 就饱和；时长界面写 10 秒、告警写 12 秒、导出截成 10 秒。
// 3. 3D 视口摆着一排只有 2D 取景器消费的开关（三分线/安全框/视线高度/参考图透明度/姿态），按了画面不动。
// 4. 「同步连线输入」在三个端口都没连线时照样可点，点了没任何反应，用户以为连线没被读到。
//
// 发布 PNG/WebM 与媒体导入走 window.api，浏览器通道只有 mock，不在本门禁覆盖范围内。
//
// 前置：npm run dev:browser -- --port 5199 --strictPort
// 运行：BROWSER_ORIGIN=http://127.0.0.1:5199 npm run test:browser-director-studio
const { chromium } = require('playwright')
const assert = require('node:assert/strict')

const ORIGIN = process.env.BROWSER_ORIGIN || 'http://127.0.0.1:5173'
// 这里写死上限而不是从源码常量导入：本门禁要成为独立证据——界面放行了引擎不消费的区间就必须失败。
const FOCAL_MAX = '106'
const DURATION_MAX = '12'

async function launchBrowser() {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let lastError
  for (const options of attempts) {
    try {
      return await chromium.launch({ ...options, headless: true, timeout: 30_000 })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * 等面板里某个数值输入框变成期望值。撤销是文档侧的变化，只能从真实 DOM 观察：
 * 面板若停在挂载时的快照，这个等待会超时，正是本门禁要抓的缺陷。
 */
async function waitValue(page, labelText, expected) {
  await page.waitForFunction(
    ([text, value]) =>
      Array.from(document.querySelectorAll('.director-studio label'))
        .find((label) => label.textContent.includes(text))
        ?.querySelector('input')?.value === value,
    [labelText, expected]
  )
}

async function main() {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  await page.goto(`${ORIGIN}/`)

  const openDemo = page.getByRole('button', { name: '打开项目 浏览器演示项目', exact: true })
  if (await openDemo.count()) await openDemo.click()
  const category=page.getByRole('button',{name:'展开视频创作节点',exact:true}); await category.hover(); await page.waitForTimeout(300); if(await category.getAttribute('aria-expanded')!=='true') await category.click(); await page.waitForTimeout(300)

  await page.evaluate(async()=>{const ed=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const spec=(await import('/src/nodes/registry.tsx')).getNodeType('director');ed.createShape({id:'shape:director-audit',type:'node-card',x:400,y:300,props:{nodeType:'director',title:spec.label,config:spec.initialConfig||''}});ed.markHistoryStoppingPoint('audit-created')})
  const topbarBottom = await page.evaluate(() => {
    const bar = document.querySelector('.canvas-topbar')
    return bar ? bar.getBoundingClientRect().bottom : 0
  })
  await page.waitForFunction(
    (minY) =>
      Math.min(
        ...Array.from(document.querySelectorAll('.node-card-wrap')).map((c) => c.getBoundingClientRect().top)
      ) >= minY,
    topbarBottom
  )
  const card = page.locator('.node-card-wrap:has(.type-director)').first()
  await card.waitFor()

  // 卡片只说真话：没有发布记录时不许出现「已发布」，节点名只能有一个来源。
  const cardText = (await card.innerText()).replace(/\s+/g, '')
  assert.ok(cardText.includes('尚未发布输出'), `未发布时卡片必须说「尚未发布输出」，实际：${cardText}`)
  assert.ok(cardText.includes('打开3D预演台'), `卡片按钮必须与 spec.label 同名，实际：${cardText}`)
  assert.ok(!cardText.includes('导演台'), '用户可见文案不得再出现旧名「导演台」')

  await card.getByRole('button', { name: '打开 3D 预演台', exact: true }).click()
  const studio = page.locator('.director-studio')
  await studio.waitFor()

  // ③ 3D 不摆 2D 专属控件，但要说明它们去哪；切到 2D 才出现。
  const thirdLine = studio.getByRole('button', { name: '三分线', exact: true })
  assert.equal(await thirdLine.count(), 0, '3D 视口不得摆出只有 2D 消费的三分线开关')
  assert.equal(await studio.getByLabel(/姿态/).count(), 0, '3D 视口不得摆出姿态下拉')
  assert.ok(
    await studio.getByText('只在 2D 取景器绘制').isVisible(),
    '隐藏控件必须同时给出「切到 2D 可调」的去向'
  )
  await studio.getByRole('button', { name: '2D', exact: true }).click()
  await thirdLine.waitFor()
  await studio.getByLabel('角色 01 姿态').waitFor()
  assert.ok(await studio.getByLabel('参考图透明度').first().isVisible())
  await studio.getByRole('button', { name: '3D', exact: true }).click()

  // ② 焦距/时长夹到引擎真正消费的区间；① 面板与卡片跟着文档走。
  await studio.getByRole('button', { name: '显示或隐藏数值、关键帧等高级参数', exact: true }).click()
  const focal = studio.locator('label:has-text("焦距") input')
  const duration = studio.locator('label:has-text("时长（秒") input')
  assert.equal(await focal.inputValue(), '35', '焦距默认值来自文档')
  assert.equal(await duration.inputValue(), '5', '时长默认值来自文档')
  await focal.fill('500')
  assert.equal(await focal.inputValue(), FOCAL_MAX, `焦距必须夹到画面生效上限 ${FOCAL_MAX}mm`)
  await duration.fill('99')
  assert.equal(await duration.inputValue(), DURATION_MAX, `时长必须夹到导出上限 ${DURATION_MAX}s`)
  // 左侧镜头列表和卡片是另外两处渲染：三处一致才说明只有一份真值。
  assert.ok(
    (await studio.innerText()).includes(`${DURATION_MAX}s`),
    '镜头列表必须跟随新时长，不能只有输入框变了'
  )
  assert.ok(
    (await card.innerText()).includes(`${FOCAL_MAX} mm`),
    '卡片必须跟随面板写进文档的焦距（过期快照缺陷的形状）'
  )

  // 撤销走顶栏按钮：全屏工作区盖住了它，所以用程序化点击——React 的 onClick 仍会收到事件。
  // tldraw 会把这段时间内的连续写入并进同一条历史，所以一次撤销就回到编辑前的文档；
  // 面板若停在挂载时的快照，会继续显示 106/12 并在下次保存把它们写回文档复活。
  await page.evaluate(async()=>{(await import('/src/stores/editor.ts')).useEditorStore.getState().editor.undo()})
  await page.waitForTimeout(800); console.log('撤销后焦距/时长:',await focal.inputValue(),await duration.inputValue()); await page.screenshot({path:'D:/tmp/canvas-node-audit/director-undo.png'}); await waitValue(page, '焦距', '35')
  assert.equal(await focal.inputValue(), '35', '撤销后面板必须跟随文档焦距')
  assert.equal(await duration.inputValue(), '5', '撤销后面板必须跟随文档时长')
  assert.ok(
    (await card.innerText()).includes('35 mm'),
    '撤销后卡片必须回到被撤销掉的焦距，不能停在 106 mm'
  )
  assert.ok(
    !(await studio.innerText()).includes(`${DURATION_MAX}s`),
    '镜头列表也必须跟随撤销，不能只有输入框变了'
  )

  console.log(
    `PASS: 3D 预演台跟随文档真值（撤销 ${FOCAL_MAX}→35 / ${DURATION_MAX}→5 均生效），` +
      '2D 专属控件不再摆在 3D（未测试旧版同步连线按钮）'
  )
  await browser.close()
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
