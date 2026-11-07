/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { launchQaBrowser } = require('./qa-browser.cjs')
const { qaOutputPath } = require('./qa-output.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

;(async () => {
  const output = qaOutputPath(`qa/node-visual-v22-${Date.now()}`)
  fs.mkdirSync(output, { recursive: true })
  const browser = await launchQaBrowser()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1160 } })
  const errors = []
  let phase='boot'
  page.on('pageerror', error => errors.push({phase,message:error.message,stack:error.stack}))
  try {
    await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5196')
    await page.waitForSelector('.tl-canvas')
    await page.waitForFunction(async () => {
      const {getNodeType}=await import('/src/nodes/registry.tsx')
      const {PALETTE_NODE_GROUPS}=await import('/src/canvas/palette-categories.ts')
      return Object.values(PALETTE_NODE_GROUPS).flat().every(type=>getNodeType(type))
    })
    const families = await page.evaluate(async () => Object.keys((await import('/src/canvas/palette-categories.ts')).PALETTE_NODE_GROUPS))
    // Preserve startup diagnostics separately; this gate measures errors introduced by node scenarios.
    const startupErrors=errors.splice(0)
    const knownStartupMessages = new Set(['The source image cannot be decoded.', 'Failed to fetch'])
    assert.deepEqual(startupErrors.filter(error => !knownStartupMessages.has(error.message)), [])
    const measurements = []
    for (const family of families) {
      phase=family
      await page.evaluate(async family => {
        const { PALETTE_NODE_GROUPS } = await import('/src/canvas/palette-categories.ts')
        const { getNodeType } = await import('/src/nodes/registry.tsx')
        const editor = (await import('/src/stores/editor.ts')).useEditorStore.getState().editor
        editor.deleteShapes([...editor.getCurrentPageShapeIds()])
        PALETTE_NODE_GROUPS[family].forEach((type, index) => {
          const spec = getNodeType(type)
          if(!spec) throw new Error(`Unregistered ${type} in ${family}`)
          editor.createShape({ id: `shape:v22-${type}`, type: 'node-card', x: 205 + (index % 3) * 400, y: 110 + Math.floor(index / 3) * 360,
            props: { nodeType: type, title: spec.label, w: spec.defaultSize.w, h: spec.defaultSize.h, config: spec.initialConfig || '' } })
        })
        editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
        editor.selectNone()
      }, family)
      await page.waitForTimeout(400)
      measurements.push(...await page.locator('.node-card-wrap').evaluateAll(nodes => nodes.map(node => {
        const bounds = node.getBoundingClientRect()
        const center = selector => { const r = node.querySelector(selector).getBoundingClientRect(); return (r.top+r.bottom)/2 }
        const ports = [...node.querySelectorAll('.port-core')].map(core => {
          const r=core.getBoundingClientRect()
          return core.closest('.port-dot').classList.contains('in') ? bounds.left-r.right : r.left-bounds.right
        })
        return { type:node.querySelector('.node-card').dataset.nodeType, width:bounds.width, height:bounds.height,
          alignment:[center('.node-seq'),center('.node-icon'),center('.node-title')], ports,
          shadow:getComputedStyle(node.querySelector('.node-card')).boxShadow,
          emptyIcon:node.querySelector('.node-standard-identity-icon svg')?.getBoundingClientRect().width,
          actions:[...node.querySelectorAll('.node-standard-action-bar button')].map(b=>b.textContent.trim()) }
      })))
      await page.screenshot({ path:path.join(output,`${family}-initial.png`), animations:'disabled' })
    }
    assert.equal(measurements.length,32)
    for(const row of measurements) {
      assert.ok(Math.max(...row.alignment)-Math.min(...row.alignment)<.6,`${row.type}: header alignment`)
      assert.ok(row.ports.every(distance=>Math.abs(distance-18)<.6),`${row.type}: detached ports ${row.ports}`)
      if(row.emptyIcon)assert.equal(row.emptyIcon,64)
    }
    // A populated image keeps its six original continuation callbacks and moves only file tools.
    phase='image-content'
    await page.evaluate(async () => {
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#aec3cc"/><path d="M0 290H960V540H0Z" fill="#8da5ad"/><path d="M0 440 960 330V540H0Z" fill="#b5b098"/><path d="M270 160H740V420H270Z" fill="#d7cebc"/><path d="M350 250H680V420H350Z" fill="#526b6c"/><path d="M260 145H760V180H260Z" fill="#e6dece"/></svg>')
      window.__v22Image=image
      const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540
      const context=canvas.getContext('2d')
      for(const [color,x,y,w,h] of [['#aec3cc',0,0,960,540],['#8da5ad',0,290,960,250],['#b5b098',0,440,960,100],['#d7cebc',270,160,470,260],['#526b6c',350,250,330,170],['#e6dece',260,145,500,35]]){context.fillStyle=color;context.fillRect(x,y,w,h)}
      window.__v22Image=canvas.toDataURL('image/png')
      window.__v22FileCalls=[]
      window.api.revealMedia=async id=>{window.__v22FileCalls.push(['locate',id]);return {ok:true,data:true}}
      editor.createShape({id:'shape:v22-asset',type:'node-card',x:290,y:150,props:{nodeType:'image',title:'图片',mediaId:'v22-image',mediaPath:window.__v22Image,mediaMime:'image/png'}})
      editor.setCamera({x:0,y:0,z:1},{immediate:true})
    })
    const asset=page.locator('[data-node-id="shape:v22-asset"]')
    assert.equal(await asset.locator('.media-action-primary button').count(),6)
    assert.equal(await asset.locator('.node-header .media-file-action-btn').count(),1)
    assert.equal(await asset.locator('.port-dot.in').count(),0)
    await asset.getByRole('button',{name:'在资源管理器中定位',exact:true}).click()
    assert.equal(await asset.getByRole('button',{name:'复制文件路径',exact:true}).count(),0)
    assert.deepEqual(await page.evaluate(()=>window.__v22FileCalls),[['locate','v22-image']])
    for (const theme of ['dark', 'light']) {
      await page.locator('.canvas-page').evaluate((node, selectedTheme) => {
        node.classList.toggle('canvas-theme-dark', selectedTheme === 'dark')
        node.classList.toggle('canvas-theme-light', selectedTheme === 'light')
      }, theme)
      for (const button of await asset.locator('.node-header :is(.node-info-btn, .node-run-btn, .media-file-action-btn):not(:disabled)').all()) {
        await button.hover()
        await page.waitForTimeout(250)
        assert.equal(await button.evaluate(node=>getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', `${theme} 标题图标悬浮无背景`)
      }
      assert.equal(await asset.locator('.node-hover-spot').count(),1,`${theme} 保留节点跟随光`)
      assert.equal(await asset.locator('.node-hover-spot').evaluate(node=>getComputedStyle(node).opacity),'1',`${theme} 悬浮时显示跟随光`)
      assert.notEqual(await asset.evaluate(node=>getComputedStyle(node,'::before').content), '""', `${theme} 不叠加额外伪元素光层`)
    }
    await page.locator('.canvas-page').evaluate(node => {
      node.classList.add('canvas-theme-dark')
      node.classList.remove('canvas-theme-light')
    })

    await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      useEditorStore.getState().editor.selectNone()
    })
    await asset.hover()
    assert.ok(!(await asset.evaluate(node => node.classList.contains('is-selected'))))
    assert.equal(await asset.locator('.node-card').evaluate(n=>getComputedStyle(n).transform),'none')
    assert.equal(await asset.locator('.node-card').evaluate(n=>getComputedStyle(n).boxShadow),'none')
    await page.screenshot({path:path.join(output,'image-content.png')})
    await asset.getByRole('button',{name:'创建裁剪节点并连接当前图片',exact:true}).click()
    assert.equal(await page.locator('[data-node-type="image-crop"]').count(),1)
    const realEdge=await page.evaluate(async()=>{
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      return editor.getCurrentPageShapes().some(s=>s.type==='arrow'&&s.meta.fromPort==='out-image'&&s.meta.toPort==='in-image')
    })
    assert.ok(realEdge,'Continuation must create a real declared edge')
    await page.evaluate(async()=>{
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      ;(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close()
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const {createEdge}=await import('/src/canvas/graph.ts')
      editor.createShape({id:'shape:v22-text-source',type:'node-card',x:-1000,y:0,props:{nodeType:'text',title:'文本来源',text:'完整引用第一行\n保留完整正文末尾'}})
      for(let i=0;i<3;i++)editor.createShape({id:`shape:v22-image-${i}`,type:'node-card',x:-1000,y:350+i*350,props:{nodeType:'image',title:`参考图${i}`,mediaId:`v22-ref-${i}`,mediaPath:window.__v22Image,mediaMime:'image/svg+xml'}})
      editor.createShape({id:'shape:v22-generator',type:'node-card',x:300,y:150,props:{nodeType:'image-gen',title:'生图'}})
      createEdge(editor,{shapeId:'shape:v22-text-source',portId:'out-text'},{shapeId:'shape:v22-generator',portId:'in-text'})
      for(let i=0;i<3;i++)createEdge(editor,{shapeId:`shape:v22-image-${i}`,portId:'out-image'},{shapeId:'shape:v22-generator',portId:'in-images'})
    })
    const gen=page.locator('[data-node-type="image-gen"]')
    await page.waitForTimeout(350)
    assert.equal(await gen.locator('.reference-thumb').count(),3)
    assert.equal(await gen.locator('[data-reference-code="01T"]').count(),1)
    assert.equal(await gen.locator('.connected-input-value').count(),0)
    assert.equal(await gen.locator('.connected-input-item').evaluate(n=>n.offsetWidth),56)
    assert.ok(await gen.locator('.connected-input-item').evaluate(n=>n.querySelector('.reference-source-index').getBoundingClientRect().right<=n.querySelector('svg').getBoundingClientRect().left),'Source number precedes type icon')
    await gen.locator('[data-reference-code="01T"]').hover()
    await page.waitForSelector('.reference-fullview')
    assert.ok((await page.locator('.reference-detail').innerText()).includes('保留完整正文末尾'))
    await page.keyboard.press('Escape')
    await page.mouse.move(100,100)
    await page.screenshot({path:path.join(output,'mixed-references.png')})
    // P图 keeps inline edits, source comparison, file tools, continuations and history together.
    await page.evaluate(async()=>{
      const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
      const {createEdge}=await import('/src/canvas/graph.ts')
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      editor.createShape({id:'shape:v22-original',type:'node-card',x:-1000,y:0,props:{nodeType:'image',mediaId:'original',mediaPath:window.__v22Image,mediaMime:'image/svg+xml'}})
      const results=[1,2,3].map(i=>({mediaId:`p-result-${i}`,mediaPath:window.__v22Image,mime:'image/svg+xml',createdAt:i}))
      editor.createShape({id:'shape:v22-edit',type:'node-card',x:300,y:150,props:{nodeType:'image-edit',title:'P图',mediaId:'p-result-1',mediaPath:window.__v22Image,mediaMime:'image/svg+xml',config:JSON.stringify({instruction:'保留建筑，调整晨光。'})},meta:{nodeResult:JSON.stringify({kind:'media-source',version:1,selectedMediaId:'p-result-1',results})}})
      createEdge(editor,{shapeId:'shape:v22-original',portId:'out-image'},{shapeId:'shape:v22-edit',portId:'in-image'})
    })
    const edit=page.locator('[data-node-type="image-edit"]')
    await page.waitForTimeout(350)
    assert.equal(await edit.locator('.media-result-tile').count(),3)
    assert.equal(await edit.locator('.image-edit-inline').count(),1)
    assert.equal(await edit.locator('.node-media-next-actions button').count(),5)
    await edit.getByRole('button',{name:'对比原图',exact:true}).click()
    assert.equal(await edit.locator('.image-edit-source-compare img').count(),2)
    await page.screenshot({path:path.join(output,'p-edit-history-compare.png')})
    fs.writeFileSync(path.join(output,'errors.json'),JSON.stringify(errors,null,2))
    assert.equal(errors.length,0,JSON.stringify(errors.slice(0,2)))
    fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({measurements,startupErrors,errors,verified:['32 node initial states','header center alignment','detached ports','image actions and real edge','file callbacks','compact text reference/full detail','P图 history and comparison']},null,2))
    phase = 'generation-loading'
    await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const editor = useEditorStore.getState().editor
      editor.deleteShapes([...editor.getCurrentPageShapeIds()])
      const spec = getNodeType('image-gen')
      editor.createShape({
        id: 'shape:qa-generation', type: 'node-card', x: 400, y: 200,
        props: { nodeType: 'image-gen', title: spec.label, ...spec.defaultSize, exec: 'running' },
        meta: { nodeRun: { runId: 'qa-generation', startedAt: Date.now() - 3600000, status: 'running', inputs: {} } }
      })
    })
    const loadingCard = page.locator('.node-execution-overlay .generation-loading-card')
    await loadingCard.waitFor({ state: 'visible' })
    await loadingCard.locator('[role="progressbar"][aria-valuenow="99"]').waitFor()
    const field = loadingCard.locator('.generation-loading-field')
    // 星辰加载场：Canvas 2D 星尘，星星在 ≤600ms 内全部出现；减少动态效果时静态展示。
    const starCanvas = field.locator('canvas.generation-star-canvas')
    await starCanvas.waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const node = document.querySelector('.node-execution-overlay .generation-loading-field')
      const canvas = node?.querySelector('canvas.generation-star-canvas')
      return Boolean(
        node?.getAttribute('data-reveal') === 'done' &&
        Number(node.getAttribute('data-stars')) > 0 &&
        canvas && canvas.width > 0 && canvas.height > 0
      )
    }, null, { timeout: 5000 })
    assert.equal(await field.getAttribute('data-motion'), 'on')
    await page.screenshot({ path: path.join(output, 'image-generation-running.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => {
      const node = document.querySelector('.node-execution-overlay .generation-loading-field')
      return node?.getAttribute('data-motion') === 'off'
    }, null, { timeout: 5000 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      useEditorStore.getState().editor.updateShape({
        id: 'shape:qa-generation', type: 'node-card', props: { exec: 'idle' }
      })
    })
    await loadingCard.waitFor({ state: 'detached' })
    const executableTypes = await page.evaluate(async () => {
      const { getNodeType } = await import('/src/nodes/registry.tsx')
      const { PALETTE_NODE_GROUPS } = await import('/src/canvas/palette-categories.ts')
      return Object.values(PALETTE_NODE_GROUPS).flat().filter(type => getNodeType(type)?.executor)
    })
    assert.ok(executableTypes.length > 1)
    for (const type of executableTypes) {
      phase = 'loading:' + type
      await page.evaluate(async type => {
        const { useEditorStore } = await import('/src/stores/editor.ts')
        const { getNodeType } = await import('/src/nodes/registry.tsx')
        const editor = useEditorStore.getState().editor
        const spec = getNodeType(type)
        editor.updateShape({
          id: 'shape:qa-generation', type: 'node-card',
          props: { nodeType: type, title: spec.label, ...spec.defaultSize, config: spec.initialConfig || '', exec: 'running' }
        })
      }, type)
      await loadingCard.waitFor({ state: 'visible' })
      await page.waitForFunction(() => {
        const node = document.querySelector('.node-execution-overlay .generation-loading-field')
        const canvas = node?.querySelector('canvas.generation-star-canvas')
        return Boolean(
          canvas && canvas.width > 0 && canvas.height > 0 && Number(node.getAttribute('data-stars')) > 0
        )
      }, null, { timeout: 5000 })
      await page.evaluate(async () => {
        const { useEditorStore } = await import('/src/stores/editor.ts')
        useEditorStore.getState().editor.updateShape({
          id: 'shape:qa-generation', type: 'node-card', props: { exec: 'idle' }
        })
      })
      await loadingCard.waitFor({ state: 'detached' })
    }
    assert.deepEqual(errors, [])
    console.log('Loading state verified for ' + executableTypes.length + ' executable node types')
    phase = 'image-timing-through-executor'
    const timing = await page.evaluate(async () => {
      const { useEditorStore } = await import('/src/stores/editor.ts')
      const { useAppStore } = await import('/src/stores/app.ts')
      const { runNodeManually } = await import('/src/engine/executor.ts')
      const editor = useEditorStore.getState().editor
      const projectId = useAppStore.getState().currentProject.id
      const saved = await window.api.gateway.saveProvider({
        name: 'Timing QA', specId: 'relay', baseURL: 'https://example.com/v1',
        apiKey: 'browser-fixture', models: [{ id: 'qa-image', modality: 'image' }]
      })
      if (!saved.ok) throw new Error(saved.error.message)
      const providers = await window.api.gateway.listProviders()
      if (!providers.ok) throw new Error(providers.error.message)
      const providerKey = saved.data.id
      const modelKey = providerKey + '::qa-image'
      const id = 'shape:qa-generation'
      editor.updateShape({
        id, type: 'node-card',
        props: { nodeType: 'image-gen', exec: 'idle', text: 'QA image', config: JSON.stringify({ providerKey, modelKey, count: 1 }) },
        meta: { nodeRun: null }
      })
      const result = await runNodeManually(editor, projectId, providers.data, id)
      return { result, providerKey, modelKey }
    })
    assert.equal(timing.result.status, 'done', JSON.stringify(timing.result))
    await page.waitForFunction(async ({ providerKey, modelKey }) => {
      const timings = await window.api.workspace.getImageGenerationTimings()
      return timings.ok && timings.data.some(sample =>
        sample.providerKey === providerKey && sample.modelKey === modelKey && sample.durationMs > 0)
    }, timing)
    console.log(`Node visual system passed: ${output}`)
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
