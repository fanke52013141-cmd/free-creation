/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Full desktop regression: uploads image + audio through the asset-library UI,
// verifies SQLite/blob persistence, then restarts Electron and reads it back.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z3D4PwQGAQ8Ai/1+GQAAAABJRU5ErkJggg==',
  'base64'
)

function makeWav() {
  const sampleRate = 8000
  const sampleCount = 800
  const pcm = Buffer.alloc(sampleCount * 2)
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.length, 40)
  pcm.copy(wav, 44)
  return wav
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, CANVAS_DATA_DIR: dataDir },
    timeout: 90_000
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: '资源库', exact: true }).waitFor()
  return { app, page }
}

async function readAsset(page, id) {
  const result = await page.evaluate(async (resourceId) => {
    const search = await window.api.searchLibrary({ categoryId: 'legacy', limit: 20 })
    const detail = await window.api.getLibraryResource({ resourceId })
    return { search, detail }
  }, id)
  assert.equal(result.search.ok, true, 'real main-process search IPC should work')
  assert.equal(result.detail.ok, true, 'real main-process detail IPC should work')
  return result
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-library-electron-'))
  const wav = makeWav()
  const expected = new Map([
    ['回归图片.png', { bytes: PNG, mime: 'image/png', type: 'image' }],
    ['回归声音.wav', { bytes: wav, mime: 'audio/wav', type: 'audio' }]
  ])
  let app

  try {
    let launched = await launchApp(dataDir)
    app = launched.app
    let page = launched.page
    await page.getByRole('button', { name: '资源库', exact: true }).click()
    await page.locator('.resource-library-page').waitFor()
    await page.screenshot({ path: path.join(dataDir, 'asset-library-before-upload.png'), fullPage: true })
    await page.locator('.library-page-header .library-primary').click()
    const dialog = page.getByRole('dialog', { name: '新建资源', exact: true })
    await dialog.waitFor()
    await dialog.getByLabel('资源名称', { exact: true }).fill('图片与音频上传回归资产')
    await dialog.locator('.library-component-add-actions input[type="file"]').setInputFiles([
      { name: '回归图片.png', mimeType: 'image/png', buffer: PNG },
      { name: '回归声音.wav', mimeType: 'audio/wav', buffer: wav }
    ])
    await assert.equal(await dialog.locator('.library-component-edit').count(), 2)
    await page.screenshot({ path: path.join(dataDir, 'asset-library-upload-ready.png'), fullPage: true })
    await dialog.getByRole('button', { name: '保存资源', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })

    const card = page.locator('.library-resource-card').filter({ hasText: '图片与音频上传回归资产' })
    await card.waitFor()
    // Saving selects the new resource and opens its details automatically.
    await page.getByRole('dialog', { name: '资源详情' }).waitFor()
    const resourceId = await page.evaluate(async () => {
      const result = await window.api.searchLibrary({ query: '图片与音频上传回归资产', limit: 1 })
      if (!result.ok) throw new Error(result.error.message)
      return result.data.items[0]?.id
    })
    assert.ok(resourceId, 'saved resource should be searchable immediately')
    const firstRead = await readAsset(page, resourceId)

    const detail = firstRead.detail.data
    assert.ok(detail, 'new resource is immediately readable from SQLite')
    assert.equal(detail.selectedTitle, '图片与音频上传回归资产')
    assert.equal(detail.category, undefined, 'uncategorized/freeform creation is supported')
    assert.equal(detail.components.length, 2)
    assert.deepEqual(detail.components.map((component) => component.valueType).sort(), ['audio', 'image'])

    for (const component of detail.components) {
      const fixture = expected.get(component.fileName)
      assert.ok(fixture, `unexpected saved upload name: ${component.fileName}`)
      assert.equal(component.valueType, fixture.type)
      assert.equal(component.mime, fixture.mime)
      assert.equal(component.sizeBytes, fixture.bytes.length)
      assert.equal(component.contentHash, sha256(fixture.bytes), `${component.fileName} content hash must match`)
      const storedBytes = fs.readFileSync(path.join(dataDir, component.blobPath))
      assert.deepEqual(storedBytes, fixture.bytes, `${component.fileName} bytes must be persisted intact`)
    }
    assert.ok(firstRead.search.data.items.some((item) => item.id === detail.id), 'saved resource is in the uncategorized filter')
    await app.close()
    app = undefined

    launched = await launchApp(dataDir)
    app = launched.app
    page = launched.page
    await page.getByRole('button', { name: '资源库', exact: true }).click()
    await page.locator('.resource-library-page').waitFor()
    await page.getByRole('button', { name: '未分类', exact: true }).click()
    const afterRestartCard = page.locator('.library-resource-card').filter({ hasText: '图片与音频上传回归资产' })
    await afterRestartCard.waitFor()
    await afterRestartCard.click()
    const reopened = await page.getByRole('dialog', { name: '资源详情' }).waitFor().then(async () => readAsset(page, detail.id))
    assert.equal(reopened.detail.data.selectedTitle, detail.selectedTitle)
    assert.deepEqual(reopened.detail.data.components.map((component) => component.contentHash).sort(), detail.components.map((component) => component.contentHash).sort())
    assert.equal(reopened.detail.data.components.length, 2, 'both media components survive an Electron restart')

    console.log(`PASS: uploaded image + audio through Electron UI; saved, SHA-256 verified, and read back after restart. Test data: ${dataDir}`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (process.env.CANVAS_LIBRARY_TEST_KEEP !== '1') fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
