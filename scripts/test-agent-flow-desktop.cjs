/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { qaOutputPath } = require('./qa-output.cjs')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, basename, dirname } = require('node:path')
// A distinct, valid PNG encoding makes all three ordered reference slots observable.
function thirdReferencePng(source) {
  const body=Buffer.from('tEXtfixture\0reference-three'),chunk=Buffer.alloc(body.length+8)
  chunk.writeUInt32BE(body.length-4,0);body.copy(chunk,4)
  let crc=0xffffffff
  for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4)
  return Buffer.concat([source.subarray(0,-12),chunk,source.subarray(-12)])
}
const parallelReview = process.argv.includes('--parallel-review')
const parallelMedia = parallelReview || process.argv.includes('--parallel-media')
if(parallelMedia && process.argv.includes('--real-model'))throw new Error('PARALLEL_FIXTURE_ONLY')
if(parallelMedia&&!process.env.CANVAS_AGENT_EVIDENCE_DIR)process.env.CANVAS_AGENT_EVIDENCE_DIR=parallelReview?'qa/agent-parallel-review-20261016/desktop':'qa/agent-parallel-media-20261015/desktop'
const mediaReview = process.argv.includes('--media-review')
if(mediaReview&&process.argv.includes('--real-model'))throw new Error('MEDIA_REVIEW_FIXTURE_ONLY')
if(mediaReview&&!process.env.CANVAS_AGENT_EVIDENCE_DIR)process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-media-review-20261016/desktop'
const videoRework = process.argv.includes('--video-rework')
const videoReview = parallelReview || videoRework || process.argv.includes('--video-review')
const real = process.argv.includes('--real-model')
if(videoReview&&real)throw new Error('VIDEO_REVIEW_FIXTURE_ONLY')
if(videoReview&&!process.env.CANVAS_AGENT_EVIDENCE_DIR)process.env.CANVAS_AGENT_EVIDENCE_DIR=videoRework?'qa/agent-video-rework-20261015/desktop':'qa/agent-video-review-20261015/desktop'
const multiReference = process.argv.includes('--video-multi-reference')
if(multiReference&&!process.env.CANVAS_AGENT_EVIDENCE_DIR)process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-multi-reference-20261016/desktop'
const mediaTransfer = multiReference || process.argv.includes('--media-transfer')
const audioReference = mediaTransfer || process.argv.includes('--video-audio-reference')
const motionReference = mediaTransfer || process.argv.includes('--video-motion-reference')
const referenceImages = mediaTransfer || process.argv.includes('--video-reference-images')
const lastFrame = referenceImages || process.argv.includes('--video-first-last-frame')
const firstFrame = lastFrame || process.argv.includes('--video-first-frame')
const video = audioReference || motionReference || firstFrame || process.argv.includes('--video')
if(video && real) throw new Error('VIDEO_ACCEPTANCE_FIXTURE_ONLY')
if(video && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR=mediaTransfer ? 'qa/agent-audio-media-transfer-20261015/desktop' : audioReference ? 'qa/agent-audio-reference-20261015/desktop' : motionReference ? 'qa/agent-video-motion-20261015/desktop' : referenceImages ? 'qa/agent-video-reference-20261015/desktop' : lastFrame ? 'qa/agent-video-first-last-frame-20261015/desktop' : firstFrame ? 'qa/agent-video-first-frame-20261015/desktop' : 'qa/agent-video-20261015/desktop'
const collaboration = process.argv.includes('--collaboration')
const recovery = process.argv.includes('--recovery')
const coordination = process.argv.includes('--coordination') || recovery
if (recovery && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR = 'qa/canvas-agent-flow/C4/desktop-recovery-fixture'
const builderParallel = process.argv.includes('--builder-parallel')
const builder = process.argv.includes('--builder') || builderParallel
if (builderParallel && !process.env.CANVAS_AGENT_EVIDENCE_DIR)
  process.env.CANVAS_AGENT_EVIDENCE_DIR = 'qa/agent-builder-parallel-20261016/desktop'
const review = process.argv.includes('--review') || videoReview || mediaReview
const rework = process.argv.includes('--rework')
const reworkModeArgument = process.argv.find(arg => arg.startsWith('--rework-mode='))
if (reworkModeArgument) process.env.CANVAS_AGENT_REWORK_MODE = reworkModeArgument.split('=')[1]
if (rework && !['autonomous', 'collaborative', 'manual'].includes(process.env.CANVAS_AGENT_REWORK_MODE || 'autonomous')) throw new Error('AGENT_REWORK_MODE_INVALID')
async function cleanDirectory(directory) {
  if (resolve(directory, '..') !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-flow-agent-')) throw new Error('AGENT_CLEANUP_REJECTED')
  await rm(directory, { recursive: true, force: true })
}
if (process.argv.slice(2).some(arg => !['--real-model','--collaboration','--coordination','--builder','--builder-parallel','--review','--rework','--recovery','--video','--video-first-frame','--video-first-last-frame','--video-reference-images','--video-motion-reference','--video-audio-reference','--media-transfer','--video-review','--media-review','--video-rework','--parallel-media','--parallel-review','--video-multi-reference'].includes(arg) && arg !== reworkModeArgument)) throw new Error('AGENT_TEST_ARGUMENT_INVALID')
if (real && (!process.env.CANVAS_AGENT_PROBE_KEY || !process.env.CANVAS_AGENT_PROBE_MODEL)) throw new Error('AGENT_REAL_CREDENTIAL_REQUIRED')
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-agent-'))
  const evidence = qaOutputPath(process.env.CANVAS_AGENT_EVIDENCE_DIR || `qa/canvas-agent-flow/C3/desktop-${rework ? 'rework-' + (process.env.CANVAS_AGENT_REWORK_MODE || 'autonomous') + '-' : review ? 'review-' : builder ? 'builder-' : coordination ? 'coordination-' : collaboration ? 'collaboration-' : ''}${real ? 'real' : 'fixture'}`)
  if (!evidence.startsWith(resolve('qa') + require('node:path').sep)) throw new Error('AGENT_EVIDENCE_PATH_INVALID')
  await mkdir(evidence, { recursive: true })
  let requests = 0
  const provider = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      if (++requests > 40 || body.length > 300000) throw new Error('FIXTURE_BUDGET')
      const json = JSON.parse(body)
      if (!json.tools?.length) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end('data: '+JSON.stringify({ id:'discussion',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:'private-c3-discussion-reply'},finish_reason:null}] })+'\n\ndata: '+JSON.stringify({id:'discussion',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
        return
      }
      let name, args
      const names = json.tools.map(tool => tool.function.name)
      if (names.includes('probe_echo') || names.includes('probe_done')) {
        name = names[0]; args = name === 'probe_done'
          ? JSON.parse(json.messages.find(message => message.role === 'tool').content)
          : { marker: 'probe-ok', count: 7 }
      } else {
        const userContent = json.messages.filter(message => message.role === 'user').at(-1).content
        const input = names.includes('review_assets') ? {subjects:[{kind:'text',text:userContent}]} : JSON.parse(userContent)
        if (names.includes('review_assets') && mediaReview) {
          const content=Array.isArray(userContent)?userContent:[]
          const text=content.filter(part=>part.type==='text').map(part=>part.text).join('\n')
          const strings=[];const visit=value=>{if(typeof value==='string')strings.push(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit)};visit(userContent)
          const mode=text.includes('图像对象 0')?'image':text.includes('音频对象 0')?'audio':text.includes('音视频对象 0')?'audio-video':null
          if(!mode)throw new Error('MEDIA_REVIEW_MODE_TEXT_MISSING')
          const decodeData=raw=>{try{return Buffer.from(raw,'base64')}catch{return Buffer.alloc(0)}}
          const data=strings.flatMap(value=>{const match=value.match(/base64,([A-Za-z0-9+/=]+)/);if(match)return [match[1]];return /^[A-Za-z0-9+/]+={0,2}$/.test(value)&&value.length>256?[value]:[]})
          const hasWav=data.some(raw=>{const bytes=decodeData(raw);return bytes.length>1000&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'})
          const pngs=strings.filter(value=>value.startsWith('data:image/png;base64,'))
          const jpegs=strings.filter(value=>value.startsWith('data:image/jpeg;base64,'))
          if(mode==='image'&&(!pngs.length||decodeData(pngs[0].split(',')[1]).length<50))throw new Error('MEDIA_REVIEW_FULL_IMAGE_BYTES_MISSING')
          if(mode==='audio'&&!hasWav)throw new Error('MEDIA_REVIEW_FULL_AUDIO_BYTES_MISSING')
          if(mode==='audio-video'&&(!hasWav||jpegs.length!==4||!text.includes('时间线摘要')||!text.includes('不代表逐帧视觉判断')))throw new Error('MEDIA_REVIEW_AUDIO_VIDEO_EVIDENCE_MISSING')
          name='review_assets';args={passed:true,feedback:mode==='audio-video'?'完整音轨和全部帧时间戳摘要已接收，画面判断仍仅基于四个抽样画面。':mode==='audio'?'完整固定音轨已接收。':'完整固定图片字节已接收。',issues:[]}
        } else if (names.includes('review_assets') && videoReview) {
          const pictures=userContent.filter(part=>part.type==='image_url');if(pictures.length!==4||pictures.some(part=>!part.image_url.url.startsWith('data:image/jpeg;base64,')))throw new Error('VISUAL_IMAGES_MISSING');
          const {loadImage,createCanvas}=require('@napi-rs/canvas');let passed=true;for(const picture of pictures){const decoded=await loadImage(Buffer.from(picture.image_url.url.split(',')[1],'base64'));if(decoded.width>640||decoded.height>640)throw new Error('VISUAL_IMAGE_TOO_LARGE');const canvas=createCanvas(1,1),context=canvas.getContext('2d');context.drawImage(decoded,0,0,1,1);const pixel=context.getImageData(0,0,1,1).data;if(pixel[0]<pixel[2]+50)passed=false;}name='review_assets';args={passed,feedback:passed?'四个抽样画面均为红色；未审核声音和完整时序。':'抽样画面不是红色，请人工替换视频再复审。',issues:passed?[]:[{subjectIndex:0,feedback:'替换红色画面视频'}]};
        } else if (names.includes('review_assets')) { const passed=input.subjects.every(v=>v.text?.startsWith('整理：')||v.text?.startsWith('交付：'));name='review_assets';args={passed,feedback:passed?'标准满足':'缺少要求的交付前缀。',issues:passed?[]:[{subjectIndex:0,feedback:'补齐要求的交付前缀。'}]}; } else if (names.includes('propose_flow')) { name='propose_flow'; args=builderParallel ? {title:'并行文本分支',topology:'parallel-fork',steps:[{title:'整理摘要',goal:'用授权处理节点为材料生成摘要。',mode:'autonomous',capability:'text-template@1',template:'摘要：{{value}}'},{title:'整理要点',goal:'用授权处理节点为材料提取要点。',mode:'autonomous',capability:'text-template@1',template:'要点：{{value}}'},{title:'整理标签',goal:'用授权处理节点为材料生成标签。',mode:'autonomous',capability:'text-template@1',template:'标签：{{value}}'}]} : { title:'整理交付流程', steps:[{title:'整理',goal:'使用授权的数据处理节点添加整理标题，再交付真实资产。',mode:'autonomous',template:'整理：{{value}}',review:{criteria:'整理结果必须保留来源材料的事实。',rejectPolicy:'rework',maxReworks:1}},{title:'交付',goal:'使用授权的数据处理节点添加交付标题，再交付真实资产。',mode:'autonomous',template:'交付：{{value}}'}] }; } else if (names.includes('dispatch_agent')) {
          if((parallelMedia||builderParallel)&&names.includes('dispatch_parallel')&&input.available.length>=2&&input.available.length<=4){name='dispatch_parallel';args={assignments:input.available.map(candidate=>({nodeId:candidate.nodeId,goal:candidate.goal,completion:'完成已授权的独立分支并交付固定成果',inputs:candidate.inputs}))}}else {
          const candidate = input.available[0]
          if (candidate) { name = 'dispatch_agent'; args = { nodeId: candidate.nodeId, goal: candidate.goal, completion: video ? '完成一次视频生成并交付固定视频版本' : '完成两次公共处理，固定真实成果', inputs: candidate.inputs } }
          else { name = 'finish_flow'; args = { outputs: input.completed.at(-1).outputs } }
          }
        } else {
        if (!input.directInputs?.length || !input.fixedInputs?.length) throw new Error('FIXTURE_DECLARED_INPUT_MISSING')
        if (input.goal === 'cancel-fixture') await new Promise(done => setTimeout(done, 10000))
        if (input.skills.length && !Object.keys(input.loaded).length) { name = 'load_skill'; args = { skillId: 'result-check' } }
        else if (input.receipts.length < ((video||videoRework||parallelMedia||builderParallel) ? 1 : 2)) { name = 'execute_node'; args = { targetNodeId: input.rework && !videoRework && !parallelReview ? input.targets.find(target => target.nodeId === 'shape:rw-repair').nodeId : input.targets[0].nodeId, ...((videoRework||parallelReview)&&input.rework?.videoTargetNodeId?{prompt:'private-c3-revision-proposal：场景改为红色，保持原参考素材。'}:{}) } }
        else if (input.mode === 'collaborative' && !input.humanAccepted) { name = 'wait_for_human'; args = {} }
        else { name = 'finish_task'; args = { outputs: input.selectedOutputs?.length ? input.selectedOutputs : input.receipts.at(-1).outputRefs } }
        }
      }
      const chunks = [{ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
    } catch { response.writeHead(400); response.end('{}') }
  })
  const server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { stdio: 'ignore', windowsHide: true })
  const reports = [], events = []
  const videoPrefix=(video||videoReview||parallelMedia) ? (await readFile(resolve('test/fixtures/agent-video.mp4'))).subarray(0,32).toString('base64') : null
  try {
    if(firstFrame) await writeFile(join(directory,'first-frame.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYawAAAAASUVORK5CYII=','base64'))
    if(lastFrame) await writeFile(join(directory,'last-frame.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'))
    if(referenceImages) await writeFile(join(directory,'reference-third.png'),thirdReferencePng(await readFile(join(directory,'first-frame.png'))))
    if(audioReference) await cp(resolve('test/fixtures/agent-audio.wav'),join(directory,'reference.wav'))
    if(multiReference){await cp(resolve('test/fixtures/agent-review-red.mp4'),join(directory,'motion-second.mp4'));const sound=await readFile(resolve('test/fixtures/agent-audio.wav'));sound[sound.length-1]^=1;await writeFile(join(directory,'reference-second.wav'),sound);}
    if(videoReview){await cp(resolve('test/fixtures/agent-video.mp4'),join(directory,'review-blue.mp4'));await cp(resolve('test/fixtures/agent-review-red.mp4'),join(directory,'review-red.mp4'));}
    if(parallelMedia) await cp(resolve('test/fixtures/agent-video.mp4'),join(directory,'parallel.mp4'))
    if(video) await cp(resolve('test/fixtures/agent-video.mp4'),join(directory,'fixture.mp4'))
    if (!real) await new Promise((done, reject) => { provider.once('error', reject); provider.listen(5200, '127.0.0.1', done) })
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('AGENT_VITE_UNAVAILABLE')
      try { if ((await fetch('http://127.0.0.1:5199')).ok) break } catch { /* Bounded readiness. */ }
      if (Date.now() > deadline) throw new Error('AGENT_VITE_TIMEOUT')
      await new Promise(done => setTimeout(done, 250))
    }
    for (const phase of ['execute', 'reopen']) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const code = await new Promise((done, reject) => {
        const child = spawn(require('electron'), [resolve('out/main/agent-flow-desktop.js'), `--agent-directory=${directory}`, `--agent-phase=${phase}`, ...(real ? ['--real-model'] : []), ...(collaboration ? ['--collaboration'] : []), ...(coordination ? ['--coordination'] : []), ...(builder ? ['--builder'] : []), ...(builderParallel ? ['--builder-parallel'] : []), ...(review ? ['--review'] : []), ...(rework ? ['--rework'] : []), ...(recovery ? ['--recovery'] : []), ...(video ? ['--video'] : []), ...(firstFrame ? ['--video-first-frame'] : []), ...(lastFrame ? ['--video-first-last-frame'] : []), ...(referenceImages ? ['--video-reference-images'] : []), ...(motionReference ? ['--video-motion-reference'] : []), ...(videoReview ? ['--video-review'] : []), ...(mediaReview ? ['--media-review'] : []), ...(videoRework ? ['--video-rework'] : []), ...(parallelMedia ? ['--parallel-media'] : []), ...(parallelReview ? ['--parallel-review'] : []), ...(mediaTransfer ? ['--media-transfer'] : []), ...(multiReference ? ['--video-multi-reference'] : []), ...(audioReference ? ['--video-audio-reference'] : [])],
          { env, stdio: 'ignore', windowsHide: true })
        const timer = setTimeout(() => { child.kill(); reject(new Error('AGENT_ELECTRON_TIMEOUT')) }, 240000)
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('exit', code => { clearTimeout(timer); done(code) })
      })
      const report = JSON.parse(await readFile(join(directory, `${phase}-report.json`), 'utf8'))
      await writeFile(join(evidence, `${phase}-report.json`), JSON.stringify(report, null, 2))
      reports.push(report)
      if(parallelReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,'parallel-review.png'),join(evidence,'parallel-review.png'))
      if(parallelMedia&&!parallelReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,'parallel-media.png'),join(evidence,'parallel-media.png'))
      if(mediaReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,'media-review.png'),join(evidence,'media-review.png'))
      if(videoReview&&!parallelReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,'video-review.png'),join(evidence,'video-review.png'))
      if(video && phase==='reopen' && report.status==='pass') {
        await cp(join(directory,'video-fixed.png'),join(evidence,'video-fixed.png'))
        if(audioReference) await cp(join(directory,'audio-fixed.png'),join(evidence,'audio-fixed.png'))
        if(firstFrame) await cp(join(directory,'image-fixed.png'),join(evidence,'image-fixed.png'))
        if(mediaTransfer) await cp(join(directory,'media-imported.png'),join(evidence,'media-imported.png'))
      }
      if (code !== 0 || report.status !== 'pass') {
        await cp(join(directory,'pointer-debug.json'),join(evidence,'pointer-debug.json')).catch(()=>{})
        await cp(join(directory,'pointer-failure.png'),join(evidence,'pointer-failure.png')).catch(()=>{})
        await scan(join(directory, 'diagnostics'))
        await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
        await writeFile(join(evidence, 'failure-reasons.json'), JSON.stringify(events.filter(event => event.event.endsWith('.failed')).map(event => ({ event: event.event, phase: event.attributes?.phase, action: event.attributes?.action, code: event.attributes?.code || event.error?.code })), null, 2))
        throw new Error(`AGENT_${phase.toUpperCase()}_${report.report?.code || 'FAILED'}`)
      }
    }
    async function scan(path) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        const target = join(path, file.name)
        if (file.isDirectory()) await scan(target)
        else {
          const text = await readFile(target, 'utf8')
          if (text.includes('private-c3') || text.includes('data:image/') || text.includes('data:video/') || text.includes('data:audio/') || text.includes('/9j/') || text.includes('UklGR') || (videoPrefix && text.includes(videoPrefix)) || text.includes('iVBORw0KGgoAAAANSUhEUg') || (process.env.CANVAS_AGENT_PROBE_KEY && text.includes(process.env.CANVAS_AGENT_PROBE_KEY))) throw new Error('AGENT_DIAGNOSTICS_REDACTION_FAILED')
          if (file.name.endsWith('.jsonl')) for (const line of text.trim().split('\n')) if (line.trim()) events.push(JSON.parse(line))
        }
      }
    }
    await scan(join(directory, 'diagnostics'))
    if(videoReview||mediaReview||parallelMedia||multiReference) await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    const started = events.filter(event => event.event === 'agent.desktop.started')
    const ended = events.filter(event => ['agent.desktop.completed', 'agent.desktop.failed'].includes(event.event))
    if (!started.length || started.length !== ended.length) throw new Error('AGENT_DESKTOP_LIFECYCLE_FAILED')
    for (const event of started) if (ended.filter(end => end.traceId === event.traceId && end.spanId === event.spanId).length !== 1) throw new Error('AGENT_DESKTOP_TERMINAL_DUPLICATED')
    if(videoReview||mediaReview||parallelMedia||multiReference) {
      for(const [name,terminals] of [['node',['completed','failed','cancelled','skipped']],['workflow',['completed','failed','cancelled']],['model.request',['completed','failed']],['project.save',['completed','failed','conflict']]]) {
        const inScope=event=>name!=='model.request'||event.attributes?.operation!=='video.generate'
        const starts=events.filter(event=>event.event===name+'.started'&&inScope(event)), ends=events.filter(event=>terminals.some(terminal=>event.event===name+'.'+terminal)&&inScope(event))
        const same=(start,end)=>name==='model.request'?start.requestId===end.requestId:start.traceId===end.traceId&&start.spanId===end.spanId
        if(!starts.length||starts.length!==ends.length||starts.some(start=>ends.filter(end=>same(start,end)).length!==1)){
          if(name==='node'){
            await cp(join(directory,'diagnostics'),join(evidence,'diagnostics'),{recursive:true}).catch(()=>{})
            const fields=['event','sessionId','traceId','spanId','parentSpanId','nodeId','nodeExecutionId','runId','status','correlationMissing']
            const lifecycle=events.filter(event=>event.event==='node.started'||terminals.some(terminal=>event.event==='node.'+terminal)).map(event=>Object.fromEntries(fields.filter(field=>event[field]!==undefined).map(field=>[field,event[field]])))
            await writeFile(join(evidence,'node-lifecycle-snapshot.json'),JSON.stringify({started:starts.length,terminal:ends.length,lifecycle},null,2))
          }
          throw new Error('VIDEO_REVIEW_TERMINAL_UNPAIRED_'+name.toUpperCase().replaceAll('.','_'))
        }
        if(name==='project.save'&&starts.some(start=>start.correlationMissing||!start.projectId||!start.traceId||!start.spanId))throw new Error('PROJECT_SAVE_CONTEXT_MISSING')
      }
      if(mediaReview&&events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='agent.review').length!==3)throw new Error('MEDIA_REVIEW_UNEXPECTED_MODEL_REPLAY')
      if(videoReview&&events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='agent.review').length!==(parallelReview?4:2))throw new Error('VIDEO_REVIEW_UNEXPECTED_MODEL_REPLAY')
      if(multiReference){const posts=events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='video.generate');if(posts.length!==1||events.filter(event=>event.event==='model.request.accepted'&&event.requestId===posts[0].requestId).length!==1)throw new Error('MULTI_REFERENCE_SUBMIT_DIAGNOSTICS_INVALID')}
      if(parallelMedia){const posts=events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='video.generate');if(posts.length!==4||posts.some(post=>events.filter(event=>event.event==='model.request.accepted'&&event.requestId===post.requestId).length!==1))throw new Error('PARALLEL_SUBMIT_DIAGNOSTICS_INVALID')}
      if(videoRework){const posts=events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='video.generate');if(posts.length!==2||posts.some(post=>events.filter(event=>event.event==='model.request.accepted'&&event.requestId===post.requestId).length!==1))throw new Error('VIDEO_REWORK_SUBMIT_DIAGNOSTICS_INVALID')}
      if(multiReference||parallelMedia||videoRework){
        const posts=events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='video.generate')
        for(const post of posts){
          const accepted=events.find(event=>event.event==='model.request.accepted'&&event.requestId===post.requestId)
          if(!accepted||!accepted.taskId||accepted.traceId!==post.traceId||accepted.spanId!==post.spanId)throw new Error('ASYNC_MEDIA_ACCEPTANCE_CONTEXT_INVALID')
          const related=events.filter(event=>event.taskId===accepted.taskId&&!event.correlationMissing&&(/^(task|media)\./.test(event.event)))
          if(!related.some(event=>event.event==='task.state_changed'&&event.attributes?.state==='running'))throw new Error('ASYNC_MEDIA_TASK_CONTEXT_MISSING')
          if(related.some(event=>event.traceId!==post.traceId||event.spanId!==post.spanId||event.requestId!==post.requestId))throw new Error('ASYNC_MEDIA_CONTEXT_DRIFT')
          for(const started of related.filter(event=>['media.download_started','media.persist_started'].includes(event.event))){
            const prefix=started.event.slice(0,started.event.lastIndexOf('_'))
            const endings=related.filter(event=>event.event===prefix+'_completed'||event.event===prefix+'_failed')
            if(endings.length!==1)throw new Error('ASYNC_MEDIA_TERMINAL_UNPAIRED_'+prefix.toUpperCase().replaceAll('.','_'))
          }
        }
      }
    }
    if (((!builder && !review && !rework) || videoRework || parallelReview) && !events.some(event => event.event === 'agent.runtime.resumed' && event.attributes?.resumesTraceId)) throw new Error('AGENT_RESUME_TRACE_MISSING')
    if (recovery || mediaTransfer) {
      const transfers = events.filter(event => event.event === 'project.transfer.started')
      if (transfers.length !== 2) throw new Error('C4_TRANSFER_LIFECYCLE_MISSING')
      for (const event of transfers) if (events.filter(end => ['project.transfer.committed', 'project.transfer.failed'].includes(end.event) && end.traceId === event.traceId && end.spanId === event.spanId).length !== 1) throw new Error('C4_TRANSFER_TERMINAL_INVALID')
    }
    if (recovery) {
      const reconciled = events.filter(event => event.event === 'agent.coordination.started' && event.attributes?.phase === 'reconcile')
      if (reconciled.length !== 1 || !reconciled[0].attributes?.resumesTraceId) throw new Error('C4_RECONCILE_TRACE_MISSING')
      for (const event of reconciled) if (events.filter(end => ['agent.coordination.completed', 'agent.coordination.failed'].includes(end.event) && end.traceId === event.traceId && end.spanId === event.spanId).length !== 1) throw new Error('C4_RECONCILE_TERMINAL_INVALID')
    }
    await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    const modelRequests = events.filter(event => event.event === 'model.request.started').length
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ reports, modelRequests, diagnosticSessionIds: [...new Set(events.map(event=>event.sessionId))], diagnosticRedaction: true,
      boundary: 'real desktop canvas/executor/IPC/model catalog/SDK/two process checkpoint/fixed assets', model: real ? process.env.CANVAS_AGENT_PROBE_MODEL : 'synthetic fixture' }, null, 2))
    process.stdout.write(parallelReview ? 'Parallel sampled review desktop: overlapping initial videos, two independent reworks, unknown/reopen join, four POSTs/four downloads, dual review gates and diagnostics passed.\n' : parallelMedia ? 'Parallel media desktop: overlapping supplier submissions, partial success, unknown/reopen recovery, stop/reservations and diagnostics passed.\n' : mediaReview ? 'Media review desktop: complete image bytes, complete normalized audio, A/V timeline and four visual samples survive a two-process reopen with no model replay.\n' : videoRework ? 'Video bounded rework desktop: negative sampled review, feedback-bound new task, unknown/reopen recovery, two POSTs/two downloads, approved downstream and diagnostics passed.\n' : videoReview ? 'Video sampled review desktop: negative gate, reopen/reuse, manual replacement, four real JPEGs, approved downstream extraction and diagnostics passed.\n' : multiReference ? 'Agent multi-reference video desktop: ordered image/video/audio references, prompt bundle, unknown/reopen/continue, fixed media and diagnostics passed.\n' : video ? 'Agent video desktop: main dispatch, unknown/reopen/explicit continue, one supplier task, one download, fixed playable video asset and diagnostics passed.\n' : `Agent desktop ${real ? 'real model' : 'fixture'}: start, two tools, human wait/reopen/continue, declared fixed assets and diagnostics passed.\n`)
  } finally {
    try {
      server.kill()
      await new Promise((done, reject) => {
        if (server.exitCode !== null || server.signalCode !== null) return done()
        const timer = setTimeout(() => reject(new Error('AGENT_VITE_CLEANUP_FAILED')), 5000)
        server.once('exit', () => { clearTimeout(timer); done() })
      })
    } finally {
      provider.closeAllConnections(); provider.close()
      await cleanDirectory(directory)
    }
  }
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
