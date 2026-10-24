/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { qaOutputPath } = require('./qa-output.cjs')
const { launchQaBrowser } = require('./qa-browser.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const evidence = path.resolve(
  qaOutputPath('qa/agent-comprehensive/run-20261018-cfg07-tab-navigation-v1')
)
const tabSelector =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
const defaultConfigs = {
  agent: {
    schemaVersion: 1,
    role: 'specialist',
    interactionMode: 'collaborative',
    skills: [],
    tools: [],
    allowedNodeIds: [],
    maxSteps: 12,
    relations: []
  },
  'ai-review': {
    schemaVersion: 1,
    rulesVersion: 'rules-1',
    rejectPolicy: 'rework',
    maxReworks: 3,
    subjectSources: [],
    gatedNodeIds: [],
    relations: []
  },
  'state-machine': {
    schemaVersion: 1,
    initialState: 'draft',
    states: ['draft', 'working', 'reviewing', 'completed', 'stopped'],
    transitions: [],
    relations: []
  }
}

;(async () => {
  const browser = await launchQaBrowser()
  fs.mkdirSync(evidence, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const findings = []
  try {
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5194')
    await page.locator('.node-palette').waitFor()

    async function create(type) {
      const id = `shape:cfg07-tab-${type}`
      await page.evaluate(async ({ id, type, defaultConfig }) => {
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        editor.setEditingShape(null)
        editor.deleteShapes([...editor.getCurrentPageShapeIds()])
        await new Promise((resolve) => requestAnimationFrame(resolve))
        editor.createShape({
          id,
          type: 'node-card',
          x: 340,
          y: 150,
          props: { nodeType: type, text: '', config: JSON.stringify(defaultConfig) }
        })
        editor.selectNone()
        editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      }, { id, type, defaultConfig: defaultConfigs[type] })
      const infoButton = page.locator(
        `[data-node-id="${id}"] .node-info-btn[aria-label="打开节点说明"]`
      )
      await infoButton.waitFor()
      await infoButton.focus()
      await page.keyboard.press('Enter')
      await page.locator('.node-contract-panel').waitFor()
      const settingsTab = page.getByRole('tab', { name: '设置', exact: true })
      await settingsTab.focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(() =>
        document.querySelector('[role="tab"][aria-controls="contract-tabpanel-settings"]')?.getAttribute('aria-selected') === 'true'
      )
      await page.locator(`[data-node-id="${id}"] .node-body`).waitFor()
      await page.waitForTimeout(150)
    }

    async function auditTabOrder(rootSelector, label) {
      const descriptors = await page.evaluate(({ rootSelector, tabSelector }) => {
        const root = document.querySelector(rootSelector)
        if (!root) throw new Error(`${rootSelector}: root missing`)
        return [...root.querySelectorAll(tabSelector)]
          .filter((element) => {
            const style = getComputedStyle(element)
            return (
              element.tabIndex >= 0 &&
              !element.disabled &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              element.getClientRects().length > 0 &&
              !element.closest('[aria-hidden="true"]')
            )
          })
          .map((element, index) => {
            element.setAttribute('data-cfg07-tab-audit', String(index))
            const labelText =
              element.getAttribute('aria-label') ||
              [...(element.labels ?? [])].map((item) => item.innerText).join(' ').trim() ||
              element.innerText?.trim() ||
              element.getAttribute('name') ||
              element.tagName.toLowerCase()
            return { index, tag: element.tagName.toLowerCase(), label: labelText.slice(0, 100) }
          })
      }, { rootSelector, tabSelector })

      assert.ok(await page.locator(rootSelector).count(), `${label}: root exists`)
      if (!descriptors.length) return []
      const focus = (index) => page.locator(`[data-cfg07-tab-audit="${index}"]`).focus()
      const expectFocus = async (index, direction) => {
        const actual = await page.evaluate(() =>
          document.activeElement?.getAttribute('data-cfg07-tab-audit') ?? null
        )
        assert.equal(actual, String(index), `${label}: ${direction} focus index ${index}, got ${actual}`)
      }

      await focus(0)
      await expectFocus(0, 'initial')
      for (let index = 1; index < descriptors.length; index++) {
        await page.keyboard.press('Tab')
        await expectFocus(index, 'Tab')
      }
      for (let index = descriptors.length - 2; index >= 0; index--) {
        await page.keyboard.press('Shift+Tab')
        await expectFocus(index, 'Shift+Tab')
      }
      await page.evaluate(() => {
        document.querySelectorAll('[data-cfg07-tab-audit]').forEach((element) =>
          element.removeAttribute('data-cfg07-tab-audit')
        )
      })
      return descriptors
    }

    for (const type of ['agent', 'ai-review', 'state-machine']) {
      await create(type)
      const bodySelector = '.node-body'
      const bodyControls = await auditTabOrder(bodySelector, `${type} node body`)
      const actionBarControls = await auditTabOrder(
        '.node-standard-action-bar',
        `${type} node action bar`
      )
      const settingsControls = await auditTabOrder(
        '#contract-tabpanel-settings',
        `${type} settings`
      )
      await page.screenshot({ path: path.join(evidence, `${type}-settings.png`) })
      findings.push({
        type,
        bodyTabStops: bodyControls.length,
        actionBarTabStops: actionBarControls.length,
        settingsTabStops: settingsControls.length,
        infoButtonKeyboardOpen: true,
        settingsTabKeyboardActivation: true,
        bodyOrder: bodyControls,
        settingsOrder: settingsControls,
        tabAndShiftTabReversible: true
      })
      console.log(
        `CFG-07 ${type}: keyboard info open/settings-tab activation and Tab/Shift+Tab across ${bodyControls.length} body, ${actionBarControls.length} action-bar and ${settingsControls.length} settings controls passed.`
      )
    }

    await create('agent')
    const role = page.getByRole('combobox', { name: '职责', exact: true })
    const roleBefore = await role.innerText()
    await role.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('listbox').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('listbox').waitFor({ state: 'detached' })
    assert.equal(await role.innerText(), roleBefore, 'Escape closes role dropdown without changing value')
    assert.equal(
      await role.evaluate((element) => document.activeElement === element),
      true,
      'Escape returns focus to role dropdown'
    )
    await role.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('listbox').waitFor()
    await page.keyboard.press('ArrowUp')
    await page.waitForFunction((previous) => {
      const active = document.activeElement
      return (
        active?.getAttribute('role') === 'option' &&
        active.getAttribute('data-highlighted') !== null &&
        active.textContent?.trim() !== previous
      )
    }, roleBefore)
    const highlightedRole = await page.evaluate(() => document.activeElement?.textContent?.trim())
    await page.keyboard.press('Enter')
    await page.waitForFunction((previous) => {
      return document.querySelector('[role="combobox"][aria-label="职责"]')?.textContent?.trim() !== previous
    }, roleBefore)
    const roleAfterKeyboardSelection = await role.innerText()
    assert.notEqual(
      roleAfterKeyboardSelection,
      roleBefore,
      `ArrowUp + Enter changes draft role; highlighted=${highlightedRole}`
    )

    const checkbox = page.locator('#contract-tabpanel-settings input[type="checkbox"]').first()
    if (await checkbox.count()) {
      await checkbox.focus()
      const checkedBefore = await checkbox.isChecked()
      await page.keyboard.press('Space')
      assert.equal(await checkbox.isChecked(), !checkedBefore, 'Space toggles focused checkbox')
      await page.keyboard.press('Space')
      assert.equal(await checkbox.isChecked(), checkedBefore, 'Space restores checkbox draft value')
    }
    findings.push({
      type: 'agent-keyboard-controls',
      roleDropdownEscapeRestoresFocus: true,
      roleDropdownArrowAndEnterOperates: true,
      parentEscapeClosesInspector: true,
      roleBefore,
      roleAfterKeyboardSelection,
      checkboxSpaceTogglesAndRestores: Boolean(await checkbox.count()),
      noTaskRunOrSave: true
    })
    await page.screenshot({ path: path.join(evidence, 'agent-keyboard-controls.png') })
    await page.keyboard.press('Escape')
    await page.locator('.node-contract-panel').waitFor({ state: 'detached' })

    fs.writeFileSync(
      path.join(evidence, 'results.json'),
      JSON.stringify({ status: 'pass', findings, noTaskRunOrSave: true }, null, 2) + '\n'
    )
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, 'results.json'),
      JSON.stringify(
        { status: 'fail', findings, error: error instanceof Error ? error.message : String(error) },
        null,
        2
      ) + '\n'
    )
    throw error
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
