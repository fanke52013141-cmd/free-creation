/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5191')
    await page.locator('.node-palette').waitFor()
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      for (const [index, version] of [2, 1].entries()) editor.createShape({
        id: `shape:clay-${version}`, type: 'node-card', x: 240 + index * 400, y: 140,
        props: { nodeType: 'video-clay', title: version === 2 ? '新版白模' : '历史白模',
          config: version === 1 ? JSON.stringify({ version: 1, maxResolution: 512, reliefStrength: 3 })
            : JSON.stringify({ version: 2 }) }
      })
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    })
    const modern = page.locator('[data-node-id="shape:clay-2"]')
    const legacy = page.locator('[data-node-id="shape:clay-1"]')
    await modern.locator('label', { hasText: '白模效果' }).getByRole('combobox').click()
    await page.getByRole('option', { name: '立体白模', exact: true }).click()
    await modern.locator('label', { hasText: '质量' }).getByRole('combobox').click()
    await page.getByRole('option', { name: '精细', exact: true }).click()
    const read = () => page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return [2, 1].map(version => JSON.parse(editor.getShape(`shape:clay-${version}`).props.config))
    })
    const configured = await read()
    assert.equal(configured[0].version, 2)
    assert.equal(configured[0].preset, 'studio')
    assert.equal(configured[0].quality, 'fine')
    assert.equal(configured[0].maxResolution, 1024)
    assert.equal(configured[0].shadowStrength, 0.5)
    assert.equal(configured[1].version, 1, 'opening canvas must not upgrade old projects')
    await legacy.getByRole('button', { name: '升级白模效果' }).click()
    assert.equal((await read())[1].version, 2)
    assert.equal((await read())[1].reliefStrength, 3, 'explicit upgrade retains chosen parameters')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const snapshot = editor.store.getStoreSnapshot('document')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.store.loadStoreSnapshot(snapshot)
    })
    assert.deepEqual((await read())[0], configured[0], 'all settings survive snapshot restoration')
    await page.screenshot({ path: 'artifacts/clay-optimization-2026-10-06/settings.png' })
    await modern.locator('.node-info-btn').click()
    const panel = page.locator('.node-contract-panel')
    await panel.getByRole('tab', { name: '设置', exact: true }).click()
    await panel.getByRole('button', { name: '恢复默认设置', exact: true }).click()
    const reset = (await read())[0]
    assert.equal(reset.version, 2)
    assert.equal(reset.preset, 'soft')
    assert.equal(reset.quality, 'standard')
    assert.equal(reset.maxResolution, 768)
    assert.equal(reset.reliefStrength, 1.5)
    assert.equal(reset.temporalStability, 0.6)
    await page.screenshot({ path: 'artifacts/clay-optimization-2026-10-06/settings-panel.png' })
    console.log('PASS clay presets, quality, explicit legacy upgrade, snapshot restore and reset defaults')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
