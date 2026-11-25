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
      editor.updateShape({id:'shape:qa-video',type:'node-card',props:{config:JSON.stringify({providerKey:provider.id,modelKey:provider.id+'::'+model.id,mode:'first-frame',params:{ratio:'16:9',duration:1,resolution:'1080p'}})}})
    })
    const modeNotice = page.getByText('视频模式自动调整为', { exact: false })
    await modeNotice.first().waitFor()
    assert.equal(await modeNotice.count(), 1)
    const image=page.locator('[data-node-id="shape:qa-image"]')
    assert.equal(await image.getByRole('button',{name:'复制文件路径',exact:true}).count(),0)
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
    const spot=image.locator('.node-hover-spot')
    assert.equal(await spot.count(),1,'节点保留一层跟随光')
    assert.equal(await spot.evaluate(n=>getComputedStyle(n).opacity),'1','悬浮时显示跟随光')
    assert.match(await spot.evaluate(n=>getComputedStyle(n).backgroundImage),/60, 221, 227/,'面光使用原来的青色')
    assert.match(await spot.evaluate(n=>getComputedStyle(n,'::after').backgroundImage),/120, 232, 238/,'保留青色边缘光')
    const oldPosition=await image.evaluate(n=>n.style.getPropertyValue('--node-mouse-x'))
    await image.hover({position:{x:40,y:80}})
    assert.notEqual(await image.evaluate(n=>n.style.getPropertyValue('--node-mouse-x')),oldPosition,'光随鼠标移动')
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
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
      window.qaPlayback = []
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = async function () {
        await play.call(this)
        window.qaPlayback.push({ src: this.src, duration: this.duration })
      }
      const wave = new Uint8Array(44 + 16000)
      const view = new DataView(wave.buffer)
      for (const [offset, tag] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']])
        wave.set(new TextEncoder().encode(tag), offset)
      for (const [offset, value] of [[4, wave.length - 8], [16, 16], [24, 8000], [28, 16000], [40, 16000]])
        view.setUint32(offset, value, true)
      for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]])
        view.setUint16(offset, value, true)
      window.qaSelectedAudio = 'data:audio/wav;base64,' + btoa(String.fromCharCode(...wave))
      for (const [index, type] of ['speech', 'voice-design', 'image-edit'].entries()) {
        const mime = type === 'image-edit' ? 'image/png' : 'audio/wav'
        editor.createShape({
          id: 'shape:result-' + type, type: 'node-card', x: 80 + index * 390, y: 80,
          props: { nodeType: type, title: type, w: 340, h: 300, config: getNodeType(type).initialConfig || '' },
          meta: {
            nodeRun: { runId: 'qa-result', startedAt: 1, status: 'success', inputs: {} },
            nodeResult: JSON.stringify({
              kind: 'media-source', version: 1, selectedMediaId: 'picked',
              results: [
                { mediaId: 'picked', mediaPath: type === 'image-edit' ? 'qa-picked-' + type : window.qaSelectedAudio, mime, createdAt: 1 },
                { mediaId: 'recent', mediaPath: 'qa-recent-' + type, mime, createdAt: 2 }
              ]
            })
          }
        })
      }
    })
    for (const [index, type] of ['speech', 'voice-design'].entries()) {
      const card = page.locator(`[data-node-id="shape:result-${type}"]`)
      await card.getByRole('button', { name: '播放', exact: true }).click()
      await page.waitForFunction((count) => window.qaPlayback.length >= count, index + 1)
      const played = await page.evaluate((position) => ({
        selected: window.qaPlayback[position].src === window.qaSelectedAudio,
        duration: window.qaPlayback[position].duration
      }), index)
      assert.deepEqual(played, { selected: true, duration: 1 })
    }
    const edited = page.locator('[data-node-id="shape:result-image-edit"] img[src*="qa-picked-image-edit"]')
    await edited.first().waitFor({ state: 'attached' })
    // 在新卡片上固定正文，覆盖只有功能绑定、未手动选供应商的正常入口。
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { useGatewayStore } = await import('/src/stores/gateway.ts')
      editor.createShape({
        id: 'shape:voice-binding-check', type: 'node-card', x: 80, y: 450,
        props: { nodeType: 'voice-design', title: '音色绑定验收', w: 340, h: 300,
          text: '温暖的音色', config: JSON.stringify({ previewText: '试听文本' }) }
      })
      window.qaVoiceBinding = {
        useGatewayStore,
        resolve: window.api.models.resolveBinding
      }
    })
    const bindingButton = page.locator('[data-node-id="shape:voice-binding-check"]')
      .getByRole('button', { name: '设计音色', exact: true })
    assert.equal(await bindingButton.isDisabled(), true)
    await page.evaluate(() => {
      const { useGatewayStore, resolve } = window.qaVoiceBinding
      window.api.models.resolveBinding = (input) => input.featureKey === 'voice.design'
        ? Promise.resolve({ ok: true, data: { providerId: 'qa-minimax', modelId: 'qa-voice', modelKey: 'qa-voice' } })
        : resolve(input)
      useGatewayStore.setState((state) => ({
        providers: [...state.providers, {
          id: 'qa-minimax', name: 'QA MiniMax', specId: 'minimax',
          models: [{ id: 'qa-voice', modality: 'audio', operations: ['voice.design'] }]
        }]
      }))
    })
    await page.waitForFunction(() =>
      document.querySelector('[data-node-id="shape:voice-binding-check"] [data-original-action="btn-generate"]')?.disabled === false)
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.createShape({ id: 'shape:qa-loop', type: 'node-card', x: 500, y: 450,
        props: { nodeType: 'iterate', title: '循环验收', w: 340, h: 300 } })
      editor.createShape({ id: 'shape:qa-loop-target', type: 'node-card', x: 900, y: 450,
        props: { nodeType: 'json', title: '循环体', w: 340, h: 300 } })
    })
    const loop = page.locator('[data-node-id="shape:qa-loop"]')
    await loop.getByText('请从“当前项”端口连接循环体的第一个节点').waitFor()
    assert.equal(await loop.getByRole('button', { name: '运行循环' }).isDisabled(), true)
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { createEdge } = await import('/src/canvas/graph.ts')
      createEdge(editor, { shapeId: 'shape:qa-loop', portId: 'out-item' },
        { shapeId: 'shape:qa-loop-target', portId: 'in-json' })
    })
    await loop.getByText('请从“当前项”端口连接循环体的第一个节点').waitFor({ state: 'hidden' })
    assert.equal(await loop.getByRole('button', { name: '运行循环' }).isEnabled(), true)
    const resume = loop.getByRole('button', { name: '只继续未完成项', exact: true })
    assert.equal(await resume.count(), 0)
    await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.updateShape({ id: 'shape:qa-loop', type: 'node-card', props: { exec: 'cancelled' },
        meta: { nodeResult: JSON.stringify({ items: [
          { item: { id: 'done' }, status: 'done', source: { index: 0 } },
          { item: { id: 'pending' }, status: 'pending', source: { index: 1 } }
        ] }) } })
    })
    await resume.waitFor()
    assert.equal(await resume.isEnabled(), true)
    const placement = await page.evaluate(async () => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const { materializeArtifact } = await import('/src/canvas/artifact-materializer.ts')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const view = editor.getViewportPageBounds()
      editor.createShape({ id: 'shape:qa-right-producer', type: 'node-card',
        x: view.x + view.w - 365, y: view.y + 90,
        props: { nodeType: 'image-edit', title: '产物落位', w: 340, h: 300 } })
      const producer = editor.getShape('shape:qa-right-producer')
      materializeArtifact(editor, producer, {
        kind: 'image', mediaId: 'placement-test', mediaPath: 'qa-placement',
        mime: 'image/png', portId: 'out-image'
      }, 'qa-placement')
      const result = editor.getCurrentPageShapes().find(
        (shape) => shape.meta.artifactProducerId === producer.id
      )
      const bounds = editor.getShapePageBounds(result.id)
      const source = editor.getShapePageBounds(producer.id)
      return {
        visible: bounds.x >= view.x && bounds.y >= view.y &&
          bounds.maxX <= view.maxX && bounds.maxY <= view.maxY,
        overlaps: bounds.x < source.maxX && bounds.maxX > source.x &&
          bounds.y < source.maxY && bounds.maxY > source.y
      }
    })
    assert.deepEqual(placement, { visible: true, overlaps: false })
    await page.evaluate(async () => {
      window.api.listProjects = async () => ({ ok: true, data: [] })
      const { useAppStore } = await import('/src/stores/app.ts')
      useAppStore.getState().setHome()
    })
    await page.getByRole('button', { name: '创建第一个项目' }).click()
    await page.getByRole('dialog', { name: '新建项目' }).waitFor()
    console.log('Node refinements browser checks passed')
  } finally { await browser.close() }
})().catch(e=>{console.error(e);process.exitCode=1})
