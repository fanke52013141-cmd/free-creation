/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 节点空态图标居中审计：在真实 Electron 里逐个创建节点，量「图标中心」相对「卡片中心」的偏移。
//
// 判定口径（2026-11-02 裁决）：纯空态（只有大图标、没有可见提示文案）的大图标必须正居中于
// 节点卡片几何中心。偏移超过 ±3px 视为不居中。
//
// 运行：node scripts/audit-node-identity-centering.cjs
// 截图：qa/node-identity-centering-<时间戳>/
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const TOLERANCE = 3

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-identity-audit-'))
  const shotDir = path.join(ROOT, 'qa', `node-identity-centering-${Date.now()}`)
  fs.mkdirSync(shotDir, { recursive: true })
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

  const created = []
  try {
    await page.getByRole('button', { name: '新建项目' }).first().click()
    await page.locator('input[placeholder="给这个项目起个名字"]').fill('图标居中审计')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.node-palette').waitFor({ timeout: 60_000 })

    // 审计期间关掉过渡动画：抽屉每次展开/收起都在动画中，Playwright 的可见性判定会抖。
    await page.addStyleTag({
      content: '*,*::before,*::after{transition:none!important;animation:none!important}'
    })
    await page.locator('.node-palette').waitFor({ timeout: 60_000 })

    const categoryLabels = await page
      .locator('.palette-category-item')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')).filter(Boolean))

    // 先收集每个分类下的节点按钮标签，再逐个创建：抽屉在创建后会收起，边收边找会打架。
    const plan = []
    for (const categoryLabel of categoryLabels) {
      const expander = page.getByRole('button', { name: categoryLabel, exact: true })
      if ((await expander.getAttribute('aria-expanded')) !== 'true') {
        await expander.click()
        await page.waitForTimeout(120)
      }
      const labels = await page
        .locator('button[aria-label^="添加"][aria-label$="节点"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
      for (const label of labels) {
        if (label && !plan.some((item) => item.label === label)) plan.push({ categoryLabel, label })
      }
    }
    console.log(`计划创建 ${plan.length} 个节点`)

    for (const { categoryLabel, label } of plan) {
      const expander = page.getByRole('button', { name: categoryLabel, exact: true })
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if ((await expander.getAttribute('aria-expanded')) !== 'true') {
          await expander.click().catch(() => undefined)
          await page.waitForTimeout(120)
        }
        const button = page.getByRole('button', { name: label, exact: true })
        if (!(await button.isVisible().catch(() => false))) continue
        await button.click({ timeout: 4000 }).catch(() => undefined)
        await page.waitForTimeout(200)
        break
      }
      created.push(label)
      await page.keyboard.press('Escape').catch(() => undefined)
      await page.waitForTimeout(80)
    }

    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    const measurement = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.node-card-wrap'))
      return cards.map((wrap) => {
        const card = wrap.querySelector('.node-card')
        const typeClass = Array.from(card?.classList || []).find((c) => c.startsWith('type-'))
        const identity = card?.querySelector('.node-standard-identity')
        const icon = identity?.querySelector('.node-standard-identity-icon')
        const title = wrap.querySelector('.node-title')?.textContent?.trim() || ''
        if (!card || !icon) return { type: typeClass || '?', title, hasIdentity: Boolean(identity) }
        // 除图标外是否还有“看得见”的内容（display:none 的 <small> 不算）。
        const visibleOthers = identity
          ? Array.from(identity.children).filter((child) => {
              if (child === icon) return false
              const style = getComputedStyle(child)
              if (style.display === 'none' || style.visibility === 'hidden') return false
              const rect = child.getBoundingClientRect()
              return rect.width > 0 && rect.height > 0
            })
          : []
        const cardRect = card.getBoundingClientRect()
        const iconRect = icon.getBoundingClientRect()
        return {
          type: typeClass || '?',
          title,
          hasIdentity: Boolean(identity),
          pure: visibleOthers.length === 0,
          visibleOthers: visibleOthers.length,
          dx: Number((iconRect.x + iconRect.width / 2 - (cardRect.x + cardRect.width / 2)).toFixed(1)),
          dy: Number((iconRect.y + iconRect.height / 2 - (cardRect.y + cardRect.height / 2)).toFixed(1)),
          card: `${Math.round(cardRect.width)}x${Math.round(cardRect.height)}`,
          iconPosition: getComputedStyle(icon).position,
          pureNoHas: identity.matches(':not(:has(> :not(.node-standard-identity-icon)))'),
          hiddenChildren: Array.from(identity.children)
            .filter((child) => child !== icon)
            .map((child) => `${child.tagName}.${String(child.className).slice(0, 18)}:${getComputedStyle(child).display}`)
        }
      })
    })

    await page.screenshot({ path: path.join(shotDir, 'all-nodes.png') })

    const pure = measurement.filter((item) => item.hasIdentity && item.pure)
    const withContent = measurement.filter((item) => item.hasIdentity && !item.pure)
    const offenders = pure.filter(
      (item) => Math.abs(item.dx) > TOLERANCE || Math.abs(item.dy) > TOLERANCE
    )

    console.log(`创建节点数: ${measurement.length}`)
    console.log(`\n纯空态（只有大图标）节点 ${pure.length} 个：`)
    for (const item of pure) {
      const flag = Math.abs(item.dx) > TOLERANCE || Math.abs(item.dy) > TOLERANCE ? '  ✗ 偏心' : ''
      console.log(
        `  ${item.type.padEnd(18)} dx=${String(item.dx).padStart(6)} dy=${String(item.dy).padStart(6)} icon=${item.iconPosition.padEnd(8)} hasRule=${item.pureNoHas}${flag}`
      )
      if (item.hiddenChildren.length) console.log(`      隐藏子项: ${item.hiddenChildren.join(', ')}`)
    }
    console.log(`\n空态但有可见提示内容（不要求图标居中）${withContent.length} 个：`)
    for (const item of withContent) {
      console.log(`  ${item.type.padEnd(18)} 可见子项=${item.visibleOthers}`)
    }
    console.log(`\n偏心（|dx|>${TOLERANCE} 或 |dy|>${TOLERANCE}）: ${offenders.length} 个`)
    for (const item of offenders) {
      console.log(`  ✗ ${item.type} dx=${item.dx} dy=${item.dy}`)
    }
    console.log(`\n截图：${shotDir}`)
    if (offenders.length > 0) process.exitCode = 1
  } catch (error) {
    console.log('AUDIT ERROR:', error && error.message)
    process.exitCode = 1
  } finally {
    await app.close().catch(() => undefined)
  }
}

void main()
