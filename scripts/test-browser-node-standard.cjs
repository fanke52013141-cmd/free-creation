/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
function contrast(first, second) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0,3).map(Number)
    const rgb = color.startsWith('color(srgb') ? channels : channels.map(channel=>channel/255)
    return rgb.map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0)
  }
  const a=luminance(first),b=luminance(second)
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)
}
;(async () => {
  const output = `qa/node-presentation-${Date.now()}`
  fs.mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 2700, height: 2750 } })
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForSelector('.tl-canvas')
    await page.evaluate(async () => {
      const { PALETTE_NODE_GROUPS } = await import('/src/canvas/palette-categories.ts')
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      Object.values(PALETTE_NODE_GROUPS).forEach((ids,row) => ids.forEach((id,col) => editor.createShape({ id: `shape:standard-${id}`, type: 'node-card', x: 210 + col * 355, y: 100 + row * 500, props: { nodeType: id, title: getNodeType(id).label } })))
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      editor.selectNone()
    })
    await page.waitForTimeout(1200)
    const geometry = await page.locator('.node-card').evaluateAll((cards) => cards.map((card) => {
      const bounds = card.getBoundingClientRect()
      const buttons = [...card.querySelectorAll('.node-standard-action-bar > button')].map((button) => {
        const rect = button.getBoundingClientRect()
        return { label: button.textContent.trim(), width: rect.width, height: rect.height, bottom: bounds.bottom - rect.bottom, disabled: button.disabled }
      })
      const icon = card.querySelector('.node-standard-identity-icon')
      return { type: card.dataset.nodeType, height: bounds.height, buttons, descriptions: card.querySelectorAll('.node-standard-description').length, icon: icon && { box: icon.getBoundingClientRect().width, svg: icon.querySelector('svg').getBoundingClientRect().width }, scroll: card.querySelector('.node-standard-scroll').scrollHeight, probe: ['.node-body-content','.node-body-content > *','.node-standard-identity'].map(selector => { const el=card.querySelector(selector); if(!el) return null; const s=getComputedStyle(el); return { selector, offset:el.offsetHeight, scroll:el.scrollHeight, height:s.height, min:s.minHeight, margin:s.margin, padding:s.padding, flex:s.flex } }) }
    }))
    fs.writeFileSync(`${output}/geometry.json`, JSON.stringify(geometry,null,2))
    await page.screenshot({ path: `${output}/all-nodes-dark.png` })
    console.log(`28 节点尺寸证据：${output}`)
    assert.equal(geometry.length, 28)
    const clipped=await page.locator('.node-standard-identity').evaluateAll(identities=>identities.flatMap(identity=>{
      const scroll=identity.closest('.node-standard-scroll'),card=identity.closest('.node-card')
      const bottom=identity.querySelector('.node-standard-description').getBoundingClientRect().bottom
      const failures=[]
      for(let parent=identity.parentElement;parent&&parent!==scroll;parent=parent.parentElement) {
        if(['hidden','clip'].includes(getComputedStyle(parent).overflowY)&&bottom>parent.getBoundingClientRect().bottom+1) failures.push({type:card.dataset.nodeType,container:parent.className})
      }
      return failures
    }))
    assert.deepEqual(clipped,[],'身份名称和说明不能被私有容器裁掉')
    for (const node of geometry) {
      assert.ok(node.height >= 260 && node.height <= 440, `${node.type} height ${node.height}`)
      assert.equal(node.buttons.length, 1, `${node.type} main buttons`)
      const button = node.buttons[0]
      assert.equal(button.width, 200, `${node.type} width`)
      assert.equal(button.height, 32, `${node.type} height`)
      assert.ok(Math.abs(button.bottom - 8) < 1.1, `${node.type} inset ${button.bottom}`)
      assert.equal(node.descriptions, 1, `${node.type} description`)
      if (node.icon) { assert.equal(node.icon.box, 72); assert.equal(node.icon.svg, 32) }
    }
    for (const [type,label] of [['website','配置网址'],['chat','打开对话'],['ai-process','配置处理']]) {
      await page.locator(`[data-node-type="${type}"] .node-standard-action-bar`).getByRole('button', { name: label, exact: true }).click()
      await page.waitForTimeout(150)
      const opened = await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().shapeId)
      assert.equal(opened, `shape:standard-${type}`)
      await page.evaluate(async () => (await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close())
    }
    const textCard = page.locator('[data-node-type="text"]')
    await textCard.locator('.node-standard-action-bar button').click()
    await textCard.locator('textarea').fill('输入内容不会丢失')
    await textCard.getByRole('button',{name:'保存文本',exact:true}).click()
    assert.ok(await textCard.textContent().then(text => text.includes('输入内容不会丢失')))
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({ id:'shape:standard-text', type:'node-card', props:{text:Array.from({length:200},(_,i)=>`第 ${i+1} 行完整文本`).join('\n')} })
    })
    await page.waitForTimeout(350)
    assert.equal(await textCard.evaluate(el=>el.getBoundingClientRect().height),440)
    const scrolling = await textCard.locator('.node-standard-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;return {max:el.scrollHeight-el.clientHeight,top:el.scrollTop}})
    assert.ok(scrolling.max > 1000 && scrolling.top > 1000)
    await textCard.locator('.node-standard-action-bar button').click()
    await textCard.locator('textarea').fill('回落到一行')
    await textCard.locator('textarea').press('Control+Enter')
    await page.waitForTimeout(350)
    assert.equal(await textCard.evaluate(el=>el.getBoundingClientRect().height),260)
    const resized = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const shape = editor.getShape('shape:standard-text')
      const util = editor.getShapeUtil(shape)
      const resize = (scaleY,handle='bottom_right') => util.onResize(shape,{mode:'resize_bounds',newPoint:{x:shape.x,y:shape.y},handle,scaleX:1,scaleY})
      const small=resize(.1),large=resize(10)
      editor.updateShape({id:shape.id,type:'node-card',...large})
      return {small:small.props.h,large:large.props.h,mode:large.meta.nodeHeightMode,group:util.onResize(shape,{mode:'scale_shape'})}
    })
    assert.deepEqual(resized,{small:260,large:440,mode:'manual',group:undefined})
    await page.waitForTimeout(150)
    assert.equal(await textCard.evaluate(el=>el.getBoundingClientRect().height),440)
    await page.locator('[data-node-id="shape:standard-text"]').getByRole('button',{name:'恢复自动高度'}).click()
    await page.waitForTimeout(250)
    assert.equal(await textCard.evaluate(el=>el.getBoundingClientRect().height),260)
    const migration = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({id:'shape:standard-text',type:'node-card',props:{h:900},meta:{nodeHeightMode:'manual'}})
    })
    void migration
    await page.waitForTimeout(250)
    const migrated = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const saved=editor.getShape('shape:standard-text')
      const document=editor.store.getStoreSnapshot('document')
      editor.store.loadStoreSnapshot(document)
      return {height:saved.props.h,original:saved.meta.nodeOriginalHeight,text:editor.getShape(saved.id).props.text,mode:editor.getShape(saved.id).meta.nodeHeightMode}
    })
    assert.deepEqual(migrated,{height:440,original:900,text:'回落到一行',mode:'manual'})
    await page.evaluate(async () => {
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({id:'shape:standard-ai-process',type:'node-card',meta:{nodeRun:{runId:'qa-saved-result',status:'success',startedAt:1,inputs:{}},nodeResult:JSON.stringify({kind:'text',text:'完整历史结果\n'.repeat(200)+'结束标记'})}})
    })
    const processCard=page.locator('[data-node-type="ai-process"]')
    await processCard.getByRole('button',{name:'查看已有结果',exact:true}).click()
    assert.equal(await processCard.getByRole('textbox',{name:'完整处理结果'}).inputValue(),'完整历史结果\n'.repeat(200)+'结束标记')
    assert.equal(await processCard.locator('.node-standard-action-bar > button').count(),1)
    await processCard.getByRole('button',{name:'返回处理设置',exact:true}).click()
    assert.equal(await processCard.locator('.node-standard-action-bar > button').textContent().then(text=>text.trim()),'配置处理')
    await page.evaluate(async () => {
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({id:'shape:standard-ai-process',type:'node-card',props:{exec:'running'},meta:{nodeRun:{runId:'qa-running',status:'running',startedAt:Date.now(),inputs:{}}}})
    })
    await page.waitForTimeout(100)
    assert.equal(await processCard.locator('.node-standard-action-bar button').isDisabled(),true)
    const running=await processCard.evaluate(card=>({overlay:card.querySelector('.node-execution-overlay').getBoundingClientRect().bottom,button:card.querySelector('.node-standard-action-bar button').getBoundingClientRect().top}))
    assert.ok(running.overlay<=running.button)
    await page.evaluate(async ()=>{(await import('/src/stores/editor.ts')).useEditorStore.getState().editor.updateShape({id:'shape:standard-ai-process',type:'node-card',props:{exec:'idle'}})})
    await page.setViewportSize({width:4300,height:4200})
    for (const theme of ['dark','light']) for (const zoom of [.75,1,1.5]) {
      await page.evaluate(async ({theme,zoom})=>{
        document.querySelectorAll('.canvas-host,.canvas-page').forEach(el=>{el.classList.toggle('canvas-theme-dark',theme==='dark');el.classList.toggle('canvas-theme-light',theme==='light')})
        const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        editor.setCamera({x:0,y:0,z:zoom},{immediate:true})
      },{theme,zoom})
      await page.waitForTimeout(100)
      const buttons=await page.locator('.node-standard-action-bar > button').evaluateAll(buttons=>buttons.map(button=>{const b=button.getBoundingClientRect(),c=button.closest('.node-card').getBoundingClientRect();return {width:b.width,height:b.height,inset:c.bottom-b.bottom}}))
      assert.equal(buttons.length,28)
      for (const b of buttons) {assert.ok(Math.abs(b.width-200*zoom)<1);assert.ok(Math.abs(b.height-32*zoom)<1);assert.ok(Math.abs(b.inset-8*zoom)<1,`${theme}/${zoom}: ${JSON.stringify(b)}`)}
      const descriptions=await page.locator('.node-standard-description').evaluateAll(els=>els.map(el=>({height:getComputedStyle(el).height,color:getComputedStyle(el).color,background:getComputedStyle(el.closest('.node-card')).backgroundColor})))
      for (const d of descriptions) {assert.equal(d.height,'36px');assert.ok(contrast(d.color,d.background)>=4.5,`${theme} description contrast ${contrast(d.color,d.background)}`)}
    }
    console.log('28 节点几何、主动作、文本增长/回落、手动边界、恢复自动、旧尺寸/快照恢复、深浅主题与三档缩放通过')
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
