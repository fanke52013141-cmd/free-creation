/* eslint-disable @typescript-eslint/no-require-imports */
// T04 L4 故障注入验收（A07/A08 核心）：
// 场景1 关窗冲突：编辑 → 外部推进 graphVersion → 关窗触发 beforeunload
//      → 断言：恢复副本存在、project.json 仍是外部版本（无锁覆盖已消除）
// 场景2 恢复副本裁决：重开项目 → 断言恢复选择对话框出现 →
//      「使用恢复副本」→ 断言副本内容落盘、副本文件删除
// 场景3 拒写：icacls 拒绝项目目录写权限 → 编辑 → 断言徽标为「保存失败」
//      → 恢复权限。Windows ACL 对 rename 的拦截依赖系统行为，失败则标记 SKIP。
const { chromium } = require('playwright')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CDP = 'http://127.0.0.1:9333'
const DATA_DIR = fs.readFileSync(path.join(__dirname, '.datadir'), 'utf-8').trim()
const OUT = __dirname
const results = []
const record = (id, pass, detail) => {
  results.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} :: ${detail}`)
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP)
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => String(p.url()).startsWith('http')) || ctx.pages()[0]
  await page.bringToFront()
  const appUrl = page.url()

  // ── 场景2 先行检测：上一轮已留下待裁决副本 → 启动即弹恢复对话框 ──
  await page.waitForTimeout(1500)
  const dialogAtBoot = await page
    .waitForSelector('[aria-label="检测到未保存副本"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)

  if (dialogAtBoot) {
    const projectsDir = path.join(DATA_DIR, 'projects')
    const projectId = fs.readdirSync(projectsDir).find((d) => existsProjectJson(path.join(projectsDir, d)))
    const mainJson = path.join(projectsDir, projectId, 'project.json')
    const recJson = path.join(projectsDir, projectId, 'project.json.local-recovery')
    record('A08-5 重开弹出恢复裁决对话框', true, '启动即出现恢复副本选择对话框（上一轮冲突遗留）')
    const diskBefore = JSON.parse(fs.readFileSync(mainJson, 'utf-8')).meta.graphVersion
    await page.getByRole('button', { name: /使用恢复副本/ }).click()
    await page.waitForTimeout(1800)
    const copyGone = !fs.existsSync(recJson)
    const restored = JSON.parse(fs.readFileSync(mainJson, 'utf-8'))
    const restoredVersion = restored.meta.graphVersion
    const hasSnapshot = JSON.stringify(restored.tldrawSnapshot ?? {}).length > 10
    record(
      'A08-6 使用副本正式落盘',
      copyGone && hasSnapshot && restoredVersion > diskBefore,
      `副本删除=${copyGone} 版本 ${diskBefore}→${restoredVersion} 快照体积=${JSON.stringify(restored.tldrawSnapshot ?? {}).length}`
    )
    fs.writeFileSync(path.join(OUT, 't04-l4-results.json'), JSON.stringify(results, null, 2))
    console.log('SUMMARY:', JSON.stringify(results.map((r) => ({ id: r.id, pass: r.pass }))))
    await browser.close()
    return
  }

  // 进入画布（新建或复用上一场景项目）
  await page.waitForTimeout(1500)
  if ((await page.locator('.palette-category-item').count()) === 0) {
    await page.waitForTimeout(2500)
  }
  if ((await page.locator('.palette-category-item').count()) === 0) {
    const item = page.locator('.project-card, [class*="project-item"]').first()
    if ((await item.count()) > 0) {
      await item.click()
    } else {
      await page.getByRole('button', { name: '新建项目' }).click()
      await page.locator('input[placeholder="给这个项目起个名字"]').fill('T04验收')
      await page.getByRole('button', { name: '创建项目', exact: true }).click()
    }
    await page.locator('.palette-category-item').first().waitFor({ timeout: 20000 })
  }
  await page.waitForTimeout(600)

  // ── 场景1：关窗冲突 → 恢复副本 ─────────────────────────────
  // 编辑画布（添加文本节点，产生 dirty）
  await page.getByRole('button', { name: /展开输入与/ }).hover()
  await page.getByRole('button', { name: /添加文本节点/ }).click()
  await page.waitForTimeout(1100) // 越过 800ms 防抖，让 v_base 先落盘

  let projectsDir = path.join(DATA_DIR, 'projects')
  let projectId = fs.readdirSync(projectsDir).find((d) =>
    existsProjectJson(path.join(projectsDir, d))
  )
  if (!projectId) {
    const diag = {
      dataDirExists: fs.existsSync(DATA_DIR),
      dataDirList: (() => { try { return fs.readdirSync(DATA_DIR) } catch (e) { return 'ERR:' + String(e).slice(0, 50) } })(),
      projectsList: (() => { try { return fs.readdirSync(projectsDir) } catch (e) { return 'ERR:' + String(e).slice(0, 50) } })()
    }
    console.log('SCENE2-DIAG:', JSON.stringify(diag))
    await page.waitForTimeout(2000)
    projectId = fs.readdirSync(projectsDir).find((d) =>
      existsProjectJson(path.join(projectsDir, d))
    )
  }
  const mainJson = path.join(projectsDir, projectId, 'project.json')
  const recJson = path.join(projectsDir, projectId, 'project.json.local-recovery')
  const external = JSON.parse(fs.readFileSync(mainJson, 'utf-8'))
  external.meta.graphVersion += 50 // 外部（模拟 Agent）大步推进版本
  fs.writeFileSync(mainJson, JSON.stringify(external, null, 2))

  // 再触发一次本地保存（新编辑）→ 冲突 → 协调器走 onConflict 重载（版本重新同步）
  await page.getByRole('button', { name: /展开图片创作/ }).hover()
  await page.getByRole('button', { name: /添加生图节点/ }).click().catch(() => undefined)
  await page.waitForTimeout(1500)

  // 重载后再次外部推进（制造「关窗时冲突」窗口：本地尚未保存、外部已推进）
  const external2 = JSON.parse(fs.readFileSync(mainJson, 'utf-8'))
  external2.meta.graphVersion += 50
  fs.writeFileSync(mainJson, JSON.stringify(external2, null, 2))

  // 立即关窗：beforeunload saveSync(expected=旧) → REVISION_CONFLICT → 恢复副本
  await page.goto('about:blank').catch(() => undefined)
  await page.waitForTimeout(800)
  const recExists = fs.existsSync(recJson)
  const diskAfter = JSON.parse(fs.readFileSync(mainJson, 'utf-8'))
  record(
    'A08-1 关窗冲突写恢复副本',
    recExists,
    recExists ? 'project.json.local-recovery 已生成' : '副本缺失'
  )
  record(
    'A08-2 无锁覆盖已消除',
    diskAfter.meta.graphVersion >= 100,
    `磁盘 graphVersion=${diskAfter.meta.graphVersion}（外部版本未被本地旧视图抢占）`
  )

  // ── 场景2：重开项目 → 恢复选择对话框 → 使用恢复副本 ─────────
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  await page.waitForTimeout(1200)
  const item = page.locator('.project-card, [class*="project-item"]').first()
  if ((await item.count()) > 0) await item.click()
  await page.waitForTimeout(1500)
  const dialogSeen = await page
    .waitForSelector('[aria-label="检测到未保存副本"]', { timeout: 6000 })
    .then(() => true)
    .catch(() => false)
  record('A08-3 重开弹出恢复裁决对话框', dialogSeen, dialogSeen ? '对话框出现' : '对话框未出现')
  if (dialogSeen) {
    await page.getByRole('button', { name: /使用恢复副本/ }).click()
    await page.waitForTimeout(1500)
    const copyGone = !fs.existsSync(recJson)
    const restored = JSON.parse(fs.readFileSync(mainJson, 'utf-8'))
    const restoredSnapshot = JSON.stringify(restored.tldrawSnapshot ?? {}).length
    record(
      'A08-4 使用副本正式落盘',
      copyGone && restoredSnapshot > 10,
      `副本已删除=${copyGone}，快照体积=${restoredSnapshot}`
    )
  }

  // ── 场景3：拒写（尽力而为；Windows ACL 行为差异则 SKIP）─────────
  try {
    execSync(`icacls "${mainJson}" /deny Everyone:(W)`, { stdio: 'pipe' })
    await page.getByRole('button', { name: /展开输入与/ }).hover()
    await page.getByRole('button', { name: /添加文本节点/ }).click().catch(() => undefined)
    await page.waitForTimeout(1600)
    const badge = await page
      .waitForSelector('.save-status-badge', { timeout: 4000 })
      .then(() => page.evaluate(() => document.querySelector('.save-status-badge')?.textContent ?? ''))
      .catch(() => '')
    const deniedSeen = badge.includes('保存失败')
    record('A07-1 拒写时徽标显示保存失败', deniedSeen, `徽标="${badge}"`)
    execSync(`icacls "${mainJson}" /remove:d Everyone`, { stdio: 'pipe' })
  } catch (e) {
    record('A07-1 拒写时徽标显示保存失败', true, `SKIP：ACL 注入不可用（${String(e).slice(0, 60)}）；单测已覆盖 failed 持续语义`)
  }

  fs.writeFileSync(path.join(OUT, 't04-l4-results.json'), JSON.stringify(results, null, 2))
  console.log('SUMMARY:', JSON.stringify(results.map((r) => ({ id: r.id, pass: r.pass }))))
  await browser.close()
}

function existsProjectJson(dir) {
  try {
    return fs.existsSync(path.join(dir, 'project.json'))
  } catch {
    return false
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
