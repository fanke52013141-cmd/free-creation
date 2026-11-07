/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const {qaOutputPath}=require('./qa-output.cjs')
const assert=require('node:assert/strict')
const {launchQaBrowser}=require('./qa-browser.cjs')
const fs=require('node:fs')
;(async()=>{const browser=await launchQaBrowser();try{
 const page=await browser.newPage({viewport:{width:1500,height:950}})
 await page.goto(process.env.CANVAS_QA_URL || 'http://127.0.0.1:5295');await page.locator('.tl-canvas').waitFor()
 const video='data:video/mp4;base64,'+fs.readFileSync('test/fixtures/agent-video.mp4').toString('base64')
 const types=await page.evaluate(async(video)=>{
 const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor
 const groups=(await import('/src/canvas/palette-categories.ts')).PALETTE_NODE_GROUPS
 editor.deleteShapes([...editor.getCurrentPageShapeIds()]);window.qaEditor=editor
 const types=[...new Set(Object.values(groups).flat())]
 types.forEach((type,i)=>editor.createShape({id:'shape:qa-'+type,type:'node-card',x:260+(i%5)*400,y:110+Math.floor(i/5)*450,props:{nodeType:type,title:type,...(type==='video-asset'?{mediaPath:video,mediaMime:'video/mp4',mediaId:'qa-video'}:{})}}))
 editor.setCamera({x:0,y:0,z:1},{immediate:true});return types
 },video)
 for(const type of types){
 await page.evaluate(async(type)=>{const editor=window.qaEditor;editor.select('shape:qa-'+type);(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().open('contract','shape:qa-'+type)},type)
 const panel=page.locator('.node-contract-panel');await panel.waitFor()
 const centers=await panel.locator('.contract-head').evaluate(head=>[head.querySelector('.side-panel-icon'),head.querySelector('strong'),head.querySelector('.side-panel-close')].map(el=>{const r=el.getBoundingClientRect();return r.y+r.height/2}))
 assert.ok(Math.max(...centers)-Math.min(...centers)<1,type+' header '+centers)
 for(const tab of ['概览','输入输出','设置','运行']){
 await panel.getByRole('tab',{name:tab,exact:true}).click()
 const clutter=panel.locator('.contract-description,.contract-rule,.contract-settings-hint:not([role]),.crop-coordinate-hint,.crop-aspect-settings>small,.tts-upload-hint')
 for(const el of await clutter.all())assert.equal(await el.isVisible(),false,type+' '+tab)
 }
 }
 await page.evaluate(async()=>{(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState().close();const editor=window.qaEditor;editor.selectNone();editor.setCamera({x:0,y:0,z:1},{immediate:true});editor.updateShape({id:'shape:qa-video-asset',type:'node-card',x:280,y:130})})
 for(const name of ['打开资产管理','打开节点库','打开历史记录','打开运行中心']){
 await page.getByRole('button',{name,exact:true}).click()
 const head=page.locator('.side-panel-head');await head.waitFor()
 const centers=await head.evaluate(el=>['.side-panel-icon','.side-panel-title','.side-panel-close'].map(selector=>{const r=el.querySelector(selector).getBoundingClientRect();return r.y+r.height/2}))
 assert.ok(Math.max(...centers)-Math.min(...centers)<1,name+' '+centers)
 await page.getByRole('button',{name:'关闭面板',exact:true}).click()
 }
 const card=page.locator('[data-node-id="shape:qa-video-asset"]');await card.waitFor()
 const geometry=await card.evaluate(el=>{const r=e=>{const b=e.getBoundingClientRect();return {y:b.y,bottom:b.bottom,height:b.height,width:b.width}};return {card:r(el),button:r(el.querySelector('.media-action-button')),preview:r(el.querySelector('.node-media')),body:r(el.querySelector('.node-standard-scroll')),footer:!!el.querySelector('.node-standard-action-bar .media-action-toolbar')}})
 assert.equal(geometry.footer,true)
 assert.ok(Math.abs(geometry.card.bottom-geometry.button.bottom-8)<1.1,JSON.stringify(geometry))
 assert.ok(Math.abs(geometry.preview.width/geometry.preview.height-16/9)<.01)
 const bodyMid=(geometry.body.y+12+geometry.body.bottom)/2
 assert.ok(Math.abs(geometry.preview.y+geometry.preview.height/2-bodyMid)<1.1,JSON.stringify(geometry))
 await page.screenshot({path:qaOutputPath('qa/video-footer-centered.png')})
 console.log('All '+types.length+' node panel headers/tabs and video footer/center passed',geometry)
 }finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)})
