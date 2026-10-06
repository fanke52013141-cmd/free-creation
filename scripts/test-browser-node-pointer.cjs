/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const out = path.resolve('artifacts/node-pointer-2026-10-06')
  fs.mkdirSync(out, { recursive: true })
  const findings = []
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.locator('.node-palette').waitFor()
    const allTypes = await page.evaluate(async () => Object.values((await import('/src/canvas/palette-categories.ts')).PALETTE_NODE_GROUPS).flat())
    const types = process.env.NODE_POINTER_TYPES ? allTypes.filter(type => process.env.NODE_POINTER_TYPES.split(',').includes(type)) : allTypes
    async function create(type, text = '') {
      await page.evaluate(async ({ type, text }) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        editor.setEditingShape(null)
        editor.deleteShapes([...editor.getCurrentPageShapeIds()])
        await new Promise(resolve => requestAnimationFrame(resolve))
        editor.createShape({ id: 'shape:pointer-audit', type: 'node-card', x: 340, y: 150, props: { nodeType: type, text } })
        editor.selectNone()
        editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      }, { type, text })
      await page.waitForTimeout(120)
    }
    async function state() {
      return page.evaluate(async () => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const shape = editor.getShape('shape:pointer-audit')
        return { selected: editor.getSelectedShapeIds(), x: shape.x, y: shape.y }
      })
    }
    async function exercise(point, label) {
      await page.evaluate(async () => { (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.selectNone() })
      await page.mouse.click(point.x, point.y)
      assert.ok((await state()).selected.includes('shape:pointer-audit'), `${label}: click selects`)
      const before = await state()
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      await page.mouse.move(point.x + 42, point.y + 28, { steps: 8 })
      await page.mouse.up()
      const after = await state()
      assert.ok(after.x > before.x + 25 && after.y > before.y + 15, `${label}: drag moves ${JSON.stringify({ before, after })}`)
    }
    for (const type of types) {
      await create(type)
      const points = await page.locator('.node-body').evaluate(body => {
        const candidates = [body, ...body.querySelectorAll('.node-standard-identity, .node-standard-identity-icon, .node-standard-identity strong, label > span, label.opt-label, .tts-section-label, .processor-output > span, .gen-panel-title, .structured-preview')]
        const points = candidates.flatMap(element => {
          const rect = element.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return []
          const x = element === body ? rect.x + 18 : rect.x + rect.width / 2
          const y = element === body ? rect.y + 18 : rect.y + rect.height / 2
          if (y > 820 || y < 40) return []
          const hit = document.elementFromPoint(x, y)
          if (!body.contains(hit) || hit.closest('button, input, textarea, select, [role="combobox"], a')) return []
          return [{ x, y, label: element.className || element.tagName }]
        })
        if (!points.length) {
          const rect = body.getBoundingClientRect()
          for (const [x, y] of [[rect.x + 3, rect.y + 3], [rect.right - 3, rect.y + 30], [rect.x + 3, rect.y + 80]]) {
            const hit = document.elementFromPoint(x, y)
            if (body.contains(hit) && !hit.closest('button, input, textarea, select, [role="combobox"], a')) {
              points.push({ x, y, label: 'body-padding' })
              break
            }
          }
        }
        return points
      })
      assert.ok(points.length, `${type}: at least one non-control region must be tested`)
      for (const point of points) {
        await create(type)
        await exercise(point, `${type}/${point.label}`)
      }
      findings.push({ type, regions: points.length, passed: true })
      console.log(`Regions passed: ${type} (${points.length})`)
    }
    for (const type of ['json', 'structured']) {
      for (const text of ['', '{"description":"人物走进书房","duration":5}']) {
        await create(type, text)
        const region = page.locator(type === 'json' ? (text ? '.json-preview' : '.json-body .node-hint') : '.structured-preview')
        const rect = await region.boundingBox()
        await exercise({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, `${type}/content`)
        await create(type, text)
        await page.locator(type === 'json' ? (text ? '.json-preview' : '.json-body .node-hint') : '.structured-preview').dblclick()
        await page.locator('.node-body textarea').waitFor()
        console.log(`Double-click passed: ${type}, content=${Boolean(text)}`)
        await page.keyboard.press('Escape')
      }
    }
    for (const type of types) {
      await create(type)
      const count = await page.locator('.node-body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), .node-body textarea').count()
      let tested = 0
      for (let index = 0; index < count; index++) {
        await create(type)
        const field = page.locator('.node-body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), .node-body textarea').nth(index)
        if (!await field.isVisible() || !await field.isEnabled() || await field.getAttribute('readonly') !== null) continue
        await field.scrollIntoViewIfNeeded()
        await field.click()
        assert.equal(await field.evaluate(element => document.activeElement === element), false, `${type}/${index}: single click must not edit`)
        await create(type)
        const dragField = page.locator('.node-body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), .node-body textarea').nth(index)
        await dragField.scrollIntoViewIfNeeded()
        const rect = await dragField.boundingBox()
        await exercise({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, `${type}/input-${index}`)
        await create(type)
        const editable = page.locator('.node-body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), .node-body textarea').nth(index)
        await editable.dblclick()
        await page.waitForFunction(index => {
          const fields = document.querySelectorAll('.node-body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), .node-body textarea')
          return document.activeElement === fields[index]
        }, index)
        const inputValue = await editable.getAttribute('type') === 'number' ? '2' : 'qa_value'
        await editable.fill(inputValue)
        assert.equal(await editable.inputValue(), inputValue, `${type}/${index}: editing accepts input`)
        await page.keyboard.press('Escape')
        await page.waitForFunction(index => document.activeElement !== document.querySelectorAll('.node-body input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), .node-body textarea')[index], index)
        tested++
      }
      findings.find(item => item.type === type).inputFields = tested
      console.log(`Input fields passed: ${type} (${tested}/${count})`)
    }
    for (const selector of ['.audio-asset-icon-wrap', '.audio-asset-name']) {
      async function createAudio() {
        await create('audio')
        await page.evaluate(async () => {
          const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
          editor.updateShape({ id: 'shape:pointer-audit', type: 'node-card', props: {
            title: '音频引用验收', mediaId: 'pointer-audio', mediaMime: 'audio/wav',
            mediaPath: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
          } })
        })
        await page.locator('.audio-asset-name').waitFor()
      }
      await createAudio()
      const rect = await page.locator(selector).boundingBox()
      await exercise({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, `audio/${selector}`)
      await createAudio()
      await page.locator(selector).dblclick()
      await page.locator('.media-preview-audio').waitFor()
      await page.keyboard.press('Escape')
    }
    console.log('Loaded audio icon/name select, drag and double-click preview passed')
    await create('json')
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.createShape({ id: 'shape:pointer-second', type: 'node-card', x: 790, y: 150, props: { nodeType: 'json' } })
    })
    await page.locator('[data-node-id="shape:pointer-audit"] .node-standard-identity-icon').click()
    await page.keyboard.down('Shift')
    await page.locator('[data-node-id="shape:pointer-second"] .node-standard-identity-icon').click()
    await page.keyboard.up('Shift')
    assert.equal((await state()).selected.length, 2, 'Shift on identity keeps multi-selection')
    await create('json')
    const icon = await page.locator('.node-standard-identity-icon').boundingBox()
    const origin = await state()
    await exercise({ x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 }, 'json/undo')
    await page.evaluate(async () => { (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.undo() })
    assert.equal((await state()).x, origin.x, 'undo restores drag position')
    assert.equal((await state()).y, origin.y, 'undo restores drag position')
    console.log('Multi-select and drag undo passed')
    await create('processor')
    await page.getByRole('combobox', { name: '数据类型', exact: true }).click()
    await page.getByRole('option', { name: '文本', exact: true }).click()
    assert.ok((await state()).selected.includes('shape:pointer-audit'))
    await page.screenshot({ path: path.join(out, 'processor.png') })
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: true, findings }, null, 2))
    console.log(`PASS ${types.length} nodes: body/icon/name/field labels select and drag; inputs single-click select, double-click edit; JSON/structured double-click; dropdown preserved`)
  } catch (error) {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: false, findings, error: error.message }, null, 2))
    throw error
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
