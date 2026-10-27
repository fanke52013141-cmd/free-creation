/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// 浏览器验收：动态表格显示并编辑分镜字段，逐行写回不得丢失额外字段。
//
// 剧本节点的提示词要求模型为每个镜头产出 scene/dialogue/sound/duration，批量生图模板还用到
// camera。旧卡片自带一份只认四个字段的解析，用户在卡片上编辑任意一格，其他镜头的 sound、
// camera 就被静默写丢——下游生图/合成拿到的是残缺分镜，而且看不出来。
// vitest 不挂载 React，卡片这条读写回路只能在真实浏览器里钉住。
//
// 表格契约（specs/bodies/storyboard.tsx + nodes/storyboard-editor.ts）：列按镜头字段动态生成，
// id 永不成为列（身份由行 data-shot-id 承载），th 的 title 暴露稳定字段名、可见文案走中文标题。
//
// 前置：本仓库的浏览器验收服务（optimization-ui 门禁或手工 vite）。
// 运行：CANVAS_QA_URL=http://127.0.0.1:5194 npm run test:browser-storyboard
const { launchQaBrowser } = require('./qa-browser.cjs')
const assert = require('node:assert/strict')

const ORIGIN = process.env.CANVAS_QA_URL || 'http://127.0.0.1:5194'

const SHOTS = JSON.stringify({
  shots: [
    {
      id: 'shot-1',
      scene: '雨夜的霓虹街头',
      dialogue: '别回头',
      sound: '细雨与车流',
      camera: '中近景跟拍',
      duration: '4s'
    },
    {
      id: 'shot-2',
      scene: '潮湿的巷口',
      dialogue: '',
      sound: '脚步声与雨声',
      camera: '广角远景',
      duration: '5s'
    }
  ]
})

async function main() {
  const browser = await launchQaBrowser()
  const page = await browser.newPage({ viewport: { width: 1707, height: 900 } })
  page.setDefaultTimeout(15_000)
  try {
    await page.goto(ORIGIN)
    await page.waitForSelector('.tl-canvas')
    const openDemo = page.getByRole('button', { name: '打开项目 浏览器演示项目', exact: true })
    if (await openDemo.count()) await openDemo.click()
    await page.getByRole('button', { name: '展开视频创作节点', exact: true }).click()
    await page.getByRole('button', { name: '添加分镜板节点', exact: true }).click()
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
    const card = page.locator('.node-card-wrap:has(.type-storyboard)').first()
    await card.waitFor()

    // 空态必须让不写 JSON 的用户也能开工。
    assert.ok(
      await card
        .getByRole('button', { name: '新增镜头', exact: true })
        .first()
        .isVisible()
        .catch(() => false),
      '空分镜板必须给出「新增镜头」出口'
    )

    await card.getByRole('button', { name: '编辑 JSON', exact: true }).first().click()
    await card.locator('.node-textarea.code-edit').fill(SHOTS)
    await page.keyboard.press('Control+Enter')
    await card.locator('.storyboard-table tbody tr').first().waitFor()
    assert.equal(await card.locator('.storyboard-table tbody tr').count(), 2, '两个镜头都要显示为表格行')

    // 列契约：字段列按镜头键动态生成且 id 永不成为列；身份只由行 data-shot-id 承载，
    // th 的 title 是稳定字段名，可见表头走中文标题。
    for (const field of ['scene', 'dialogue', 'sound', 'camera', 'duration']) {
      await card.locator(`.storyboard-table thead th[title="${field}"]`).waitFor()
    }
    assert.equal(
      await card.locator('.storyboard-table thead th[title="id"]').count(),
      0,
      'id 必须只由 data-shot-id 承载，不得渲染成列'
    )
    for (const shotId of ['shot-1', 'shot-2']) {
      assert.equal(
        await card.locator(`.storyboard-table tbody tr[data-shot-id="${shotId}"]`).count(),
        1,
        `行身份必须由 data-shot-id=${shotId} 承载`
      )
    }
    assert.equal(
      (await card.locator('.storyboard-table thead th[title="scene"]').innerText()).trim(),
      '画面描述',
      '表头可见文案使用字段中文标题'
    )

    const bodyText = (await card.innerText()).replace(/\s+/g, '')
    // 工具条契约：镜头/列数摘要 + 创建批处理流程/新增镜头/编辑JSON 三个真实操作。
    assert.ok(bodyText.includes('2个镜头·5列'), `工具条必须给出镜头与列数摘要，实际文案：${bodyText}`)
    for (const action of ['创建批处理流程', '新增镜头', '编辑JSON']) {
      assert.ok(bodyText.includes(action), `工具条必须提供「${action}」，实际文案：${bodyText}`)
    }
    // 缩略图那条回路永远不会有媒体写入，连带它的假提示一起删掉了。
    assert.equal(await card.locator('.storyboard-thumb, .storyboard-thumb-empty').count(), 0)
    assert.ok(!bodyText.includes('请通过分镜批量生图工作流生成媒体'), '不得出现做不到的承诺')
    assert.ok(!bodyText.includes('逐镜编辑后可用'), '不得指向本卡片没参与的模板')

    // 只改第 1 镜的画面：这是缺陷触发点——保存时卡片会把整块数据重新解析写回。
    const sceneCell = card.locator('[data-shot-id="shot-1"] [data-field="scene"] .storyboard-cell-value')
    await sceneCell.dblclick()
    await card.locator('.storyboard-cell-editor textarea').fill('雨夜街头，主角回头')
    await card.getByRole('button', { name: '保存', exact: true }).click()
    await card.locator('[data-shot-id="shot-1"] [data-field="scene"] .storyboard-cell-value').waitFor()

    // 再次打开原始 JSON，看卡片真正写回文档的内容：字段是否活过了这一次编辑。
    await card.getByRole('button', { name: '编辑 JSON', exact: true }).first().click()
    await card.locator('.node-textarea.code-edit').waitFor()
    const draft = await card.locator('.node-textarea.code-edit').inputValue()
    const parsed = JSON.parse(draft)
    assert.equal(parsed.shots[0].scene, '雨夜街头，主角回头', '编辑必须落到目标镜头')
    assert.equal(parsed.shots[0].sound, '细雨与车流', '编辑第 1 镜不得写丢第 1 镜的 sound')
    assert.equal(parsed.shots[0].camera, '中近景跟拍', '编辑第 1 镜不得写丢第 1 镜的 camera')
    assert.equal(parsed.shots[1].sound, '脚步声与雨声', '未编辑的镜头必须原样保留 sound')
    assert.equal(parsed.shots[1].camera, '广角远景', '未编辑的镜头必须原样保留 camera')
    assert.ok(!('imageMediaId' in parsed.shots[0]), '卡片不再承载镜头图片字段')

    console.log('PASS: 分镜板动态表格编辑保留 sound/camera，并展示真实输出端口')
  } finally {
    await browser.close()
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
