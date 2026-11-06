/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { launchQaBrowser } = require('./qa-browser.cjs')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await launchQaBrowser()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  try {
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForSelector('.tl-canvas')
    await page.waitForFunction(async () => Boolean((await import('/src/nodes/registry.tsx')).getNodeType('website')))
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.setCamera({x:0,y:0,z:1},{immediate:true})
      const canvas = document.createElement('canvas')
      canvas.width=640; canvas.height=360
      const context=canvas.getContext('2d')
      context.fillStyle='#858d97';context.fillRect(0,0,640,360)
      const url=canvas.toDataURL()
      window.api.copyMediaPath=async()=>({ok:true,data:true})
      const rows = [
        ['image','图片',100,100,{mediaId:'qa-image',mediaPath:url,mediaMime:'image/png'}],
        ['website','官网',500,100,{config:JSON.stringify({name:'官网',url:'https://example.com/'})}],
        ['text','文本',900,100,{text:'你好，朋友'}],
        ['file','Markdown',500,480,{mediaId:'qa-file',mediaPath:'notes.md',mediaMime:'text/markdown',text:'# 标题\n正文'}],
        ['video','视频生成',100,480,{}]
      ]
      for(const [type,title,x,y,extra] of rows){
        const spec=(await import('/src/nodes/registry.tsx')).getNodeType(type)
        editor.createShape({id:'shape:qa-'+type,type:'node-card',x,y,props:{nodeType:type,title,w:340,h:300,config:spec.initialConfig||'',...extra}})
      }
      await window.api.gateway.saveProvider({
        name:'QA Vidu',specId:'vidu',baseURL:'https://example.com',apiKey:'fixture',
        models:[{id:'3.2',modality:'video'}]
      })
      const providers=await window.api.gateway.listProviders()
      const provider=providers.data.find(p=>p.specId==='vidu')
      const model=provider.models.find(m=>m.modality==='video')
      editor.updateShape({id:'shape:qa-video',type:'node-card',props:{config:JSON.stringify({providerKey:provider.id,modelKey:provider.id+'::'+model.id,params:{ratio:'16:9',duration:1,resolution:'1080p'}})}})
    })
    const image=page.locator('[data-node-id="shape:qa-image"]')
    await image.getByRole('button',{name:'复制文件路径',exact:true}).click()
    await page.getByRole('status').filter({hasText:'复制成功'}).waitFor()
    assert.ok(await page.locator('.global-toast').evaluate(n=>n.getBoundingClientRect().top<100))
    assert.equal(await image.locator('.port-core').first().evaluate(n=>Number.parseFloat(getComputedStyle(n).width)),12)
    const website=page.locator('[data-node-id="shape:qa-website"]')
    assert.equal(await website.getByRole('button',{name:'修改网址',exact:true}).count(),1)
    assert.equal(await website.getByRole('button',{name:'打开网址',exact:true}).count(),1)
    const alignment=await website.evaluate(n=>{
      const summary=n.querySelector('.website-node-summary').getBoundingClientRect()
      const body=n.querySelector('.node-standard-scroll').getBoundingClientRect()
      const buttons=[...n.querySelectorAll('.node-standard-action-bar button')].map(b=>b.getBoundingClientRect().width)
      return {delta:Math.abs((summary.top+summary.bottom-body.top-body.bottom)/2),buttons}
    })
    assert.equal(await page.locator('.video-gen-prompt').evaluate(n=>getComputedStyle(n).borderColor),'rgb(37, 43, 54)')
    await page.screenshot({path:'qa/node-refinements-before.png'})
    assert.ok(alignment.delta<12,JSON.stringify(alignment))
    assert.ok(Math.abs(alignment.buttons[0]-alignment.buttons[1])<1)
    await website.getByRole('button',{name:'修改网址',exact:true}).click()
    await page.getByRole('textbox',{name:'名称',exact:true}).waitFor()
    await page.keyboard.press('Escape')
    await page.evaluate(async () => {
      const { useNodePanelStore } = await import('/src/stores/nodePanel.ts')
      useNodePanelStore.getState().close()
    })
    await image.getByRole('button',{name:'创建裁剪节点并连接当前图片',exact:true}).click()
    const geometry=await page.evaluate(async()=>{
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const source=editor.getShape('shape:qa-image')
      const target=editor.getCurrentPageShapes().find(s=>s.props.nodeType==='image-crop')
      return {x:target.x,y:target.y,expected:source.x+source.props.w+96}
    })
    // The website occupies the right slot, so the new crop must be placed in the same nearby column.
    assert.equal(geometry.x,geometry.expected)
    const cropWrap=page.locator('.node-card-wrap').filter({has:page.locator('[data-node-type="image-crop"]')})
    await cropWrap.getByRole('button',{name:'21:9',exact:true}).waitFor()
    assert.equal(await cropWrap.getByRole('button',{name:'精细框选',exact:true}).count(),0)
    const cropButton=cropWrap.getByRole('button',{name:'裁剪图片',exact:true})
    assert.equal(await cropButton.locator('svg').count(),0)
    await page.evaluate(async () => {
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.select('shape:qa-image')
    })
    await image.hover()
    await page.waitForTimeout(300)
    // 2026-11-06：悬浮光按参考实现——面光为高分衰减的径向渐变（无模糊层、无硬接缝），
    // 边缘光恢复为 1px 内环，随 hover 一起淡入。
    assert.ok(Number(await image.locator('.node-hover-spot').evaluate(n=>getComputedStyle(n).opacity))>0.8,'悬浮柔光必须可见')
    assert.match(await image.locator('.node-hover-spot').evaluate(n=>getComputedStyle(n,'::before').content),/none/)
    assert.match(await image.locator('.node-hover-spot').evaluate(n=>getComputedStyle(n,'::after').backgroundImage),/120,\s*232,\s*238/,'边缘光必须存在')
    assert.equal(await image.locator('.node-selection-beam').evaluate(n=>getComputedStyle(n).animationName),'node-beam-flow')
    const firstAngle=await image.locator('.node-selection-beam').evaluate(n=>getComputedStyle(n).getPropertyValue('--node-beam-angle'))
    await page.waitForTimeout(180)
    assert.notEqual(await image.locator('.node-selection-beam').evaluate(n=>getComputedStyle(n).getPropertyValue('--node-beam-angle')),firstAngle)
    await page.screenshot({path:'qa/node-refinements.png'})
    const select=page.locator('[data-node-id="shape:qa-video"] .app-select-trigger').filter({hasText:/^4s?$/})
    await select.click()
    assert.equal(await page.locator('.app-select-content').getAttribute('data-side'),'bottom')
    assert.equal(await page.getByRole('option',{name:'1s',exact:true}).count(),0)
    await select.click()
    assert.equal(await page.locator('.app-select-content').count(),0)
    const groupedPlacement=await page.evaluate(async()=>{
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const {createImageContinuation}=await import('/src/nodes/specs/bodies/shared.tsx')
      editor.groupShapes(['shape:qa-image','shape:qa-text'])
      const group=editor.getShape(editor.getShape('shape:qa-image').parentId)
      editor.updateShape({id:group.id,type:'group',x:group.x+900,y:group.y+30})
      const source=editor.getShape('shape:qa-image')
      const bounds=editor.getShapePageBounds(source)
      const before=new Set(editor.getCurrentPageShapeIds())
      createImageContinuation(editor,source,'image-crop')
      const child=editor.getCurrentPageShapes().find(s=>!before.has(s.id)&&s.props.nodeType==='image-crop')
      return {x:child.x,y:child.y,expectedX:bounds.maxX+96,expectedY:bounds.y}
    })
    assert.equal(groupedPlacement.x,groupedPlacement.expectedX)
    assert.equal(groupedPlacement.y,groupedPlacement.expectedY)
    console.log('Node refinements browser checks passed')
  } finally { await browser.close() }
})().catch(e=>{console.error(e);process.exitCode=1})
