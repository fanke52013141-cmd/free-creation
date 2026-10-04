/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-opt-electron-'))
  const out = path.resolve('qa/optimization-electron')
  fs.mkdirSync(out, { recursive: true })
  const env = {
    ...process.env,
    CANVAS_DATA_DIR: root,
    ELECTRON_RENDERER_URL: 'http://127.0.0.1:5191',
    NODE_ENV: 'development'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () => electron.launch({ args: ['.'], env, timeout: 60000 })
  let app
  const checks = []
  try {
    app = await launch()
    let page = await app.firstWindow()
    await page.waitForFunction(() => !!window.api)
    const project = await page.evaluate(
      async () => (await window.api.createProject({ name: 'Electron 独立验收' })).data
    )
    const file = path.join(root, 'projects', project.id, 'project.json')
    const original = fs.readFileSync(file, 'utf8')
    fs.mkdirSync(file + '.tmp')
    const failed = await page.evaluate(
      async (id) =>
        window.api.saveProject({
          id,
          tldrawSnapshot: { bad: 'must not save' },
          expectedGraphVersion: 0
        }),
      project.id
    )
    assert.equal(failed.ok, false)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    fs.rmdirSync(file + '.tmp')
    checks.push('真实主进程拒写保留原文件并返回失败')
    const media = await page.evaluate(async (id) => {
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
        ),
        (c) => c.charCodeAt(0)
      )
      const result = await window.api.importMediaBuffer({
        projectId: id,
        data: bytes,
        mime: 'image/png',
        name: '来源验收.png'
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    }, project.id)
    await page.evaluate(
      async ({ project, media }) => {
        const result = await window.api.saveArtifactRecipe({
          projectId: project.id,
          mediaId: media.id,
          runId: 'run-13',
          producerNodeId: 'shape:deleted-producer',
          nodeType: 'image-gen',
          contractVersion: 3,
          fullPrompt: '重启后仍保留的完整正文',
          paramsJson: '{"seed":13,"apiKey":"never-persist"}',
          inputMediaIds: [],
          createdAt: Date.now()
        })
        if (!result.ok) throw new Error(result.error.message)
        const cloned = await window.api.cloneProject({ sourceId: project.id, name: '来源副本' })
        if (!cloned.ok) throw new Error(cloned.error.message)
        const cloneMedia = await window.api.listMedia(cloned.data.id)
        if (!cloneMedia.ok || !cloneMedia.data.length) throw new Error('clone media missing')
        const cloneRecipe = await window.api.getArtifactRecipe({
          projectId: cloned.data.id,
          mediaId: cloneMedia.data[0].id
        })
        if (!cloneRecipe.ok || cloneRecipe.data?.fullPrompt !== '重启后仍保留的完整正文')
          throw new Error('clone recipe missing')
        const library = await window.api.captureLibraryMedia({
          projectId: project.id,
          mediaId: media.id,
          title: '来源资源'
        })
        if (!library.ok) throw new Error(library.error.message)
        const target = await window.api.createProject({ name: '资源加入目标' })
        const inserted = await window.api.materializeLibraryResource({
          projectId: target.data.id,
          resourceId: library.data.id,
          revisionId: library.data.selectedRevisionId,
          componentIds: library.data.components.map((c) => c.id)
        })
        if (!inserted.ok) throw new Error(inserted.error.message)
        const copied = await window.api.getArtifactRecipe({
          projectId: target.data.id,
          mediaId: inserted.data.assets[0].id
        })
        if (!copied.ok || copied.data?.fullPrompt !== '重启后仍保留的完整正文')
          throw new Error('library recipe missing')
        const deleted = await window.api.deleteProject(project.id)
        if (!deleted.ok || !deleted.data) throw new Error('delete failed')
      },
      { project, media }
    )
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForFunction(() => !!window.api)
    const result = await page.evaluate(
      async ({ project, media }) => {
        const deleted = await window.api.listDeletedProjects()
        const restored = await window.api.restoreDeletedProject(project.id)
        const recipe = await window.api.getArtifactRecipe({
          projectId: project.id,
          mediaId: media.id
        })
        const reopened = await window.api.openProject(project.id)
        return { deleted, restored, recipe, reopened }
      },
      { project, media }
    )
    assert(result.deleted.ok && result.deleted.data.some((p) => p.id === project.id))
    assert(result.restored.ok && result.restored.data.id === project.id)
    assert(result.reopened.ok && result.reopened.data.meta.graphVersion === 0)
    assert(result.recipe.ok && result.recipe.data.fullPrompt === '重启后仍保留的完整正文')
    assert(!result.recipe.data.paramsJson.includes('never-persist'))
    await page.evaluate(
      async (project) =>
        (await import('/src/stores/app.ts')).useAppStore.getState().openProject(project),
      project
    )
    await page.waitForSelector('.palette-category-item')
    await page.evaluate(async (id) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.createShape({
        id: 'shape:restore-target',
        type: 'node-card',
        x: 200,
        y: 200,
        props: { nodeType: 'text', title: '恢复目标', text: '固定正文' }
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      await (
        await import('/src/stores/history-snapshots.ts')
      ).useHistorySnapshots
        .getState()
        .add(id, editor.store.getStoreSnapshot(), 1, '真实安全恢复')
      editor.createShape({
        id: 'shape:restore-extra',
        type: 'node-card',
        x: 600,
        y: 200,
        props: { nodeType: 'text', title: '新增', text: '新内容' }
      })
    }, project.id)
    await page.getByRole('button', { name: '打开历史记录', exact: true }).click()
    await page.getByRole('button', { name: '回溯到此版本', exact: true }).first().click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.locator('.node-card-wrap').count(), 2)
    await page.getByRole('button', { name: '回溯到此版本', exact: true }).first().click()
    await page.getByRole('button', { name: '备份并恢复', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.node-card-wrap').length === 1)
    const snapshots = await page.evaluate(
      async (id) => window.api.workspace.listSnapshots(id),
      project.id
    )
    assert(snapshots.ok && snapshots.data.length === 2)
    checks.push('真实历史恢复 UI 取消保留画布；确认先写检查点再恢复')
    await page.screenshot({ path: path.join(out, 'restore.png') })
    const indexed = await page.evaluate(async (id) => window.api.listMedia(id), project.id)
    const mediaPath = path.join(root, indexed.data.find((asset) => asset.id === media.id).path)
    fs.renameSync(mediaPath, mediaPath + '.missing-test')
    const preflight = await page.evaluate(
      async (id) => window.api.checkProjectMediaFiles(id),
      project.id
    )
    assert(preflight.ok && preflight.data.missingMediaIds.includes(media.id))
    fs.renameSync(mediaPath + '.missing-test', mediaPath)
    checks.push('物理媒体丢失预检命中；索引记录保留')
    checks.push('真实项目复制和资源库物化传播独立来源')
    checks.push('真实 Electron 重启后最近删除和媒体来源仍在，恢复引用与版本保留，凭据过滤')
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify(
        {
          passed: true,
          checks,
          dataDir: root,
          boundary: '合成媒体来源验证本地落盘；未调用付费模型'
        },
        null,
        2
      )
    )
  } finally {
    if (app) await app.close()
  }
})().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
