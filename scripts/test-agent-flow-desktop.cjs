/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { qaOutputPath } = require('./qa-output.cjs')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, basename, dirname } = require('node:path')

function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const probe = require('node:net').createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('AGENT_VITE_PORT_RESERVATION_FAILED')))
        return
      }
      const port = address.port
      probe.close((error) => {
        if (error) reject(error)
        else resolvePort(port)
      })
    })
  })
}
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
const parallelQueueMedia = process.argv.includes('--parallel-queue-media')
const parallelMedia = parallelReview || process.argv.includes('--parallel-media') || parallelQueueMedia
const parallelMediaForcedExit = process.argv.includes('--parallel-media-forced-exit') || process.argv.includes('--parallel-queue-media-forced-exit')
if (parallelMediaForcedExit && (!parallelMedia || parallelReview || process.argv.includes('--real-model'))) throw new Error('PARALLEL_FORCED_EXIT_FIXTURE_ONLY')
if(parallelMedia && process.argv.includes('--real-model'))throw new Error('PARALLEL_FIXTURE_ONLY')
if(parallelMedia&&!process.env.CANVAS_AGENT_EVIDENCE_DIR)process.env.CANVAS_AGENT_EVIDENCE_DIR=parallelReview?'qa/agent-parallel-review-20261016/desktop':parallelQueueMedia?'qa/agent-comprehensive/run-20261017-par07-queue-forced-exit-v1':'qa/agent-parallel-media-20261015/desktop'
const mediaReview = process.argv.includes('--media-review')
if(mediaReview&&process.argv.includes('--real-model'))throw new Error('MEDIA_REVIEW_FIXTURE_ONLY')
if(mediaReview&&!process.env.CANVAS_AGENT_EVIDENCE_DIR)process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-media-review-20261016/desktop'
const videoRework = process.argv.includes('--video-rework')
const videoReview = parallelReview || videoRework || process.argv.includes('--video-review')
const real = process.argv.includes('--real-model')
const run06Fault = process.argv.includes('--agent-run06-fault')
if (run06Fault && real) throw new Error('RUN06_FAULT_FIXTURE_ONLY')
if (run06Fault && !process.env.CANVAS_AGENT_EVIDENCE_DIR)
  process.env.CANVAS_AGENT_EVIDENCE_DIR = 'qa/agent-comprehensive/run-20261017-agent-run06-desktop-fault-v1'
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
const agentHum07Pause = process.argv.includes('--agent-hum07-pause')
const agentGate = process.argv.includes('--agent-gate')
const agentUnknown = process.argv.includes('--agent-unknown')
const agentOutputSet = process.argv.includes('--agent-output-set')
const agentFixedInputVersion = process.argv.includes('--agent-fixed-input-version')
const agentResidency = process.argv.includes('--agent-residency')
const agentPerfMatrix = process.argv.includes('--agent-perf-matrix')
const agentPanelChurn = process.argv.includes('--agent-panel-churn')
const agentPanelChurnHeapSnapshot =
  agentPanelChurn && process.env.CANVAS_AGENT_PANEL_CHURN_HEAP_SNAPSHOT === '1'
const residencySeconds = Number(process.env.CANVAS_AGENT_RESIDENCY_SECONDS || '7200')
if (agentGate && process.argv.includes('--real-model')) throw new Error('AGENT_GATE_FIXTURE_ONLY')
if (agentGate && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-cmd08-agent-gate-20261017/desktop'
if (agentUnknown && process.argv.includes('--real-model')) throw new Error('AGENT_UNKNOWN_FIXTURE_ONLY')
if (agentUnknown && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-cmd08-unknown-agent-footer-20261017/desktop'
if (agentOutputSet && process.argv.includes('--real-model')) throw new Error('AGENT_OUTPUT_SET_FIXTURE_ONLY')
if (agentOutputSet && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-comprehensive/run-20261017-ast05-output-set-desktop'
if (agentFixedInputVersion && process.argv.includes('--real-model')) throw new Error('AGENT_FIXED_INPUT_VERSION_FIXTURE_ONLY')
if (agentFixedInputVersion && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-comprehensive/run-20261017-ast01-fixed-input-desktop'
if (agentResidency && process.argv.includes('--real-model')) throw new Error('AGENT_RESIDENCY_FIXTURE_ONLY')
if (agentResidency && (!Number.isInteger(residencySeconds) || residencySeconds < 60 || residencySeconds > 7200)) throw new Error('AGENT_RESIDENCY_DURATION_INVALID')
if (agentResidency && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-residency-per01-20261017/desktop'
if (agentPerfMatrix && process.argv.includes('--real-model')) throw new Error('AGENT_PERF_MATRIX_FIXTURE_ONLY')
if (agentPerfMatrix && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-comprehensive/run-20261018-per02-interaction-matrix-v1'
if (agentPanelChurn && process.argv.includes('--real-model')) throw new Error('AGENT_PANEL_CHURN_FIXTURE_ONLY')
if (agentPanelChurn && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-panel-churn-per04-20261017/desktop'
if (agentHum07Pause && !process.env.CANVAS_AGENT_EVIDENCE_DIR) process.env.CANVAS_AGENT_EVIDENCE_DIR='qa/agent-comprehensive/run-20261017-agent-hum07-pause-stop-desktop-v1'
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
if (run06Fault && (agentGate || agentUnknown || agentOutputSet || agentFixedInputVersion || agentResidency || agentPerfMatrix || agentPanelChurn || collaboration || coordination || builder || review || rework || recovery || video || parallelMedia || multiReference)) throw new Error('RUN06_TEST_MODE_CONFLICT')
if (agentHum07Pause && (!coordination || recovery || collaboration || builder || review || rework || video || parallelMedia || multiReference || agentGate || agentUnknown || agentOutputSet || agentFixedInputVersion || agentResidency || agentPanelChurn || run06Fault)) throw new Error('HUM07_TEST_MODE_CONFLICT')
async function cleanDirectory(directory) {
  if (resolve(directory, '..') !== resolve(tmpdir()) || !basename(directory).startsWith('canvas-flow-agent-')) throw new Error('AGENT_CLEANUP_REJECTED')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(String(code)) || attempt === 4) throw error
      await new Promise(done => setTimeout(done, 150))
    }
  }
}
if ((agentGate && agentUnknown) || (agentOutputSet && (agentGate || agentUnknown || agentResidency || agentPerfMatrix || agentPanelChurn || collaboration || coordination || builder || review || rework || recovery || video || parallelMedia || multiReference || agentFixedInputVersion)) || (agentFixedInputVersion && (agentGate || agentUnknown || agentResidency || agentPerfMatrix || agentPanelChurn || collaboration || coordination || builder || review || rework || recovery || video || parallelMedia || multiReference)) || (agentResidency && (agentGate || agentUnknown || agentPerfMatrix || agentPanelChurn)) || (agentPerfMatrix && (agentGate || agentUnknown || agentResidency || agentPanelChurn || collaboration || coordination || builder || review || rework || recovery || video || parallelMedia || multiReference || run06Fault || agentHum07Pause)) || (agentPanelChurn && (agentGate || agentUnknown || agentPerfMatrix || collaboration || coordination || builder || review || rework || recovery || video || parallelMedia || multiReference))) throw new Error('AGENT_TEST_MODE_CONFLICT')
if (process.argv.slice(2).some(arg => !['--real-model','--collaboration','--coordination','--builder','--builder-parallel','--review','--rework','--recovery','--video','--video-first-frame','--video-first-last-frame','--video-reference-images','--video-motion-reference','--video-audio-reference','--media-transfer','--video-review','--media-review','--video-rework','--parallel-media','--parallel-review','--parallel-media-forced-exit','--parallel-queue-media','--parallel-queue-media-forced-exit','--video-multi-reference','--agent-gate','--agent-unknown','--agent-output-set','--agent-fixed-input-version','--agent-residency','--agent-perf-matrix','--agent-panel-churn','--agent-run06-fault','--agent-hum07-pause'].includes(arg) && arg !== reworkModeArgument)) throw new Error('AGENT_TEST_ARGUMENT_INVALID')
if (real && (!process.env.CANVAS_AGENT_PROBE_KEY || !process.env.CANVAS_AGENT_PROBE_MODEL)) throw new Error('AGENT_REAL_CREDENTIAL_REQUIRED')
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-flow-agent-'))
  const evidence = qaOutputPath(process.env.CANVAS_AGENT_EVIDENCE_DIR || `qa/canvas-agent-flow/C3/desktop-${rework ? 'rework-' + (process.env.CANVAS_AGENT_REWORK_MODE || 'autonomous') + '-' : review ? 'review-' : builder ? 'builder-' : coordination ? 'coordination-' : collaboration ? 'collaboration-' : ''}${real ? 'real' : 'fixture'}`)
  if (!evidence.startsWith(resolve('qa') + require('node:path').sep)) throw new Error('AGENT_EVIDENCE_PATH_INVALID')
  await mkdir(evidence, { recursive: true })
  if (agentPerfMatrix) {
    for (const name of await readdir(evidence))
      if (['diagnostics', 'execute-report.json', 'results.json', 'failure-reasons.json', 'agent-perf-progress.json'].includes(name) || /^agent-perf-(matrix\.json|failure\.png|10\.png|50\.png|100\.png)$/.test(name))
        await rm(join(evidence, name), { recursive: true, force: true })
  }
  let requests = 0
  let run06FaultRequests = 0
  let run06LateRequests = 0
  let run06LateOutcome = null
  let hum07PauseRequests = 0
  let hum07StopRequests = 0
  const hum07ProviderOutcomes = []
  let run06ExecuteRequestCount = null
  let agentOutputSetExecuteRequests = null
  let currentPhase = 'execute'
  const ast01ModelObservations = []
  const provider = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      if (++requests > (agentResidency ? 10000 : 40) || body.length > 300000) throw new Error('FIXTURE_BUDGET')
      const json = JSON.parse(body)
      const functionNames = Array.isArray(json.tools) ? json.tools.map(tool => tool?.function?.name) : []
      const isCoordinatorDecision = json.tools?.length && functionNames.includes('dispatch_agent')
      if (agentHum07Pause && currentPhase === 'execute' && isCoordinatorDecision && hum07PauseRequests === 0) {
        hum07PauseRequests++
        await new Promise(resolve => setTimeout(resolve, 1800))
        hum07ProviderOutcomes.push({ marker: 'HUM07_PAUSE_FIXTURE', responseAttemptedAtUtc: new Date().toISOString(), clientDisconnected: response.destroyed || response.writableEnded })
        if (response.destroyed || response.writableEnded) return
      }
      if (agentHum07Pause && isCoordinatorDecision && body.includes('HUM07_STOP_FIXTURE') && hum07StopRequests === 0) {
        hum07StopRequests++
        let closedEarly = false
        response.once('close', () => { if (!response.writableEnded) closedEarly = true })
        response.once('error', () => {})
        await new Promise(resolve => setTimeout(resolve, 1800))
        hum07ProviderOutcomes.push({ marker: 'HUM07_STOP_FIXTURE', responseAttemptedAtUtc: new Date().toISOString(), clientDisconnected: closedEarly || response.destroyed })
        if (closedEarly || response.destroyed) return
      }
      const isRun06Decision = run06Fault && currentPhase === 'execute' && json.tools?.length && !functionNames.some(name => ['probe_echo', 'probe_done'].includes(name))
      if (isRun06Decision && body.includes('RUN06_LATE_CANCEL')) {
        run06LateRequests++
        let requestAborted = false
        let responseClosedEarly = false
        request.once('aborted', () => { requestAborted = true })
        response.once('close', () => { if (!response.writableEnded) responseClosedEarly = true })
        response.once('error', () => {})
        await new Promise(resolve => setTimeout(resolve, 2800))
        const disconnected = requestAborted || responseClosedEarly || response.destroyed
        run06LateOutcome = {
          responseAttempted: true,
          responseAttemptedAtUtc: new Date().toISOString(),
          requestAborted,
          responseClosedEarly,
          responseDestroyed: response.destroyed,
          clientDisconnected: disconnected
        }
        await writeFile(join(directory, 'run06-late-provider-outcome.json'), JSON.stringify(run06LateOutcome, null, 2))
        await writeFile(join(evidence, 'run06-late-provider-outcome.json'), JSON.stringify(run06LateOutcome, null, 2))
        if (disconnected) return
      }
      if (run06Fault && currentPhase === 'execute' && json.tools?.length && !functionNames.some(name => ['probe_echo', 'probe_done'].includes(name))) {
        run06FaultRequests++
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'private-run06-provider-failure', type: 'server_error' } }))
        return
      }
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
        if (agentFixedInputVersion) {
          const context = JSON.stringify(input)
          if (!input.directInputs?.length || !input.fixedInputs?.length) throw new Error('AST01_FIXED_INPUT_CONTEXT_MISSING')
          if (!input.humanAccepted && input.receipts.length === 0) { name = 'wait_for_human'; args = {} }
          else if (input.receipts.length < 1) { name = 'execute_node'; args = { targetNodeId: input.targets[0].nodeId } }
          else { name = 'finish_task'; args = { outputs: input.receipts.at(-1).outputRefs } }
          ast01ModelObservations.push({ phase: currentPhase, humanAccepted: input.humanAccepted === true, tool: name, includesFixedV1: context.includes('AST01_FIXED_V1'), includesV2: context.includes('AST01_FIXED_V2') })
        }
        else if (input.skills.length && !Object.keys(input.loaded).length) { name = 'load_skill'; args = { skillId: 'result-check' } }
        else if (input.receipts.length < ((video||videoRework||parallelMedia||builderParallel) ? 1 : 2)) { name = 'execute_node'; args = { targetNodeId: agentOutputSet ? input.targets[input.receipts.length].nodeId : input.rework && !videoRework && !parallelReview ? input.targets.find(target => target.nodeId === 'shape:rw-repair').nodeId : input.targets[0].nodeId, ...((videoRework||parallelReview)&&input.rework?.videoTargetNodeId?{prompt:'private-c3-revision-proposal：场景改为红色，保持原参考素材。'}:{}) } }
        else if (input.mode === 'collaborative' && !input.humanAccepted) { name = 'wait_for_human'; args = {} }
        else { name = 'finish_task'; args = { outputs: input.selectedOutputs?.length ? input.selectedOutputs : agentOutputSet ? input.receipts.flatMap(receipt => receipt.outputRefs) : input.receipts.at(-1).outputRefs } }
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
  const rendererPort = await reserveLoopbackPort()
  const rendererUrl = `http://127.0.0.1:${rendererPort}`
  const server = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--config', 'vite.browser.config.ts', '--host', '127.0.0.1', '--port', String(rendererPort), '--strictPort'], { stdio: 'ignore', windowsHide: true })
  const reports = [], events = []
  let agentUnknownExecuteRequests = null
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
    if (!real) await new Promise((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done) })
    const deadline = Date.now() + 30000
    while (true) {
      if (server.exitCode !== null) throw new Error('AGENT_VITE_UNAVAILABLE')
      try {
        const [indexResponse, editorModuleResponse] = await Promise.all([
          fetch(rendererUrl),
          fetch(`${rendererUrl}/src/stores/editor.ts`)
        ])
        const moduleType = editorModuleResponse.headers.get('content-type') ?? ''
        if (indexResponse.ok && editorModuleResponse.ok && !moduleType.includes('text/html')) break
      } catch { /* Bounded readiness. */ }
      if (Date.now() > deadline) throw new Error('AGENT_VITE_TIMEOUT')
      await new Promise(done => setTimeout(done, 250))
    }
    for (const phase of (agentPerfMatrix ? ['execute'] : ['execute', 'reopen'])) {
      currentPhase = phase
      const env = { ...process.env, CANVAS_AGENT_RENDERER_URL: rendererUrl, ...(!real ? { CANVAS_AGENT_FIXTURE_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1` } : {}) }; delete env.ELECTRON_RUN_AS_NODE
      const exit = await new Promise((done, reject) => {
        const child = spawn(require('electron'), [resolve('out/main/agent-flow-desktop.js'), `--agent-directory=${directory}`, `--agent-phase=${phase}`, ...(agentGate ? ['--agent-gate'] : []), ...(agentUnknown ? ['--agent-unknown'] : []), ...(agentOutputSet ? ['--agent-output-set'] : []), ...(agentFixedInputVersion ? ['--agent-fixed-input-version'] : []), ...(agentResidency ? ['--agent-residency', `--agent-residency-seconds=${residencySeconds}`] : []), ...(agentPerfMatrix ? ['--agent-perf-matrix'] : []), ...(agentPanelChurn ? ['--agent-panel-churn'] : []), ...(agentPanelChurnHeapSnapshot && phase === 'execute' ? ['--agent-panel-churn-heap-snapshot'] : []), ...(run06Fault ? ['--agent-run06-fault'] : []), ...(agentHum07Pause ? ['--agent-hum07-pause'] : []), ...(real ? ['--real-model'] : []), ...(collaboration ? ['--collaboration'] : []), ...(coordination ? ['--coordination'] : []), ...(builder ? ['--builder'] : []), ...(builderParallel ? ['--builder-parallel'] : []), ...(review ? ['--review'] : []), ...(rework ? ['--rework'] : []), ...(recovery ? ['--recovery'] : []), ...(video ? ['--video'] : []), ...(firstFrame ? ['--video-first-frame'] : []), ...(lastFrame ? ['--video-first-last-frame'] : []), ...(referenceImages ? ['--video-reference-images'] : []), ...(motionReference ? ['--video-motion-reference'] : []), ...(audioReference ? ['--video-audio-reference'] : []), ...(videoReview ? ['--video-review'] : []), ...(mediaReview ? ['--media-review'] : []), ...(videoRework ? ['--video-rework'] : []), ...(parallelMedia ? ['--parallel-media'] : []), ...(parallelQueueMedia ? ['--parallel-queue-media'] : []), ...(parallelMediaForcedExit && phase === 'execute' ? ['--parallel-media-forced-exit'] : []), ...(parallelReview ? ['--parallel-review'] : []), ...(mediaTransfer ? ['--media-transfer'] : []), ...(multiReference ? ['--video-multi-reference'] : [])],
          { env, stdio: 'ignore', windowsHide: true })
        const timeoutMs = agentResidency ? residencySeconds * 1000 + 300000 : agentPerfMatrix ? 600000 : 240000
        let intentionalKill = false
        const markerPath = join(directory, 'parallel-media-forced-exit.json')
        const checkpointTimer = parallelMediaForcedExit && phase === 'execute' ? setInterval(async () => {
          if (intentionalKill) return
          try { await readFile(markerPath) } catch { return }
          intentionalKill = true
          child.kill('SIGKILL')
        }, 25) : null
        const timer = setTimeout(() => { child.kill(); reject(new Error('AGENT_ELECTRON_TIMEOUT')) }, timeoutMs)
        child.on('error', error => { clearTimeout(timer); if (checkpointTimer) clearInterval(checkpointTimer); reject(error) })
        child.on('exit', (code, signal) => { clearTimeout(timer); if (checkpointTimer) clearInterval(checkpointTimer); done({ code, signal, intentionalKill }) })
      })
      if (parallelMediaForcedExit && phase === 'execute') {
        if (!exit.intentionalKill) {
          const earlyExitReport = join(directory, 'execute-report.json')
          let details = `code=${exit.code};signal=${exit.signal}`
          try {
            const failure = JSON.parse(await readFile(earlyExitReport, 'utf8'))
            await cp(earlyExitReport, join(evidence, 'forced-exit-early-failure.json'))
            details += `;stage=${failure.stage ?? 'unknown'};error=${failure.error ?? failure.message ?? 'unknown'}`
          } catch { /* Preserve the process outcome even if the app could not write a report. */ }
          throw new Error(`PARALLEL_FORCED_EXIT_BEFORE_CHECKPOINT:${details}`)
        }
        const marker = JSON.parse(await readFile(join(directory, 'parallel-media-forced-exit.json'), 'utf8'))
        const checkpoint = JSON.parse(await readFile(join(directory, 'agent-state.json'), 'utf8'))
        if (!exit.intentionalKill || !marker.checkpointWritten || !marker.diagnosticEventsFlushed || marker.projectId !== checkpoint.projectId || marker.taskId !== checkpoint.taskId || checkpoint.parallelChildren?.length !== (parallelQueueMedia ? 3 : 2)) throw new Error('PARALLEL_FORCED_EXIT_CHECKPOINT_INVALID')
        await cp(join(directory, 'parallel-media-forced-exit.json'), join(evidence, 'parallel-media-forced-exit.json'))
        await cp(join(directory, 'agent-state.json'), join(evidence, 'forced-exit-checkpoint.json'))
        const report = { status: 'forced-exit-observed', report: checkpoint, processExit: { code: exit.code, signal: exit.signal, intentionalKill: exit.intentionalKill }, model: 'fixture' }
        await writeFile(join(evidence, 'execute-report.json'), JSON.stringify(report, null, 2))
        reports.push(report)
        continue
      }
      const code = exit.code
      const report = JSON.parse(await readFile(join(directory, `${phase}-report.json`), 'utf8'))
      if (run06Fault && phase === 'execute') run06ExecuteRequestCount = requests
      if (run06Fault && phase === 'reopen' && requests !== run06ExecuteRequestCount) throw new Error('RUN06_MODEL_REPLAY_ON_REOPEN')
      if (agentUnknown && phase === 'execute') agentUnknownExecuteRequests = requests
      if (agentUnknown && phase === 'reopen' && requests !== agentUnknownExecuteRequests) throw new Error('CMD08_UNKNOWN_FOOTER_MODEL_REPLAYED')
      if (agentOutputSet && phase === 'execute') agentOutputSetExecuteRequests = requests
      if (agentOutputSet && phase === 'reopen' && requests !== agentOutputSetExecuteRequests) throw new Error('AST05_MODEL_REPLAYED_ON_REOPEN')
      await writeFile(join(evidence, `${phase}-report.json`), JSON.stringify(report, null, 2))
      if (agentPerfMatrix && phase === 'execute' && report.status === 'pass') {
        await cp(join(directory, 'agent-perf-matrix.json'), join(evidence, 'agent-perf-matrix.json'))
        for (const count of [10, 50, 100])
          await cp(join(directory, `agent-perf-${count}.png`), join(evidence, `agent-perf-${count}.png`))
      }
      reports.push(report)
      if (agentPanelChurn && phase === 'execute') {
        for (const name of [
          'panel-churn-samples.jsonl',
          'panel-churn-start.png',
          'panel-churn-end.png',
          ...(agentPanelChurnHeapSnapshot
            ? [
                'per04-heap-snapshot.heapsnapshot',
                'per04-heap-object-ids.json',
                'per04-event-listeners.json'
              ]
            : [])
        ])
          await cp(join(directory, name), join(evidence, name))
      }
      if (agentResidency && phase === 'execute') {
        for (const name of await readdir(directory)) {
          if (name.startsWith('residency-'))
            await cp(join(directory, name), join(evidence, name))
        }
      }
      if(parallelReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,'parallel-review.png'),join(evidence,'parallel-review.png'))
      if(parallelMedia&&!parallelReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,parallelQueueMedia?'parallel-queue-media.png':'parallel-media.png'),join(evidence,parallelQueueMedia?'parallel-queue-media.png':'parallel-media.png'))
      if(mediaReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,'media-review.png'),join(evidence,'media-review.png'))
      if(videoReview&&!parallelReview&&phase==='reopen'&&report.status==='pass')await cp(join(directory,'video-review.png'),join(evidence,'video-review.png'))
      if(video && phase==='reopen' && report.status==='pass') {
        await cp(join(directory,'video-fixed.png'),join(evidence,'video-fixed.png'))
        if(audioReference) await cp(join(directory,'audio-fixed.png'),join(evidence,'audio-fixed.png'))
        if(firstFrame) await cp(join(directory,'image-fixed.png'),join(evidence,'image-fixed.png'))
        if(mediaTransfer) await cp(join(directory,'media-imported.png'),join(evidence,'media-imported.png'))
      }
      if (code !== 0 || report.status !== 'pass') {
        const recordedPer04AcceptanceFailure =
          agentPanelChurn && phase === 'execute' && report.report?.acceptance?.status === 'failed'
        await cp(join(directory,'pointer-debug.json'),join(evidence,'pointer-debug.json')).catch(()=>{})
        await cp(join(directory,'pointer-failure.png'),join(evidence,'pointer-failure.png')).catch(()=>{})
        if (agentPerfMatrix)
          await cp(join(directory, 'agent-perf-failure.png'), join(evidence, 'agent-perf-failure.png')).catch(() => {})
        if (agentPerfMatrix)
          for (const count of [10, 50, 100])
            await cp(join(directory, `agent-perf-${count}.png`), join(evidence, `agent-perf-${count}.png`)).catch(() => {})
        if (!recordedPer04AcceptanceFailure) await scan(join(directory, 'diagnostics'))
        await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
        if (agentOutputSet) {
          await cp(join(directory, 'ast05-agent-execution-failure.json'), join(evidence, 'ast05-agent-execution-failure.json')).catch(() => {})
          await cp(join(directory, 'ast05-execute-failure.png'), join(evidence, 'ast05-execute-failure.png')).catch(() => {})
          await writeFile(join(evidence, 'ast05-failure-summary.json'), JSON.stringify({ phase, status: 'failed', failureCode: report.report?.code || 'UNKNOWN', fixtureHttpRequests: requests, modelRequests: events.filter(event => event.event === 'model.request.started').length, capabilityProbeRequests: events.filter(event => event.event === 'model.request.started' && event.attributes?.operation === 'agent.capability.probe').length, decisionRequests: events.filter(event => event.event === 'model.request.started' && event.attributes?.operation === 'agent.runtime.decide').length, realSupplierRequests: 0, paidRequests: 0, externalHttpRequests: 0, reopenReached: false }, null, 2))
        }
        await writeFile(join(evidence, 'failure-reasons.json'), JSON.stringify(events.filter(event => event.event.endsWith('.failed')).map(event => ({ event: event.event, phase: event.attributes?.phase, action: event.attributes?.action, code: event.attributes?.code || event.error?.code })), null, 2))
        if (!recordedPer04AcceptanceFailure)
          throw new Error(`AGENT_${phase.toUpperCase()}_${report.report?.code || 'FAILED'}`)
      }
      if (agentOutputSet) await cp(join(directory, `ast05-${phase}.png`), join(evidence, `ast05-${phase}.png`))
      if (agentFixedInputVersion) {
        await cp(join(directory, `ast01-${phase}.json`), join(evidence, `ast01-${phase}.json`))
        await cp(join(directory, `ast01-persisted-${phase}.json`), join(evidence, `ast01-persisted-${phase}.json`))
        await cp(join(directory, `ast01-${phase}.png`), join(evidence, `ast01-${phase}.png`))
      }
    }
    async function scan(path) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        const target = join(path, file.name)
        if (file.isDirectory()) await scan(target)
        else {
          const text = await readFile(target, 'utf8')
          if (text.includes('private-c3') || (run06Fault && text.includes('private-run06-provider-failure')) || text.includes('data:image/') || text.includes('data:video/') || text.includes('data:audio/') || text.includes('/9j/') || text.includes('UklGR') || (videoPrefix && text.includes(videoPrefix)) || text.includes('iVBORw0KGgoAAAANSUhEUg') || (process.env.CANVAS_AGENT_PROBE_KEY && text.includes(process.env.CANVAS_AGENT_PROBE_KEY))) throw new Error('AGENT_DIAGNOSTICS_REDACTION_FAILED')
          if (file.name.endsWith('.jsonl')) for (const line of text.trim().split('\n')) if (line.trim()) events.push(JSON.parse(line))
        }
      }
    }
    await scan(join(directory, 'diagnostics'))
    if (run06Fault) await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    if (agentResidency) await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    if(videoReview||mediaReview||parallelMedia||multiReference) await cp(join(directory, 'diagnostics'), join(evidence, 'diagnostics'), { recursive: true })
    const started = events.filter(event => event.event === 'agent.desktop.started')
    const ended = events.filter(event => ['agent.desktop.completed', 'agent.desktop.failed'].includes(event.event))
    const agentDesktopPair = (start, end) => start.traceId === end.traceId && start.spanId === end.spanId
    const unpairedAgentStarts = started.filter(start => ended.filter(end => agentDesktopPair(start, end)).length !== 1)
    const orphanAgentTerminals = ended.filter(end => started.filter(start => agentDesktopPair(start, end)).length !== 1)
    const agentLifecycleAudit = {
      startedCount: started.length,
      terminalCount: ended.length,
      unpairedStarts: unpairedAgentStarts.map(event => ({ traceId: event.traceId, spanId: event.spanId, sessionId: event.sessionId, phase: event.attributes?.phase, action: event.attributes?.action })),
      orphanTerminals: orphanAgentTerminals.map(event => ({ event: event.event, traceId: event.traceId, spanId: event.spanId, sessionId: event.sessionId, phase: event.attributes?.phase, action: event.attributes?.action }))
    }
    if (agentResidency) await writeFile(join(evidence, 'agent-lifecycle-audit.json'), JSON.stringify(agentLifecycleAudit, null, 2))
    if (run06Fault) {
      if (!started.length || started.length !== ended.length || unpairedAgentStarts.length || orphanAgentTerminals.length) throw new Error('RUN06_DESKTOP_LIFECYCLE_INVALID')
    } else if ((!agentGate && !agentPerfMatrix && !agentPanelChurn && !started.length) || started.length !== ended.length || unpairedAgentStarts.length || orphanAgentTerminals.length) throw new Error('AGENT_DESKTOP_LIFECYCLE_FAILED')
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
      if(parallelMedia){const posts=events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='video.generate');if(posts.length!==(parallelQueueMedia?3:4)||posts.some(post=>events.filter(event=>event.event==='model.request.accepted'&&event.requestId===post.requestId).length!==1))throw new Error('PARALLEL_SUBMIT_DIAGNOSTICS_INVALID')}
      if(videoRework){const posts=events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='video.generate');if(posts.length!==2||posts.some(post=>events.filter(event=>event.event==='model.request.accepted'&&event.requestId===post.requestId).length!==1))throw new Error('VIDEO_REWORK_SUBMIT_DIAGNOSTICS_INVALID')}
      if(multiReference||parallelMedia||videoRework){
        const posts=events.filter(event=>event.event==='model.request.started'&&event.attributes?.operation==='video.generate')
        for(const post of posts){
          const accepted=events.find(event=>event.event==='model.request.accepted'&&event.requestId===post.requestId)
          if(!accepted||!accepted.taskId||accepted.traceId!==post.traceId||accepted.spanId!==post.spanId)throw new Error('ASYNC_MEDIA_ACCEPTANCE_CONTEXT_INVALID')
          // task.control.* 是运行中查询/取消探针（P1-B 后携带调用方真实 trace），
          // 不属于媒体生命周期归属检查；state_changed/download/persist 仍锁定提交上下文。
          const related=events.filter(event=>event.taskId===accepted.taskId&&!event.correlationMissing&&(/^(task|media)\./.test(event.event))&&!/^task\.control\./.test(event.event))
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
    if (!agentGate && !agentUnknown && !agentOutputSet && !agentPerfMatrix && !agentPanelChurn && !run06Fault && (((!builder && !review && !rework) || videoRework || parallelReview) && !events.some(event => event.event === 'agent.runtime.resumed' && event.attributes?.resumesTraceId))) throw new Error('AGENT_RESUME_TRACE_MISSING')
    if (agentFixedInputVersion) {
      const toolSequence = ast01ModelObservations.map(item => item.tool)
      const preContinue = ast01ModelObservations.filter(item => item.phase === 'reopen' && !item.humanAccepted)
      const resumed = ast01ModelObservations.filter(item => item.phase === 'reopen' && item.humanAccepted)
      if (ast01ModelObservations.some(item => !item.includesFixedV1 || item.includesV2) || preContinue.length || toolSequence.join(',') !== 'wait_for_human,execute_node,finish_task' || resumed.length !== 2) throw new Error('AST01_MODEL_INPUT_OR_RESUME_SEQUENCE_INVALID')
      await writeFile(join(evidence, 'ast01-model-observations.json'), JSON.stringify(ast01ModelObservations, null, 2))
    }
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
    if (run06Fault) {
      const execution = reports[0]?.report
      const reopened = reports[1]?.report
      const requestStarts = events.filter(event => event.event === 'model.request.started' && event.attributes?.operation === 'agent.runtime.decide')
      const requestFailures = events.filter(event => event.event === 'model.request.failed' && event.attributes?.operation === 'agent.runtime.decide')
      const requestCancellations = events.filter(event => event.event === 'model.request.cancelled' && event.attributes?.operation === 'agent.runtime.decide')
      run06LateOutcome = JSON.parse(await readFile(join(directory, 'run06-late-provider-outcome.json'), 'utf8'))
      if (reports.some(item => item.status !== 'pass') || !['failed', 'blocked'].includes(execution?.taskState) || execution?.taskCode !== 'AGENT_MODEL_FAILED' || execution?.nodeExec !== 'failed' || execution?.processorRunCount !== 0 || execution?.agentOutputCount !== 0 || !String(execution?.failureLabel ?? '').includes('运行失败')) throw new Error('RUN06_FAILURE_NOT_PRESENTED_OR_FALSE_OUTPUT')
      if (!['failed', 'blocked'].includes(reopened?.taskState) || reopened?.taskCode !== execution.taskCode || reopened?.taskId !== execution.taskId || reopened?.nodeExec !== 'failed' || reopened?.processorRunCount !== 0 || reopened?.agentOutputCount !== 0) throw new Error('RUN06_FAILURE_FACTS_NOT_PERSISTED')
      if (execution?.late?.taskState !== 'cancelled' || execution?.late?.processorRunCount !== 0 || execution?.late?.agentOutputCount !== 0 || reopened?.late?.taskId !== execution?.late?.taskId || reopened?.late?.taskState !== 'cancelled' || reopened?.late?.processorRunCount !== 0 || reopened?.late?.agentOutputCount !== 0) throw new Error('RUN06_LATE_CANCEL_FACTS_NOT_PERSISTED')
      if (run06FaultRequests !== 1 || run06LateRequests !== 1 || requestStarts.length !== 2 || requestFailures.length !== 1 || requestCancellations.length !== 1 || !requestFailures.some(failure => requestStarts.some(start => start.requestId === failure.requestId)) || !requestCancellations.some(cancelled => requestStarts.some(start => start.requestId === cancelled.requestId && start.requestId !== requestFailures[0].requestId))) throw new Error('RUN06_REQUEST_FAILURE_OR_CANCEL_DIAGNOSTICS_MISSING')
      if (events.some(event => event.event === 'model.request.completed' && requestStarts.some(start => start.requestId === event.requestId))) throw new Error('RUN06_TERMINAL_REQUEST_REPORTED_COMPLETED')
      if (!run06LateOutcome?.responseAttempted || Date.parse(run06LateOutcome.responseAttemptedAtUtc) <= Date.parse(execution.late.cancelledAtUtc)) throw new Error('RUN06_PROVIDER_RESPONSE_NOT_LATE')
    }
    if (agentHum07Pause) {
      const execution = reports[0]?.report
      const reopened = reports[1]?.report
      const stopOutcome = hum07ProviderOutcomes.find(outcome => outcome.marker === 'HUM07_STOP_FIXTURE')
      if (reports.some(item => item.status !== 'pass') || hum07PauseRequests !== 1 || hum07StopRequests !== 1 || !execution?.pauseStopAudit?.pauseHeldDispatch || !execution?.pauseStopAudit?.controlsDistinct || !execution?.pauseStopAudit?.continuedAfterPause || execution?.stopTaskState !== 'cancelled' || reopened?.stopTaskId !== execution.stopTaskId || reopened?.stopTaskState !== 'cancelled' || reopened?.stopChildTaskExists !== false || reopened?.stopProcessorRuns !== 0 || !stopOutcome?.clientDisconnected || Date.parse(stopOutcome.responseAttemptedAtUtc) <= Date.parse(execution.stopCancelledAtUtc)) throw new Error('HUM07_PAUSE_STOP_DESKTOP_ASSERTION_FAILED')
    }
    if (agentGate && modelRequests !== 0) throw new Error('CMD08_AGENT_GATE_MODEL_REQUESTS_NOT_ZERO')
    const panelChurnAcceptance = agentPanelChurn ? reports[0]?.report?.acceptance : undefined
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ reports, ...(panelChurnAcceptance ? { panelChurnAcceptance } : {}), modelRequests, fixtureRequests: requests, ...(run06Fault ? { run06FaultRequests, run06LateRequests, run06LateOutcome, modelRequestsUnchangedOnReopen: requests === run06ExecuteRequestCount } : {}), ...(agentHum07Pause ? { hum07PauseRequests, hum07StopRequests, hum07ProviderOutcomes } : {}), ...(agentResidency ? { targetDurationSeconds: residencySeconds, agentLifecycleAudit } : {}), diagnosticSessionIds: [...new Set(events.map(event=>event.sessionId))], diagnosticRedaction: true,
      boundary: agentPerfMatrix ? 'isolated Electron Agent canvas rendering and input; no task dispatch or supplier call' : 'real desktop canvas/executor/IPC/model catalog/SDK/two process checkpoint/fixed assets', model: real ? process.env.CANVAS_AGENT_PROBE_MODEL : 'synthetic fixture' }, null, 2))
    if (agentPerfMatrix) await rm(join(evidence, 'agent-perf-progress.json'), { force: true })
    if (agentPanelChurn && panelChurnAcceptance?.status === 'failed') {
      process.stderr.write(`Agent PER-04 acceptance failed: listeners ${reports[0].report.listenerStart} -> ${reports[0].report.listenerEnd}; active intervals ${reports[0].report.activeIntervalsStart} -> ${reports[0].report.activeIntervalsEnd}; new-process reopen passed.\n`)
      process.exitCode = 1
    } else {
      process.stdout.write(run06Fault ? 'Agent RUN-06 desktop: provider HTTP failure and delayed response cancellation remained visible and stable across reopen, with no processor execution or Agent output.\n' : agentHum07Pause ? 'Agent HUM-07 desktop: pause blocked an in-flight coordinator handoff until explicit continue; stop cancelled a later in-flight handoff without dispatching its child.\n' : agentFixedInputVersion ? 'Agent AST-01 desktop: v2 selected in the asset UI; the waiting task reopened and completed on fixed v1 with no tool replay.\n' : agentGate ? 'Agent CMD-08 desktop: title, footer, multi-select and manual entrances share review-gate admission; blocked task writes and model requests remained zero across reopen.\n' : agentUnknown ? 'Agent CMD-08 desktop: Agent footer attempted an occupied processor, the unknown reservation remained unchanged, and reopen did not replay the fixture request.\n' : agentResidency ? `Agent PER-01 desktop: same renderer completed ${residencySeconds}s of minute-spaced Agent wait/continue cycles with resource samples and periodic screenshots; new-process reopen passed.\n` : agentPerfMatrix ? 'Agent PER-02 desktop: 10/50/100 Agent-node canvas interaction matrix completed with drag, zoom and collaboration panel latency samples.\n' : agentPanelChurn ? 'Agent PER-04 desktop: panel/project churn acceptance and new-process reopen passed.\n' : parallelReview ? 'Parallel sampled review desktop: overlapping initial videos, two independent reworks, unknown/reopen join, four POSTs/four downloads, dual review gates and diagnostics passed.\n' : parallelQueueMedia ? 'Parallel queue recovery desktop: forced exit at completed/waiting/queued checkpoint, unknown reconcile without POST replay, FIFO continuation and budget/lock audit passed.\n' : parallelMedia ? 'Parallel media desktop: overlapping supplier submissions, partial success, unknown/reopen recovery, stop/reservations and diagnostics passed.\n' : mediaReview ? 'Media review desktop: complete image bytes, complete normalized audio, A/V timeline and four visual samples survive a two-process reopen with no model replay.\n' : videoRework ? 'Video bounded rework desktop: negative sampled review, feedback-bound new task, unknown/reopen recovery, two POSTs/two downloads, approved downstream and diagnostics passed.\n' : videoReview ? 'Video sampled review desktop: negative gate, reopen/reuse, manual replacement, four real JPEGs, approved downstream extraction and diagnostics passed.\n' : multiReference ? 'Agent multi-reference video desktop: ordered image/video/audio references, prompt bundle, unknown/reopen/continue, fixed media and diagnostics passed.\n' : video ? 'Agent video desktop: main dispatch, unknown/reopen/explicit continue, one supplier task, one download, fixed playable video asset and diagnostics passed.\n' : `Agent desktop ${real ? 'real model' : 'fixture'}: start, two tools, human wait/reopen/continue, declared fixed assets and diagnostics passed.\n`)
    }
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
