/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 重启后可见性真机验证：
// 1) 在隔离数据目录里预置一个「升级前保存的旧项目」（workspaceProfile 是旧快照、没有 timeline）；
// 2) 启动真实 Electron，从项目列表打开它；
// 3) 断言创建面板「视频创作」里能看到「轨道线」，并且能成功创建该节点。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function downgradeProfile(dataDir, projectId) {
  const file = path.join(dataDir, 'projects', projectId, 'project.json')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  // 模拟「升级前保存」：去掉 timeline 与节点集版本号。
  parsed.workspaceProfile = {
    schemaVersion: 1,
    presetId: 'all',
    visibleNodeTypeIds: (parsed.workspaceProfile?.visibleNodeTypeIds ?? []).filter(
      (type) => type !== 'timeline'
    )
  }
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8')
}

async function launchApp(dataDir) {
  const env = { ...process.env, CANVAS_DATA_DIR: dataDir }
  delete env.ELECTRON_RUN_AS_NODE
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-restart-verify-'))
  const projectName = '旧项目（升级前保存）'
  let projectId = ''
  const shotDir = path.join(ROOT, 'qa', `restart-verify-${Date.now()}`)
  fs.mkdirSync(shotDir, { recursive: true })

  // 阶段一：用真实入口建项目（同时写入 SQLite 行与 project.json），然后降级配置、退出。
  {
    const { app, page } = await launchApp(dataDir)
    try {
      projectId = await page.evaluate(async (name) => {
        const created = await window.api.createProject({ name })
        return created.ok ? created.data.id : ''
      }, projectName)
    } finally {
      await app.close().catch(() => undefined)
    }
  }
  if (!projectId) {
    check('预置项目创建失败', false)
    process.exitCode = 1
    return
  }
  downgradeProfile(dataDir, projectId)
  const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', projectId, 'project.json'), 'utf8'))
  check(
    '预置完成：项目配置是升级前快照（无 timeline / 无版本号）',
    !before.workspaceProfile.visibleNodeTypeIds.includes('timeline') &&
      before.workspaceProfile.nodeSetRevision === undefined
  )

  // 阶段二：重启应用，从项目列表打开旧项目。
  const { app, page } = await launchApp(dataDir)
  try {
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
    await page.getByText(projectName).first().waitFor({ timeout: 60_000 })
    await page.getByText(projectName).first().click()
    await page.locator('.node-palette').waitFor({ timeout: 60_000 })
    check('旧项目可以正常打开', true)

    await page.getByRole('button', { name: '展开视频创作节点', exact: true }).click()
    await page.waitForTimeout(300)
    const hasTrack = await page
      .getByRole('button', { name: '添加轨道线节点', exact: true })
      .isVisible()
      .catch(() => false)
    check('旧项目打开后，创建面板里能看到「轨道线」', hasTrack)
    await page.screenshot({ path: path.join(shotDir, 'palette.png') })

    if (hasTrack) {
      await page.getByRole('button', { name: '添加轨道线节点', exact: true }).click()
      const card = page.locator('.node-card-wrap:has(.type-timeline)').first()
      await card.waitFor({ timeout: 20_000 })
      const size = await card.locator('.node-card').evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }))
      check('可以从旧项目里创建轨道线节点', true, `${size.w}×${size.h}`)
      await page.screenshot({ path: path.join(shotDir, 'created.png') })

      await page.waitForTimeout(1500)
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', projectId, 'project.json'), 'utf8'))
      const savedTypes = Object.values(saved.tldrawSnapshot?.store ?? {})
        .filter((s) => s.type === 'node-card')
        .map((s) => s.props?.nodeType)
      check('保存后的项目文件包含 timeline 节点', savedTypes.includes('timeline'), JSON.stringify(savedTypes))
      check(
        '保存后的工作台配置已带节点集版本',
        typeof saved.workspaceProfile?.nodeSetRevision === 'number',
        JSON.stringify(saved.workspaceProfile?.nodeSetRevision)
      )
    }
  } catch (error) {
    check('验证脚本执行未中断', false, error instanceof Error ? error.message : String(error))
    await page.screenshot({ path: path.join(shotDir, 'error.png') }).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n截图：${shotDir}`)
  console.log(`结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    for (const item of failed) console.log(` - ${item.name}${item.detail ? `：${item.detail}` : ''}`)
    process.exitCode = 1
  }
}

void main()
