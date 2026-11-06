/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { qaOutputPath } = require('./qa-output.cjs')
const { launchQaBrowser } = require('./qa-browser.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await launchQaBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5194')
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/app.ts')
      if (useAppStore.getState().currentProject) return
      const projects = await window.api.listProjects()
      if (!projects.ok) throw new Error(projects.error.message)
      useAppStore.getState().openProject(projects.data.find(project => project.id === 'demo'))
    })
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const e = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { createEdge } = await import('/src/canvas/graph.ts')
      e.deleteShapes([...e.getCurrentPageShapeIds()])
      e.createShape({id:'shape:references',type:'node-card',x:360,y:120,props:{nodeType:'image-gen'}})
      const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="#569677"/></svg>')
      for(let i=0;i<10;i++) {
        e.createShape({id:`shape:reference-${i}`,type:'node-card',x:-900,y:i*350,props:{nodeType:'image',title:`参考图片 ${i+1}`,mediaId:`image${i}`,mediaPath:image,mediaMime:'image/svg+xml'}})
        if(!createEdge(e,{shapeId:`shape:reference-${i}`,portId:'out-image'},{shapeId:'shape:references',portId:'in-images'})) throw new Error('创建真实引用失败')
      }
      e.setCamera({x:0,y:0,z:1},{immediate:true})
    })
    const card=page.locator('[data-node-type="image-gen"]')
    await page.waitForFunction(() => document.querySelector('[data-node-type="image-gen"]')?.closest('.node-card-wrap').getBoundingClientRect().height === 360, null, { timeout: 10000 })
    assert.equal(await card.locator('.reference-thumb').count(),5)
    assert.equal(await card.locator('.reference-more').textContent(),'+5')
    assert.equal(await card.evaluate(el=>el.closest('.node-card-wrap').getBoundingClientRect().height),360)
    assert.equal(await card.locator('.connected-input-list').evaluate(el=>el.offsetHeight),36)
    await card.locator('.reference-more').hover()
    await page.waitForSelector('.reference-fullview')
    assert.equal(await page.locator('.reference-overflow-item').count(),5)
    await page.locator('.reference-fullview').hover()
    await page.waitForTimeout(220)
    assert.equal(await page.locator('.reference-fullview').count(),1,'可移入详情')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    assert.equal(await page.locator('.reference-fullview').count(),0,'Escape 关闭')
    await page.evaluate(async()=>{
      const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const {createEdge}=await import('/src/canvas/graph.ts')
      e.deleteShapes(Array.from({length:10},(_,i)=>`shape:reference-${i}`))
      e.createShape({id:'shape:long-text',type:'node-card',x:-900,y:0,props:{nodeType:'text',title:'提示词来源',text:'完整引用第一行\n'+('测试长内容\n'.repeat(100))+'完整引用末尾'}})
      createEdge(e,{shapeId:'shape:long-text',portId:'out-text'},{shapeId:'shape:references',portId:'in-text'})
    })
    await page.waitForTimeout(500)
    assert.equal(await card.locator('.connected-input-item').evaluate(el=>el.offsetHeight),36)
    await card.locator('.connected-input-item').hover()
    await page.waitForSelector('.reference-fullview')
    assert.ok((await page.locator('.reference-detail pre').textContent()).endsWith('完整引用末尾'))
    assert.ok(await page.locator('.reference-fullview').evaluate(el=>el.scrollHeight>el.clientHeight),'全文可滚动')
    await page.locator('.reference-copy').focus()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    assert.equal(await page.locator('.reference-fullview').count(),0,'详情内聚焦后 Escape 关闭')
    for (const zoom of [0.75,1.5,1]) {
      await page.evaluate(async zoom=>void (await import('/src/stores/editor.ts')).useEditorStore.getState().editor.setCamera({x:0,y:0,z:zoom},{immediate:true}),zoom)
      await page.waitForTimeout(100)
      assert.equal(await card.locator('.connected-input-list').evaluate(el=>el.offsetHeight),36)
    }
    fs.mkdirSync(qaOutputPath('qa/reference-standard'),{recursive:true})
    await page.screenshot({path:qaOutputPath('qa/reference-standard/single-row.png')})
    await page.evaluate(async()=>{const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;e.deleteShape('shape:long-text')})
    await page.waitForFunction(() => !document.querySelector('[data-node-type="image-gen"] .connected-inputs') && document.querySelector('[data-node-type="image-gen"]')?.closest('.node-card-wrap').getBoundingClientRect().height === 300, null, { timeout: 10000 })
    assert.equal(await card.locator('.connected-inputs').count(),0)
    assert.equal(await card.evaluate(el=>el.closest('.node-card-wrap').getBoundingClientRect().height),300)
    for (const sample of [0, false, {}, [], { description: '完整 JSON 字段', voice_id: '普通 JSON 不应当作音色' }]) {
      await page.evaluate(async sample => {
        const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        const {createEdge}=await import('/src/canvas/graph.ts')
        e.deleteShapes([...e.getCurrentPageShapeIds()])
        e.createShape({id:'shape:json-source',type:'node-card',x:-900,y:0,props:{nodeType:'json',text:JSON.stringify(sample)}})
        e.createShape({id:'shape:data-target',type:'node-card',x:360,y:120,props:{nodeType:'processor'}})
        if(!createEdge(e,{shapeId:'shape:json-source',portId:'out-json'},{shapeId:'shape:data-target',portId:'in-value'})) throw new Error('JSON 引用连接失败')
      },sample)
      await page.waitForTimeout(200)
      await page.mouse.move(100, 600)
      await page.locator('.connected-input-item').hover()
      await page.waitForSelector('.reference-fullview')
      assert.equal(await page.locator('.reference-detail pre').textContent(),JSON.stringify(sample,null,2))
      await page.keyboard.press('Escape')
    }
    await page.evaluate(async()=>{
      const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const {createEdge}=await import('/src/canvas/graph.ts')
      e.deleteShapes([...e.getCurrentPageShapeIds()])
      e.createShape({id:'shape:voice-source',type:'node-card',x:-900,y:0,props:{nodeType:'voice-design'},meta:{pinnedOutput:JSON.stringify({version:1,outputs:{'out-json':{kind:'json',data:{voice_id:'voice_id_long_example_12345',provider:'minimax'}}}})}})
      e.createShape({id:'shape:speech-target',type:'node-card',x:360,y:120,props:{nodeType:'speech'}})
      if(!createEdge(e,{shapeId:'shape:voice-source',portId:'out-json'},{shapeId:'shape:speech-target',portId:'in-voice'})) throw new Error('音色引用连接失败')
    })
    await page.waitForTimeout(200)
    assert.equal(await page.locator('.connected-input-item').getAttribute('data-reference-code'),'01V')
    await page.locator('.connected-input-item').hover()
    await page.waitForSelector('.reference-fullview')
    assert.equal(await page.getByRole('button',{name:'复制音色 ID'}).count(),1)
    assert.ok((await page.locator('.reference-detail pre').textContent()).includes('minimax'))
    assert.ok((await page.locator('.reference-detail pre').textContent()).includes('voice_id_long_example_12345'))
    await page.keyboard.press('Escape')
    await page.evaluate(()=>document.querySelectorAll('.canvas-host,.canvas-page').forEach(el=>{el.classList.remove('canvas-theme-dark');el.classList.add('canvas-theme-light')}))
    await page.mouse.move(100,600)
    await page.locator('.connected-input-item').hover()
    await page.waitForSelector('.reference-fullview')
    const theme=await page.evaluate(()=>{
      const anchor=getComputedStyle(document.querySelector('.connected-input-list'))
      const panel=getComputedStyle(document.querySelector('.reference-fullview'))
      const rect=document.querySelector('.reference-fullview').getBoundingClientRect()
      return {background:panel.backgroundColor,expected:anchor.getPropertyValue('--bg').trim(),z:Number(panel.zIndex),modal:Number(getComputedStyle(document.documentElement).getPropertyValue('--z-modal')),inside:rect.left>=8&&rect.top>=8&&rect.right<=innerWidth-8&&rect.bottom<=innerHeight-8}
    })
    assert.ok(theme.inside)
    assert.ok(theme.z<theme.modal)
    assert.ok(!theme.background.startsWith('rgba('),'详情背景不透明')
    await page.screenshot({path:qaOutputPath('qa/reference-standard/voice-light-detail.png')})
    await page.keyboard.press('Escape')
    await page.evaluate(async()=>{
      const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const {createEdge}=await import('/src/canvas/graph.ts')
      e.deleteShapes([...e.getCurrentPageShapeIds()])
      e.createShape({id:'shape:markdown-source',type:'node-card',x:-900,y:0,props:{nodeType:'chat'},meta:{pinnedOutput:JSON.stringify({version:1,outputs:{'out-markdown':{kind:'markdown',text:'# 引用标题\n\n**加粗内容**\n\n- 列表项\n\n<script>window.referenceUnsafe=true</script>'}}})}})
      e.createShape({id:'shape:markdown-target',type:'node-card',x:360,y:120,props:{nodeType:'processor'}})
      if(!createEdge(e,{shapeId:'shape:markdown-source',portId:'out-markdown'},{shapeId:'shape:markdown-target',portId:'in-value'})) throw new Error('Markdown 引用连接失败')
    })
    await page.mouse.move(100,600)
    await page.locator('.connected-input-item').hover()
    await page.waitForSelector('.reference-markdown h1')
    assert.equal(await page.locator('.reference-markdown strong').textContent(),'加粗内容')
    assert.equal(await page.locator('.reference-markdown li').textContent(),'列表项')
    assert.equal(await page.evaluate(()=>Boolean(window.referenceUnsafe)),false)
    await page.keyboard.press('Escape')
    await page.evaluate(async (motion) => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { createEdge } = await import('/src/canvas/graph.ts')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="#569677"/></svg>')
      editor.createShape({ id: 'shape:mention-source', type: 'node-card', x: -900, y: 0, props: {
        nodeType: 'image', title: '引用测试图片', mediaId: 'mention-image', mediaPath: image, mediaMime: 'image/svg+xml'
      } })
      editor.createShape({ id: 'shape:mention-image', type: 'node-card', x: 210, y: 395, props: { nodeType: 'image-gen' } })
      editor.createShape({ id: 'shape:mention-video', type: 'node-card', x: 650, y: 395, props: {
        nodeType: 'video', config: JSON.stringify({ modelKey: 'mock-seedance::Seedance-2.0' })
      } })
      editor.createShape({ id: 'shape:mention-motion', type: 'node-card', x: -900, y: 400, props: {
        nodeType: 'video-asset', title: '镜头素材', mediaId: 'mention-video', mediaPath: motion, mediaMime: 'video/mp4'
      } })
      if (!createEdge(editor, { shapeId: 'shape:mention-motion', portId: 'out-video' }, { shapeId: 'shape:mention-video', portId: 'in-reference-video' })) {
        throw new Error('视频艾特测试连线失败')
      }
      for (const id of ['shape:mention-image', 'shape:mention-video']) {
        if (!createEdge(editor, { shapeId: 'shape:mention-source', portId: 'out-image' }, { shapeId: id, portId: 'in-images' })) {
          throw new Error('图片艾特测试连线失败')
        }
      }
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    }, 'data:video/mp4;base64,' + fs.readFileSync('test/fixtures/agent-video.mp4').toString('base64'))
    const video = page.locator('[data-node-type="video"]')
    await card.locator('.reference-thumb').hover()
    const imageDetail = page.locator('.reference-fullview--image')
    await imageDetail.waitFor()
    assert.equal(await imageDetail.evaluate(panel => panel.offsetWidth), 360)
    const previewImage = imageDetail.locator('img.reference-detail-media')
    await previewImage.waitFor()
    await previewImage.evaluate(image => image.decode())
    assert.equal(await previewImage.evaluate(image => image.offsetHeight), 240)
    await page.keyboard.press('Escape')
    for (const [node, token, unresolved] of [[card, '@图片 1', '@图片 10'], [video, '@图1', '@图10']]) {
      const textarea = node.locator('textarea.gen-prompt')
      await textarea.fill('生成一只小猫@引用测试')
      await node.locator('.ref-mention-menu button').first().click()
      const mark = node.locator('.image-mention-mirror mark')
      await mark.waitFor({ state: 'attached' })
      assert.deepEqual(await mark.allTextContents(), [token])
      assert.equal(await textarea.inputValue(), '生成一只小猫' + token + ' ')
      await textarea.fill('生成一只小猫' + token + ' 普通文字 ' + unresolved)
      assert.deepEqual(await mark.allTextContents(), [token], '缺失的图片编号不高亮')
      assert.equal(await mark.evaluate(element => getComputedStyle(element).getPropertyValue('--run-accent').trim()), '#22d3ee')
      await textarea.fill('外部提示词 @图片1 和 @引用测试图片。未知 @不存在')
      assert.deepEqual(await mark.allTextContents(), ['@图片1', '@引用测试图片'])
      await textarea.blur()
      assert.equal(await textarea.inputValue(), '外部提示词 ' + token + ' 和 ' + token + '。未知 @不存在')
    }
    const videoPrompt = video.locator('textarea.gen-prompt')
    await videoPrompt.fill('@镜头')
    const videoCandidate = video.locator('.ref-mention-menu button')
    await videoCandidate.locator('video').waitFor()
    await videoCandidate.locator('.reference-video-mark').waitFor()
    await videoCandidate.click()
    assert.equal(await videoPrompt.inputValue(), '@视频1 ')
    assert.equal(await video.locator('.image-mention-mirror mark').textContent(), '@视频1')
    await videoPrompt.fill('镜头描述\n'.repeat(30) + '@图1')
    await videoPrompt.evaluate(textarea => { textarea.scrollTop = textarea.scrollHeight })
    await page.waitForFunction(() => {
      const textarea = document.querySelector('textarea.video-gen-prompt')
      const mirror = textarea?.nextElementSibling
      return textarea?.scrollTop > 0 && mirror?.scrollTop === textarea.scrollTop
    })
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShape('shape:mention-source')
    })
    await page.locator('.image-mention-mirror mark').first().waitFor({ state: 'detached' })
    assert.equal(await page.locator('.image-mention-mirror mark').count(), 0, '断线后取消高亮')
    assert.ok((await card.locator('textarea.gen-prompt').inputValue()).includes('@图片 1'))
    assert.ok((await video.locator('textarea.gen-prompt').inputValue()).includes('@图1'))
    const title = page.locator('.node-card-wrap:has([data-node-type="image-gen"]) .node-title')
    const originalName = await title.textContent()
    await title.dblclick()
    await page.waitForFunction(() => document.activeElement?.matches('.node-title[contenteditable="true"]'))
    const copiedName = await title.evaluate(element => {
      const clipboardData = new DataTransfer()
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
      return { text: clipboardData.getData('text/plain'), types: [...clipboardData.types] }
    })
    assert.deepEqual(copiedName, { text: originalName, types: ['text/plain'] })
    console.log('引用单排、多项折叠、真实连线、悬浮全文、移入、键盘关闭、缩放、高度回落、JSON 空值及音色 Schema 通过')
    console.log('图片悬浮 3/4 尺寸、生图与生视频引用高亮、断线清除高亮通过')
  } finally { await browser.close() }
})().catch(error=>{console.error(error);process.exitCode=1})
