// Isolated, hidden desktop acceptance; never imported by the application.
import { app, BrowserWindow, dialog, protocol, net } from 'electron'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { getMediaAbsPath, importMedia } from '../store/media.repo'
import { basename, join, resolve } from 'node:path'
import { cpus, tmpdir, totalmem } from 'node:os'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerFlowCommandsIpc } from '../ipc/flow-commands.ipc'
import { registerFlowAgentsIpc } from '../ipc/flow-agents.ipc'
import { registerFlowAssetsIpc } from '../ipc/flow-assets.ipc'
import { registerProjectIpc } from '../ipc/project.ipc'
import { registerLibraryIpc } from '../ipc/library.ipc'
import { registerMediaIpc } from '../ipc/media.ipc'
import { registerWorkspaceStateIpc } from '../ipc/workspace-state.ipc'
import { registerGatewayIpc } from '../ipc/gateway.ipc'
import { registerModelIpc } from '../ipc/models.ipc'
import { registerDiagnosticsIpc, setDiagnosticsService } from '../ipc/diagnostics.ipc'
import { SqliteModelHost } from '../model-host/sqlite-model-host'
import { createDesktopModelRuntime } from '../model-host/runtime'
import { createProject, openProject } from '../store/projects.repo'
import { closeDb, getDb, setSetting } from '../store/db'
import { initDiagnosticsService } from '../diagnostics/service'
import { setGatewayEventSink } from '../diagnostics/gateway-events'

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = arg('agent-directory'),
  phase = arg('agent-phase')
const real = process.argv.includes('--real-model')
const multiReference = process.argv.includes('--video-multi-reference')
const mediaTransfer = multiReference || process.argv.includes('--media-transfer')
const audioReference = mediaTransfer || process.argv.includes('--video-audio-reference')
const motionReference = mediaTransfer || process.argv.includes('--video-motion-reference')
const referenceImages = mediaTransfer || process.argv.includes('--video-reference-images')
const lastFrame = referenceImages || process.argv.includes('--video-first-last-frame')
const firstFrame = lastFrame || process.argv.includes('--video-first-frame')
const videoMode =
  referenceImages || motionReference || audioReference
    ? 'reference'
    : lastFrame
      ? 'first-last-frame'
      : firstFrame
        ? 'first-frame'
        : 'text'
const videoReview = process.argv.includes('--video-review')
const mediaReview = process.argv.includes('--media-review')
const videoRework = process.argv.includes('--video-rework')
const parallelQueueMedia = process.argv.includes('--parallel-queue-media')
const parallelMedia = process.argv.includes('--parallel-media') || parallelQueueMedia
const parallelMediaForcedExit = process.argv.includes('--parallel-media-forced-exit')
const parallelReview = process.argv.includes('--parallel-review')
const video = process.argv.includes('--video')
if (video || videoReview || mediaReview || parallelMedia)
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
const collaboration = process.argv.includes('--collaboration')
const coordination = process.argv.includes('--coordination')
const agentHum07Pause = process.argv.includes('--agent-hum07-pause')
const recovery = process.argv.includes('--recovery')
const builderParallelMode = process.argv.includes('--builder-parallel')
const builder = process.argv.includes('--builder') || builderParallelMode
const agentGate = process.argv.includes('--agent-gate')
const agentUnknown = process.argv.includes('--agent-unknown')
const agentOutputSet = process.argv.includes('--agent-output-set')
const agentFixedInputVersion = process.argv.includes('--agent-fixed-input-version')
const agentResidency = process.argv.includes('--agent-residency')
const agentPerfMatrix = process.argv.includes('--agent-perf-matrix')
const agentPanelChurn = process.argv.includes('--agent-panel-churn')
const agentPanelChurnHeapSnapshot = process.argv.includes('--agent-panel-churn-heap-snapshot')
const agentRun06Fault = process.argv.includes('--agent-run06-fault')
const agentPanelChurnForceGc =
  agentPanelChurn && process.env.CANVAS_AGENT_PANEL_CHURN_FORCE_GC === '1'
const agentResidencySeconds = Number(arg('agent-residency-seconds') ?? '7200')
const review = process.argv.includes('--review')
const rework = process.argv.includes('--rework')
const reworkMode = process.env.CANVAS_AGENT_REWORK_MODE ?? 'autonomous'
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-flow-agent-') ||
  !['execute', 'reopen'].includes(phase ?? '') ||
  (parallelMediaForcedExit && (!parallelMedia || parallelReview || phase !== 'execute' || real)) ||
  (agentHum07Pause && (!coordination || recovery || collaboration || builder || review || rework || video || videoReview || mediaReview || parallelMedia || parallelReview || real || agentRun06Fault)) ||
  (agentResidency &&
    (!Number.isInteger(agentResidencySeconds) ||
      agentResidencySeconds < 60 ||
      agentResidencySeconds > 7200)) ||
  (agentPerfMatrix &&
    (agentGate ||
      agentUnknown ||
      agentResidency ||
      collaboration ||
      coordination ||
      builder ||
      review ||
      rework ||
      recovery ||
      video ||
      videoReview ||
      mediaReview ||
      parallelMedia ||
      parallelReview ||
      phase !== 'execute')) ||
  (agentPanelChurn &&
    (agentGate ||
      agentUnknown ||
      agentResidency ||
      collaboration ||
      coordination ||
      builder ||
      review ||
      rework ||
      recovery ||
      video ||
      videoReview ||
      mediaReview ||
      parallelMedia ||
      parallelReview))
) {
  app.exit(2)
} else {
  process.env.CANVAS_DATA_DIR = directory
  app.setPath('userData', directory)
  app.on('window-all-closed', () => {})
  void app.whenReady().then(async () => {
    // PER-01 runs beyond one bounded shutdown batch. Keep periodic diagnostics
    // flushing enabled so its lifecycle audit covers the full residency window.
    const diagnostics = await initDiagnosticsService({
      dataDir: directory,
      disableTimers: !agentResidency
    })
    setGatewayEventSink(diagnostics)
    setDiagnosticsService(diagnostics)
    let foreign: BrowserWindow | undefined
    let window: BrowserWindow | undefined,
      failed = false,
      report: unknown,
      stage = 'setup'
    try {
      stage = 'setup-project'
      const statePath = join(directory, 'agent-state.json')
      const projectId =
        phase === 'execute'
          ? createProject('测试：画布 Agent C3').id
          : JSON.parse(readFileSync(statePath, 'utf8')).projectId
      setSetting('lastProjectId', projectId)
      stage = 'setup-protocol'
      const host = new SqliteModelHost(getDb())
      if (video || videoReview || mediaReview || parallelMedia) {
        protocol.handle('media', (request) => {
          const url = new URL(request.url),
            path = getMediaAbsPath(decodeURIComponent(url.host + url.pathname).replace(/^\/+/, ''))
          return path
            ? net.fetch(pathToFileURL(path).href)
            : Promise.resolve(new Response(null, { status: 403 }))
        })
      }
      if (video) {
        if (phase === 'execute') {
          getDb()
            .prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)')
            .run(
              'video-test',
              '隔离视频夹具',
              'seedance',
              'https://ark.cn-beijing.volces.com/api/v3',
              'private-c3-video-key',
              JSON.stringify([
                {
                  id: 'doubao-seedance-2-0',
                  name: '隔离视频',
                  modality: 'video',
                  operations: ['video.generate']
                }
              ]),
              0
            )
          for (const key of ['video-posts', 'video-downloads']) setSetting(key, '0')
        }
        const nativeFetch = globalThis.fetch
        globalThis.fetch = async (url, options) => {
          const address = String(url)
          if (
            address.startsWith(
              'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks'
            )
          ) {
            if (options?.method === 'POST') {
              const content = JSON.parse(String(options.body)).content
              const images = content.filter((part: { type: string }) => part.type === 'image_url')
              await active.webContents.executeJavaScript(
                `window.__reviewAcceptanceStage=${JSON.stringify(JSON.stringify({ count: images.length, roles: images.map((image: { role: string }) => image.role), matches: images.map((image: { image_url: { url: string } }) => ['first-frame.png', 'last-frame.png', 'reference-third.png'].findIndex((file) => image.image_url.url === `data:image/png;base64,${readFileSync(join(directory, file)).toString('base64')}`)) }))}`
              )
              if (
                firstFrame &&
                (images.length !== (referenceImages ? 3 : lastFrame ? 2 : 1) ||
                  images[0].role !== (referenceImages ? 'reference_image' : 'first_frame') ||
                  !images[0].image_url.url.startsWith('data:image/png;base64,'))
              )
                throw new Error('FIRST_FRAME_WIRE_INVALID')
              if (
                lastFrame &&
                (images[1].role !== (referenceImages ? 'reference_image' : 'last_frame') ||
                  images[0].image_url.url !==
                    `data:image/png;base64,${readFileSync(join(directory, 'first-frame.png')).toString('base64')}` ||
                  images[1].image_url.url !==
                    `data:image/png;base64,${readFileSync(join(directory, 'last-frame.png')).toString('base64')}`)
              )
                throw new Error('LAST_FRAME_WIRE_INVALID')
              if (!firstFrame && images.length) throw new Error('TEXT_VIDEO_HAS_IMAGE')
              const videos = content.filter((part: { type: string }) => part.type === 'video_url')
              if (
                motionReference &&
                (videos.length !== (multiReference ? 2 : 1) ||
                  videos[0].role !== 'reference_video' ||
                  videos[0].video_url.url !==
                    `data:video/mp4;base64,${readFileSync(join(directory, 'fixture.mp4')).toString('base64')}` ||
                  (multiReference &&
                    (videos[1].role !== 'reference_video' ||
                      videos[1].video_url.url !==
                        `data:video/mp4;base64,${readFileSync(join(directory, 'motion-second.mp4')).toString('base64')}`)))
              )
                throw new Error('MOTION_REFERENCE_WIRE_INVALID')
              if (!motionReference && videos.length) throw new Error('UNEXPECTED_VIDEO_REFERENCE')
              const audios = content.filter((part: { type: string }) => part.type === 'audio_url')
              if (
                audioReference &&
                (audios.length !== (multiReference ? 2 : 1) ||
                  audios[0].role !== 'reference_audio' ||
                  audios[0].audio_url.url !==
                    `data:audio/wav;base64,${readFileSync(join(directory, 'reference.wav')).toString('base64')}` ||
                  (multiReference &&
                    (audios[1].role !== 'reference_audio' ||
                      audios[1].audio_url.url !==
                        `data:audio/wav;base64,${readFileSync(join(directory, 'reference-second.wav')).toString('base64')}`)))
              )
                throw new Error('AUDIO_REFERENCE_BYTES_INVALID')
              if (!audioReference && audios.length) throw new Error('UNEXPECTED_AUDIO_REFERENCE')
              if (
                multiReference &&
                !content.some(
                  (part: { type: string; text?: string }) =>
                    part.type === 'text' &&
                    part.text?.includes('private-c3-bundle-prompt') &&
                    part.text.includes('private-c3-bundle-style')
                )
              )
                throw new Error('PROMPT_BUNDLE_WIRE_INVALID')
              if (
                referenceImages &&
                (images.some((image: { role: string }) => image.role !== 'reference_image') ||
                  images[2].image_url.url !==
                    `data:image/png;base64,${readFileSync(join(directory, 'reference-third.png')).toString('base64')}`)
              )
                throw new Error('REFERENCE_IMAGES_WIRE_INVALID')
              getDb()
                .prepare(
                  "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='video-posts'"
                )
                .run()
              return new Response(JSON.stringify({ id: 'remote-video' }), {
                headers: { 'Content-Type': 'application/json' }
              })
            }
            return new Response(
              JSON.stringify({
                id: 'remote-video',
                status: phase === 'execute' ? 'unknown' : 'succeeded',
                content: { video_url: 'https://fixture.example/video' }
              }),
              { headers: { 'Content-Type': 'application/json' } }
            )
          }
          if (address === 'https://fixture.example/video') {
            getDb()
              .prepare(
                "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='video-downloads'"
              )
              .run()
            return new Response(readFileSync(join(directory, 'fixture.mp4')))
          }
          return nativeFetch(url, options)
        }
      }
      stage = 'setup-supplier'
      if (parallelReview) {
        const { installParallelReviewSupplier } = await import('./parallel-review-acceptance')
        installParallelReviewSupplier(directory, phase!)
      } else if (parallelMedia) {
        if (parallelQueueMedia) {
          const { installParallelQueueMediaSupplier } = await import('./parallel-media-acceptance')
          installParallelQueueMediaSupplier(directory, phase!)
        } else {
          const { installParallelMediaSupplier } = await import('./parallel-media-acceptance')
          installParallelMediaSupplier(directory, phase!)
        }
      }
      if (videoRework) {
        const { installVideoReworkSupplier } = await import('./video-rework-acceptance')
        installVideoReworkSupplier(directory, phase!)
      }
      stage = 'setup-model'
      host.saveConnection({
        id: 'agent-test-connection',
        name: '隔离验收模型',
        protocol: 'openai-compatible',
        baseUrl: real
          ? (process.env.CANVAS_AGENT_PROBE_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3')
          : (process.env.CANVAS_AGENT_FIXTURE_BASE_URL ?? 'http://127.0.0.1:5200/v1'),
        ...(real ? { apiKey: process.env.CANVAS_AGENT_PROBE_KEY } : {})
      })
      host.saveModel({
        id: 'agent-test-model',
        connectionId: 'agent-test-connection',
        name: '隔离验收模型',
        modelId: real ? (process.env.CANVAS_AGENT_PROBE_MODEL ?? '') : 'fixture',
        capabilities: [
          {
            operation: 'text.generate',
            asynchronous: false,
            streaming: true,
            acceptedAssetKinds: mediaReview ? ['image', 'audio'] : videoReview ? ['image'] : [],
            producedAssetKinds: [],
            controls: {}
          }
        ]
      })
      if (!real) {
        const revisions = host.getAgentToolCallingRevisions(
          'agent-test-connection',
          'agent-test-model'
        )
        if (!revisions) throw new Error('fixture model revisions unavailable')
        const checkedAt = new Date().toISOString()
        host.saveAgentToolCallingValidation({
          connectionId: 'agent-test-connection',
          modelDefinitionId: 'agent-test-model',
          snapshot: {
            status: 'verified',
            message: '确定性本地验收夹具，不代表真实供应商验证',
            checkedAt,
            verifiedAt: checkedAt
          },
          expectedConnectionRevision: revisions.connectionRevision,
          expectedModelRevision: revisions.modelRevision
        })
      }
      if (videoReview || mediaReview || agentRun06Fault)
        await host.saveValidation({
          connectionId: 'agent-test-connection',
          modelDefinitionId: 'agent-test-model',
          operation: 'text.generate',
          status: 'verified',
          checkedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString()
        })
      stage = 'setup-ipc'
      registerProjectIpc()
      registerLibraryIpc()
      registerMediaIpc()
      registerWorkspaceStateIpc()
      registerDiagnosticsIpc()
      registerModelIpc(host, createDesktopModelRuntime(host))
      window = new BrowserWindow({
        show: false,
        width: 1900,
        height: 1050,
        webPreferences: {
          preload: resolve(__dirname, '../preload/index.js'),
          contextIsolation: true,
          sandbox: false,
          backgroundThrottling: false,
          nodeIntegration: false
        }
      })
      const active = window
      registerGatewayIpc(active)
      registerFlowAssetsIpc(() => active)
      registerFlowCommandsIpc(
        () => active,
        (desktop) => registerFlowAgentsIpc(() => active, desktop)
      )
      stage = 'setup-load'
      await active.loadURL(process.env.CANVAS_AGENT_RENDERER_URL || 'http://127.0.0.1:5199')
      stage = 'setup-canvas'
      const deadline = Date.now() + 60000
      while (
        !(await active.webContents.executeJavaScript(
          "import('/src/stores/editor.ts').then(m=>!!m.useEditorStore.getState().editor)"
        ))
      ) {
        if (Date.now() > deadline) throw new Error('AGENT_CANVAS_TIMEOUT')
        await new Promise((done) => setTimeout(done, 100))
      }
      stage = phase ?? 'execute'
      const common = `
        const projectId=${JSON.stringify(projectId)};
        const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;
        const {ensureCanvasSaved}=await import('/src/canvas/flow-asset-actions.ts');
        const value=(reply)=>{if(!reply.ok)throw new Error(reply.error.code);return reply.data};
        const inspect=()=>window.api.inspectFlowAgent({projectId,nodeId:'shape:c3-agent'}).then(value);
        const wait=async(state)=>{for(let i=0;i<1800;i++){const task=await inspect();if(task?.state===state)return task;if(task&&['blocked','failed'].includes(task.state))throw new Error(task.code||'AGENT_TASK_FAILED');await new Promise(r=>setTimeout(r,100));}throw new Error('AGENT_TASK_TIMEOUT')};
        const click=()=>{const button=document.querySelector('[data-node-id="shape:c3-agent"] .node-standard-primary');if(!button||button.disabled)throw new Error('AGENT_BUTTON_UNAVAILABLE');button.click()};
      `
      if (agentRun06Fault) {
        const previous =
          phase === 'reopen'
            ? (JSON.parse(readFileSync(statePath, 'utf8')) as { taskId: string; late: { taskId: string } })
            : null
        report = await active.webContents.executeJavaScript(`(async()=>{
          const projectId=${JSON.stringify(projectId)},phase=${JSON.stringify(phase)},expectedTaskId=${JSON.stringify(previous?.taskId ?? null)},expectedLateTaskId=${JSON.stringify(previous?.late.taskId ?? null)};
          const value=reply=>{if(!reply.ok)throw new Error(reply.error.code);return reply.data};
          const delay=()=>new Promise(resolve=>setTimeout(resolve,100));
          const {ensureCanvasSaved}=await import('/src/canvas/flow-asset-actions.ts');
          const appStore=(await import('/src/stores/app.ts')).useAppStore;
          const editorStore=(await import('/src/stores/editor.ts')).useEditorStore;
          if(phase==='execute'){
            const editor=editorStore.getState().editor;
            editor.createShape({id:'shape:run06-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'本地材料',text:'run06 bounded fault fixture'}});
            editor.createShape({id:'shape:run06-processor',type:'node-card',x:850,y:100,props:{nodeType:'processor',title:'不得执行的处理器',config:JSON.stringify({operation:'pass'})}});
            const config={schemaVersion:1,role:'specialist',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:['shape:run06-processor'],maxSteps:4,relations:[]};
            editor.createShape({id:'shape:run06-agent',type:'node-card',x:100,y:450,props:{nodeType:'agent',title:'RUN-06 故障验收 Agent',text:'对授权处理器执行一次并依据回执结束。',config:JSON.stringify(config)}});
            const {createEdge}=await import('/src/canvas/graph.ts');
            createEdge(editor,{shapeId:'shape:run06-source',portId:'out-text'},{shapeId:'shape:run06-processor',portId:'in-value'});
            createEdge(editor,{shapeId:'shape:run06-source',portId:'out-text'},{shapeId:'shape:run06-agent',portId:'in-text'});
            await ensureCanvasSaved();
            const button=document.querySelector('[data-node-id="shape:run06-agent"] .node-standard-primary');
            if(!button||button.disabled)throw new Error('RUN06_AGENT_START_UNAVAILABLE');
            button.click();
          }else{
            const saved=value(await window.api.openProject(projectId));
            appStore.getState().openProject(saved.meta);
            for(let i=0;i<200;i++){if(editorStore.getState().editor?.getShape('shape:run06-late-agent'))break;if(i===199)throw new Error('RUN06_REOPEN_CANVAS_TIMEOUT');await delay();}
          }
          const read=async(nodeId='shape:run06-agent')=>value(await window.api.inspectFlowAgent({projectId,nodeId}));
          let task;
          for(let i=0;i<300;i++){
            task=await read();
            if(['failed','blocked'].includes(task?.state))break;
            if(task?.state==='completed')throw new Error('RUN06_FAULT_FALSE_SUCCESS');
            if(i===299)throw new Error('RUN06_FAILURE_TIMEOUT');
            await delay();
          }
          if(phase==='reopen'&&task?.taskId!==expectedTaskId)throw new Error('RUN06_FAILURE_TASK_ID_CHANGED');
          if(task?.code!=='AGENT_MODEL_FAILED')throw new Error('RUN06_FAILURE_CODE_INVALID');
          const editor=editorStore.getState().editor,agent=editor.getShape('shape:run06-agent'),processor=editor.getShape('shape:run06-processor');
          for(let i=0;i<100;i++){if(agent.props.exec==='failed')break;if(i===99)throw new Error('RUN06_FAILURE_NOT_RENDERED');await delay();}
          const statusLabel=document.querySelector('[data-node-id="shape:run06-agent"] .node-status')?.getAttribute('aria-label')||'';
          const processorRunCount=processor.meta.nodeRunHistory?.length||0;
          const {projectNodeOutputs}=await import('/src/nodes/nodeValues.ts');
          const agentOutputCount=Object.keys(projectNodeOutputs(agent)).length;
          if(!statusLabel.includes('运行失败'))throw new Error('RUN06_FAILURE_LABEL_MISSING');
          if(processorRunCount!==0||agentOutputCount!==0)throw new Error('RUN06_FALSE_OUTPUT_OR_SIDE_EFFECT');
          let late;
          if(phase==='execute'){
            editor.createShape({id:'shape:run06-late-processor',type:'node-card',x:850,y:820,props:{nodeType:'processor',title:'迟到响应不得触发的处理器',config:JSON.stringify({operation:'pass'})}});
            editor.createShape({id:'shape:run06-late-agent',type:'node-card',x:100,y:1150,props:{nodeType:'agent',title:'RUN06_LATE_CANCEL',text:'RUN06_LATE_CANCEL：等待本地模拟模型迟到响应并验证停止终态稳定。',config:JSON.stringify({...JSON.parse(agent.props.config),allowedNodeIds:['shape:run06-late-processor']})}});
            const {createEdge}=await import('/src/canvas/graph.ts');
            createEdge(editor,{shapeId:'shape:run06-source',portId:'out-text'},{shapeId:'shape:run06-late-processor',portId:'in-value'});
            createEdge(editor,{shapeId:'shape:run06-source',portId:'out-text'},{shapeId:'shape:run06-late-agent',portId:'in-text'});
            await ensureCanvasSaved();
            editor.select('shape:run06-late-agent');editor.zoomToSelection();
            const start=document.querySelector('[data-node-id="shape:run06-late-agent"] .node-standard-primary');
            if(!start||start.disabled)throw new Error('RUN06_LATE_START_UNAVAILABLE');
            start.click();
            let lateCurrent;
            for(let i=0;i<200;i++){lateCurrent=await read('shape:run06-late-agent');if(lateCurrent?.state==='running')break;if(['blocked','failed','completed'].includes(lateCurrent?.state))throw new Error('RUN06_LATE_TASK_DID_NOT_START');if(i===199)throw new Error('RUN06_LATE_START_TIMEOUT');await delay();}
            await new Promise(resolve=>setTimeout(resolve,500));
            const stop=document.querySelector('[data-node-id="shape:run06-late-agent"] .node-standard-primary');
            if(!stop||stop.disabled||!stop.textContent.includes('停止'))throw new Error('RUN06_LATE_STOP_CONTROL_UNAVAILABLE');
            stop.click();
            for(let i=0;i<100;i++){lateCurrent=await read('shape:run06-late-agent');if(lateCurrent?.state==='cancelled')break;if(i===99)throw new Error('RUN06_LATE_CANCEL_TIMEOUT');await delay();}
            const lateCancelledAtUtc=new Date().toISOString();
            await new Promise(resolve=>setTimeout(resolve,3800));
            late=await read('shape:run06-late-agent');
            if(late?.state!=='cancelled')throw new Error('RUN06_LATE_RESPONSE_CHANGED_TERMINAL');
            const lateAgent=editor.getShape('shape:run06-late-agent'),lateProcessor=editor.getShape('shape:run06-late-processor');
            const lateProcessorRunCount=lateProcessor.meta.nodeRunHistory?.length||0;
            const lateAgentOutputCount=Object.keys(projectNodeOutputs(lateAgent)).length;
            if(lateProcessorRunCount!==0||lateAgentOutputCount!==0)throw new Error('RUN06_LATE_RESPONSE_SIDE_EFFECT');
            await ensureCanvasSaved();
            late={taskId:late.taskId,taskState:late.state,taskCode:late.code||null,processorRunCount:lateProcessorRunCount,agentOutputCount:lateAgentOutputCount,cancelledAtUtc:lateCancelledAtUtc,verifiedAtUtc:new Date().toISOString()};
          }else{
            late=await read('shape:run06-late-agent');
            const lateAgent=editor.getShape('shape:run06-late-agent'),lateProcessor=editor.getShape('shape:run06-late-processor');
            const lateProcessorRunCount=lateProcessor?.meta.nodeRunHistory?.length||0;
            const lateAgentOutputCount=lateAgent?Object.keys(projectNodeOutputs(lateAgent)).length:-1;
            if(!late||late.taskId!==expectedLateTaskId||late.state!=='cancelled'||lateProcessorRunCount!==0||lateAgentOutputCount!==0)throw new Error('RUN06_LATE_FACTS_NOT_PERSISTED');
            late={taskId:late.taskId,taskState:late.state,taskCode:late.code||null,processorRunCount:lateProcessorRunCount,agentOutputCount:lateAgentOutputCount};
          }
          await ensureCanvasSaved();
          return {projectId,taskId:task.taskId,taskState:task.state,taskCode:task.code,nodeExec:agent.props.exec,processorRunCount,agentOutputCount,failureLabel:statusLabel,late,phase,checks:['synthetic provider failure becomes a failed Agent task','visible failed status is exposed to the canvas user','unauthorized successful output is not projected','downstream processor is not executed','failed facts are retained for reopen','cancelled Agent remains cancelled after delayed local provider response','late response creates no Agent output or processor execution','cancelled facts are retained for reopen']};
        })()`)
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
        else {
          const expected = JSON.parse(readFileSync(statePath, 'utf8')) as {
            taskId: string
            taskCode: string
            nodeExec: string
            processorRunCount: number
            agentOutputCount: number
            late: { taskId: string; taskState: string; taskCode: string | null; processorRunCount: number; agentOutputCount: number }
          }
          if (
            (report as { taskId?: string }).taskId !== expected.taskId ||
            (report as { taskCode?: string }).taskCode !== expected.taskCode ||
            (report as { nodeExec?: string }).nodeExec !== expected.nodeExec ||
            (report as { processorRunCount?: number }).processorRunCount !== expected.processorRunCount ||
            (report as { agentOutputCount?: number }).agentOutputCount !== expected.agentOutputCount ||
            (report as { late?: { taskId?: string; taskState?: string; taskCode?: string | null; processorRunCount?: number; agentOutputCount?: number } }).late?.taskId !== expected.late.taskId ||
            (report as { late?: { taskId?: string; taskState?: string; taskCode?: string | null; processorRunCount?: number; agentOutputCount?: number } }).late?.taskState !== expected.late.taskState ||
            ((report as { late?: { taskId?: string; taskState?: string; taskCode?: string | null; processorRunCount?: number; agentOutputCount?: number } }).late?.taskCode ?? null) !== expected.late.taskCode ||
            (report as { late?: { taskId?: string; taskState?: string; taskCode?: string | null; processorRunCount?: number; agentOutputCount?: number } }).late?.processorRunCount !== expected.late.processorRunCount ||
            (report as { late?: { taskId?: string; taskState?: string; taskCode?: string | null; processorRunCount?: number; agentOutputCount?: number } }).late?.agentOutputCount !== expected.late.agentOutputCount
          )
            throw new Error('RUN06_REOPEN_FACTS_CHANGED')
        }
      } else if (agentPerfMatrix) {
        const counts = [10, 50, 100]
        const groups: Array<Record<string, unknown>> = []
        let activeIds: string[] = []
        const perfEvidenceDir = process.env.CANVAS_AGENT_EVIDENCE_DIR
          ? resolve(process.env.CANVAS_AGENT_EVIDENCE_DIR)
          : null
        const delay = (ms: number): Promise<void> =>
          new Promise((done) => setTimeout(done, ms))
        const writeProgress = (value: Record<string, unknown>): void => {
          if (perfEvidenceDir)
            writeFileSync(join(perfEvidenceDir, 'agent-perf-progress.json'), JSON.stringify(value, null, 2))
        }
        const summarize = (values: number[]): { count: number; p50Ms: number; p95Ms: number; maxMs: number } => {
          const sorted = [...values].sort((left, right) => left - right)
          return {
            count: sorted.length,
            p50Ms: Math.round(sorted[Math.ceil(sorted.length * 0.5) - 1] * 100) / 100,
            p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 100) / 100,
            maxMs: Math.round(sorted.at(-1)! * 100) / 100
          }
        }
        const dispatchMouse = (
          type: 'mouseDown' | 'mouseUp' | 'mouseMove',
          x: number,
          y: number
        ): void => active.webContents.sendInputEvent({ type, x, y, button: 'left' })

        for (const count of counts) {
          stage = `PER02_SETUP_${count}`
          const columns = Math.ceil(Math.sqrt(count))
          const rows = Math.ceil(count / columns)
          const targetIndex = Math.floor((rows - 1) / 2) * columns + Math.floor((columns - 1) / 2)
          const ids = Array.from({ length: count }, (_, index) => `shape:per02-${count}-${index + 1}`)
          await active.webContents.executeJavaScript(`(async()=>{${common}
            const previous=${JSON.stringify(activeIds)};
            window.__per02Editor=editor;
            if(previous.length)editor.deleteShapes(previous);
            const count=${count};
            const columns=Math.ceil(Math.sqrt(count));
            const config={schemaVersion:1,role:'specialist',interactionMode:'collaborative',skills:[],tools:[],allowedNodeIds:[],maxSteps:8,relations:[]};
            for(let index=0;index<count;index++){
              const id='shape:per02-'+count+'-'+(index+1);
              editor.createShape({id,type:'node-card',x:(index%columns)*380,y:Math.floor(index/columns)*280,props:{nodeType:'agent',title:'PER-02 Agent '+(index+1),text:'PER-02 隔离画布交互基准，不启动任务。',config:JSON.stringify(config)}});
            }
            const bounds=editor.getCurrentPageBounds();if(!bounds)throw new Error('PER02_PAGE_BOUNDS_MISSING');editor.zoomToBounds(bounds,{immediate:true});
            await ensureCanvasSaved();
            return {agentCount:editor.getCurrentPageShapes().filter(shape=>shape.type==='node-card'&&shape.props.nodeType==='agent').length,domNodeCount:document.getElementsByTagName('*').length,jsHeapUsedBytes:performance.memory?.usedJSHeapSize??null};
          })()`)
          activeIds = ids
          const initial = (await active.webContents.executeJavaScript(
            `(async()=>{await new Promise(resolve=>setTimeout(resolve,32));const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const id=${JSON.stringify(ids[targetIndex])};const element=document.querySelector('[data-node-id="'+id+'"] .agent-flow-summary');if(!element)throw new Error('PER02_TARGET_NOT_VISIBLE');const rect=element.getBoundingClientRect();return {count:editor.getCurrentPageShapes().filter(shape=>shape.type==='node-card'&&shape.props.nodeType==='agent').length,camera:editor.getCamera(),target:{x:rect.x+rect.width/2,y:rect.y+rect.height/2,width:rect.width,height:rect.height},shape:editor.getShape(id),domNodeCount:document.getElementsByTagName('*').length,jsHeapUsedBytes:performance.memory?.usedJSHeapSize??null}})()`
          )) as {
            count: number
            camera: { x: number; y: number; z: number }
            target: { x: number; y: number; width: number; height: number }
            shape: { x: number; y: number }
            domNodeCount: number
            jsHeapUsedBytes: number | null
          }
          if (initial.count !== count || initial.target.width < 5 || initial.target.height < 3)
            throw new Error('PER02_CANVAS_SETUP_INVALID')
          writeProgress({ status: 'sampling', agentCount: count, samplesPerOperation: 30, completedPerOperation: 0 })
          await active.webContents
            .capturePage()
            .then((image) => writeFileSync(join(directory, `agent-perf-${count}.png`), image.toPNG()))

          const dragMs: number[] = []
          const zoomMs: number[] = []
          const panelOpenMs: number[] = []
          const panelCloseMs: number[] = []
          const targetId = ids[targetIndex]
          const pointForTarget = async (): Promise<{ x: number; y: number }> =>
            active.webContents.executeJavaScript(
              `(()=>{const id=${JSON.stringify(targetId)},element=document.querySelector('[data-node-id="'+id+'"] .agent-flow-summary');if(!element)throw new Error('PER02_TARGET_NOT_VISIBLE');const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`
            )
          const resetCamera = async (): Promise<void> =>
            active.webContents.executeJavaScript(
              `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const bounds=editor.getShapePageBounds(${JSON.stringify(targetId)});if(bounds)editor.zoomToBounds(bounds,{targetZoom:1,immediate:true,inset:0});await new Promise(resolve=>setTimeout(resolve,32))})()`
            )
          const shapePosition = async (): Promise<{ x: number; y: number }> =>
            active.webContents.executeJavaScript(
              `import('/src/stores/editor.ts').then(module=>{const shape=module.useEditorStore.getState().editor.getShape(${JSON.stringify(targetId)});return {x:shape.x,y:shape.y}})`
            )
          const waitForDrag = async (before: { x: number; y: number }): Promise<void> => {
            await active.webContents.executeJavaScript(
              `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;for(let i=0;i<80;i++){const shape=editor.getShape(${JSON.stringify(targetId)});if(shape.x!==${before.x}||shape.y!==${before.y}){await new Promise(resolve=>setTimeout(resolve,32));return;}await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('PER02_DRAG_NOT_OBSERVED')})()`
            )
          }
        const clickZoom = async (label: '放大' | '缩小'): Promise<number> =>
          active.webContents.executeJavaScript(
            `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const bounds=editor.getCurrentPageBounds();if(bounds)editor.zoomToBounds(bounds,{immediate:true});await new Promise(resolve=>setTimeout(resolve,32));const button=document.querySelector('[aria-label="${label}"]');if(!button)throw new Error('PER02_ZOOM_BUTTON_MISSING');const before=editor.getCamera().z;const started=performance.now();button.click();for(let i=0;i<120;i++){if(editor.getCamera().z!==before){await new Promise(resolve=>setTimeout(resolve,32));return performance.now()-started;}await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('PER02_ZOOM_NOT_OBSERVED')})()`
          )

          for (let index = 0; index < 30; index++) {
            stage = `PER02_${count}_DRAG_${index + 1}_RESET`
            await resetCamera()
            stage = `PER02_${count}_DRAG_${index + 1}_POINT`
            const point = await pointForTarget()
            stage = `PER02_${count}_DRAG_${index + 1}_POSITION`
            const before = await shapePosition()
            const dx = index % 2 === 0 ? 38 : -38
            const dy = index % 2 === 0 ? 22 : -22
            const started = performance.now()
            stage = `PER02_${count}_DRAG_${index + 1}_INPUT`
            await active.webContents.executeJavaScript(
              `(()=>{const hit=document.elementFromPoint(${point.x},${point.y});window.__per02LastInput=${JSON.stringify({ point, before, targetId })};window.__per02LastInput.hit=hit?{tag:hit.tagName,classes:String(hit.className||''),text:(hit.textContent||'').slice(0,80)}:null})()`
            )
            dispatchMouse('mouseMove', point.x, point.y)
            dispatchMouse('mouseDown', point.x, point.y)
            await delay(50)
            dispatchMouse('mouseMove', point.x + dx * 0.6, point.y + dy * 0.6)
            await delay(50)
            dispatchMouse('mouseMove', point.x + dx, point.y + dy)
            dispatchMouse('mouseUp', point.x + dx, point.y + dy)
            await waitForDrag(before)
            dragMs.push(performance.now() - started)

            stage = `PER02_${count}_ZOOM_${index + 1}`
            zoomMs.push(await clickZoom(index % 2 === 0 ? '放大' : '缩小'))
            await delay(220)

            stage = `PER02_${count}_PANEL_OPEN_${index + 1}`
            const openStarted = performance.now()
            await active.webContents.executeJavaScript(
              `(async()=>{const panel=(await import('/src/stores/nodePanel.ts')).useNodePanelStore;panel.getState().open('contract',${JSON.stringify(targetId)},'collaboration');for(let i=0;i<120;i++){const element=document.querySelector('.agent-collaboration');if(element){await new Promise(resolve=>setTimeout(resolve,32));return;}await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('PER02_PANEL_OPEN_TIMEOUT')})()`
            )
            panelOpenMs.push(performance.now() - openStarted)
            stage = `PER02_${count}_PANEL_CLOSE_${index + 1}`
            const closeStarted = performance.now()
            await active.webContents.executeJavaScript(
              `(async()=>{const panel=(await import('/src/stores/nodePanel.ts')).useNodePanelStore;panel.getState().close();for(let i=0;i<120;i++){if(!document.querySelector('.node-contract-panel')){await new Promise(resolve=>setTimeout(resolve,32));return;}await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('PER02_PANEL_CLOSE_TIMEOUT')})()`
            )
            panelCloseMs.push(performance.now() - closeStarted)
            if ((index + 1) % 5 === 0)
              writeProgress({
                status: 'sampling',
                agentCount: count,
                samplesPerOperation: 30,
                completedPerOperation: index + 1,
                operations: { drag: dragMs.length, zoom: zoomMs.length, panelOpen: panelOpenMs.length, panelClose: panelCloseMs.length }
              })
          }
          const final = await active.webContents.executeJavaScript(
            `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const panels=(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState();return {count:editor.getCurrentPageShapes().filter(shape=>shape.type==='node-card'&&shape.props.nodeType==='agent').length,selectedCount:editor.getSelectedShapeIds().length,camera:editor.getCamera(),panel:panels.kind,domNodeCount:document.getElementsByTagName('*').length,jsHeapUsedBytes:performance.memory?.usedJSHeapSize??null}})()`
          ) as { count: number; selectedCount: number; camera: { z: number }; panel: string | null; domNodeCount: number; jsHeapUsedBytes: number | null }
          if (final.count !== count || final.panel !== null || dragMs.length !== 30 || zoomMs.length !== 30 || panelOpenMs.length !== 30 || panelCloseMs.length !== 30)
            throw new Error('PER02_INTERACTION_MATRIX_INCOMPLETE')
          groups.push({
            agentCount: count,
            baseline: count === 10,
            warmupSamples: 0,
            start: { camera: initial.camera, targetSize: { width: initial.target.width, height: initial.target.height }, domNodeCount: initial.domNodeCount, jsHeapUsedBytes: initial.jsHeapUsedBytes },
            end: final,
            samples: { dragMs, zoomMs, panelOpenMs, panelCloseMs },
            latency: {
              drag: summarize(dragMs),
              zoom: summarize(zoomMs),
              panelOpen: summarize(panelOpenMs),
              panelClose: summarize(panelCloseMs)
            }
          })
          writeProgress({ status: 'group-complete', agentCount: count, completedPerOperation: 30 })
        }
        const rows = getDb().prepare('SELECT COUNT(*) AS count FROM flow_agent_tasks WHERE project_id=?').get(projectId) as { count: number }
        const commands = getDb().prepare('SELECT COUNT(*) AS count FROM flow_commands WHERE project_id=?').get(projectId) as { count: number }
        if (rows.count !== 0 || commands.count !== 0) throw new Error('PER02_FIXTURE_CREATED_AGENT_TASKS')
        const baseline = groups[0] as { latency: Record<string, { p50Ms: number; p95Ms: number }> }
        const comparison = groups.slice(1).map((group) => {
          const workload = group as { agentCount: number; latency: Record<string, { p50Ms: number; p95Ms: number }> }
          return {
            agentCount: workload.agentCount,
            relativeTo10Nodes: Object.fromEntries(Object.entries(workload.latency).map(([operation, stats]) => [operation, {
              p50Ratio: Math.round((stats.p50Ms / baseline.latency[operation].p50Ms) * 100) / 100,
              p95Ratio: Math.round((stats.p95Ms / baseline.latency[operation].p95Ms) * 100) / 100
            }]))
          }
        })
        const result = {
          status: 'completed',
          recordedAt: new Date().toISOString(),
          workload: { agentCounts: counts, measuredInteractionsPerOperationPerCount: 30, operations: ['drag', 'zoom', 'panelOpen', 'panelClose'], baselineAgentCount: 10 },
          environment: {
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            rendererPid: active.webContents.getOSProcessId(),
            cpuModel: cpus()[0]?.model ?? 'unknown',
            logicalProcessors: cpus().length,
            totalMemoryBytes: totalmem()
          },
          groups,
          comparison,
          projectId,
          agentTasks: rows.count,
          flowCommands: commands.count,
          note: 'Latencies use nearest-rank P50/P95 and include Electron input dispatch through observed state change plus a 32 ms renderer settle interval. The hidden Electron window does not guarantee animation frames, so frame-present latency is not measured. The 10-node group is the same-device baseline. No product threshold or OS low-memory/disk quota was applied.'
        }
        writeFileSync(join(directory, 'agent-perf-matrix.json'), JSON.stringify(result, null, 2))
        report = { performanceMatrix: 'completed', counts, baselineAgentCount: 10, measuredSamplesPerOperation: 30 }
        writeFileSync(statePath, JSON.stringify(report))
      } else if (agentPanelChurn) {
        await active.webContents.executeJavaScript(
          `(()=>{
            window.__per04Failures=[];
            const intervals=new Map(), intervalStats={created:0,cleared:0};
            const nativeSet=window.setInterval.bind(window), nativeClear=window.clearInterval.bind(window);
            window.setInterval=(handler,delay,...args)=>{const id=nativeSet(handler,delay,...args);intervals.set(id,Number(delay)||0);intervalStats.created++;return id;};
            window.clearInterval=id=>{if(intervals.delete(id))intervalStats.cleared++;return nativeClear(id);};
            window.__per04Intervals={active:intervals,stats:intervalStats};
            const activeByTarget=new WeakMap(), sourceCounts=new Map(), totals={added:0,removed:0,finalized:0,signalListenersUntracked:0};
            const nativeAdd=EventTarget.prototype.addEventListener, nativeRemove=EventTarget.prototype.removeEventListener;
            const targetName=target=>{try{if(target===window)return 'Window';if(target===document)return 'Document';if(target instanceof Element){const id=target.id?'#'+target.id:'';const classes=target.classList?.length?'.'+Array.from(target.classList).join('.'):'';const marker=target.getAttribute('data-testid')||target.getAttribute('data-node-id');return target.tagName.toLowerCase()+id+classes+(marker?'['+marker+']':'');}return Object.prototype.toString.call(target);}catch{return 'EventTarget';}};
            const targetRefs=new Map(), targetIds=new WeakMap();let nextTargetId=0;
            const trackTarget=target=>{if(targetIds.has(target))return;const id=++nextTargetId;targetIds.set(target,id);targetRefs.set(id,new WeakRef(target));};
            const activeTargets=()=>{const groups=new Map();for(const ref of targetRefs.values()){const target=ref.deref();if(!target)continue;let count=0;for(const registrations of activeByTarget.get(target)?.values()||[])count+=registrations.size;if(!count)continue;const name=targetName(target),connected=target.isConnected!==false,key=name+'|'+connected;const group=groups.get(key)||{target:name,connected,count:0};group.count++;groups.set(key,group);}return [...groups.values()].sort((a,b)=>b.count-a.count).slice(0,40);};
            const adjust=(key,delta)=>{const next=(sourceCounts.get(key)||0)+delta;if(next<=0)sourceCounts.delete(key);else sourceCounts.set(key,next);};
            const registry=new FinalizationRegistry(({key})=>{adjust(key,-1);totals.finalized++;});
            const audit={enabled:false,totals,reset(){sourceCounts.clear();totals.added=0;totals.removed=0;totals.finalized=0;totals.signalListenersUntracked=0;},snapshot(){const outstanding=[...sourceCounts].sort((a,b)=>b[1]-a[1]).map(([source,count])=>({source,count}));return {totals:{...totals},outstanding:outstanding.slice(0,40),globalOutstanding:outstanding.filter(entry=>/^(Window|Document|body|html)\\b/.test(entry.source)),activeTargets:activeTargets()};}};
            window.__per04ListenerAudit=audit;
            EventTarget.prototype.addEventListener=function(type,listener,options){
              if(audit.enabled&&listener){
                trackTarget(this);
                if(typeof options==='object'&&options?.signal)totals.signalListenersUntracked++;
                else {
                  let listeners=activeByTarget.get(this);if(!listeners){listeners=new Map();activeByTarget.set(this,listeners);}
                  let registrations=listeners.get(listener);if(!registrations){registrations=new Map();listeners.set(listener,registrations);}
                  const capture=typeof options==='boolean'?options:!!options?.capture, registrationKey=String(type)+'|'+capture;
                  if(!registrations.has(registrationKey)){
                    const stack=String(new Error().stack||'').split('\\n').slice(2,4).map(line=>line.trim()).join(' <- ');
                    const key=targetName(this)+' '+String(type)+' @ '+stack, token={};
                    registrations.set(registrationKey,{key,token});registry.register(this,{key},token);adjust(key,1);totals.added++;
                  }
                }
              }
              return nativeAdd.call(this,type,listener,options);
            };
            EventTarget.prototype.removeEventListener=function(type,listener,options){
              if(audit.enabled&&listener){
                const listeners=activeByTarget.get(this), registrations=listeners?.get(listener), capture=typeof options==='boolean'?options:!!options?.capture, registrationKey=String(type)+'|'+capture, entry=registrations?.get(registrationKey);
                if(entry){registrations.delete(registrationKey);if(registrations.size===0)listeners.delete(listener);if(listeners.size===0)activeByTarget.delete(this);registry.unregister(entry.token);adjust(entry.key,-1);totals.removed++;}
              }
              return nativeRemove.call(this,type,listener,options);
            };
            window.addEventListener('error',event=>window.__per04Failures.push({message:String(event.message||''),source:String(event.filename||''),line:event.lineno||0}));
            window.addEventListener('unhandledrejection',event=>window.__per04Failures.push({message:String(event.reason?.message||event.reason||'unhandled rejection')}));
          })()`
        )
        if (phase === 'execute') {
          const debuggerSession = active.webContents.debugger
          debuggerSession.attach('1.3')
          try {
            await debuggerSession.sendCommand('Performance.enable')
            if (agentPanelChurnForceGc) await debuggerSession.sendCommand('HeapProfiler.enable')
            const project = (await active.webContents.executeJavaScript(
              `(async()=>{${common}
                const config={schemaVersion:1,role:'specialist',interactionMode:'collaborative',skills:[],tools:[],allowedNodeIds:[],maxSteps:12,relations:[]};
                editor.createShape({id:'shape:per04-agent',type:'node-card',x:180,y:150,props:{nodeType:'agent',title:'PER-04 协作面板测试 Agent',text:'隔离面板挂载卸载测试，不启动任务。',config:JSON.stringify(config)}});
                await ensureCanvasSaved();
                const meta=value(await window.api.openProject(projectId)).meta;
                const appStore=(await import('/src/stores/app.ts')).useAppStore;
                const panelStore=(await import('/src/stores/nodePanel.ts')).useNodePanelStore;
                const editorStore=(await import('/src/stores/editor.ts')).useEditorStore;
                window.__per04EditorRefs=[];
                window.__per04DomRefs=[];
                const delay=()=>new Promise(resolve=>setTimeout(resolve,30));
                const waitForUi=async(test,code)=>{for(let i=0;i<200;i++){if(test())return;if(i===199)throw new Error(code);await delay();}};
                const panelCycle=async()=>{
                  panelStore.getState().open('contract','shape:per04-agent','collaboration');
                  await waitForUi(()=>{const panel=document.querySelector('.agent-collaboration');return !!panel&&panel.textContent?.includes('暂无任务。')===true;},'PER04_PANEL_OPEN_TIMEOUT');
                  panelStore.getState().close();
                  await waitForUi(()=>!document.querySelector('.node-contract-panel'),'PER04_PANEL_CLOSE_TIMEOUT');
                };
                const projectCycle=async()=>{
                  const current=appStore.getState().currentProject||meta;
                  const oldEditor=editorStore.getState().editor;
                  if(oldEditor)window.__per04EditorRefs.push({ref:new WeakRef(oldEditor),storeCleared:false});
                  const weak=(selector)=>{const element=document.querySelector(selector);return element?new WeakRef(element):null;};
                  window.__per04DomRefs.push({canvasHost:weak('.canvas-host'),tldrawContainer:weak('.tl-container'),nodeCard:weak('.node-card-wrap'),actionBar:weak('.node-standard-action-bar'),textarea:weak('textarea.node-textarea'),queueControl:weak('details.resource-queue-control'),brandIcon:weak('img.canvas-brand-icon')});
                  appStore.getState().setHome();
                  await waitForUi(()=>appStore.getState().view==='home'&&!document.querySelector('.canvas-host'),'PER04_CANVAS_UNMOUNT_TIMEOUT');
                  if(window.__per04EditorRefs.length)window.__per04EditorRefs[window.__per04EditorRefs.length-1].storeCleared=editorStore.getState().editor===null;
                  appStore.getState().openProject(current);
                  await waitForUi(()=>appStore.getState().view==='canvas'&&editorStore.getState().editor?.getShape('shape:per04-agent'),'PER04_CANVAS_REMOUNT_TIMEOUT');
                  await ensureCanvasSaved();
                };
                const pageInspectUi=()=>({view:appStore.getState().view,panel:panelStore.getState().kind,domNodeCount:document.getElementsByTagName('*').length,jsHeapUsedBytes:performance.memory?.usedJSHeapSize??null,canvasShapeCount:editorStore.getState().editor?.getCurrentPageShapes().length??0,editorStoreIsNull:editorStore.getState().editor===null,previousEditorRefs:window.__per04EditorRefs.map((entry,index)=>({index:index+1,storeCleared:entry.storeCleared,alive:!!entry.ref.deref()})),previousDomRefs:window.__per04DomRefs.map((entry,index)=>({index:index+1,alive:Object.fromEntries(Object.entries(entry).map(([key,ref])=>[key,!!ref?.deref()]))}))});
                await panelCycle();
                await projectCycle();
                await panelCycle();
                await projectCycle();
                await panelCycle();
                await new Promise(resolve=>setTimeout(resolve,2000));
                window.__per04EditorRefs=[];
                window.__per04DomRefs=[];
                window.__per04ListenerAudit.reset();
                window.__per04ListenerAudit.enabled=true;
                return {projectId,meta,warmup:pageInspectUi()};
              })()`
            )) as {
              projectId: string
              meta: {
                id: string
                name: string
                createdAt: number
                updatedAt: number
                graphVersion: number
              }
              warmup: { view: string; panel: string | null }
            }
            const metric = async (): Promise<Record<string, number>> => {
              const response = (await debuggerSession.sendCommand('Performance.getMetrics')) as {
                metrics: Array<{ name: string; value: number }>
              }
              return Object.fromEntries(
                response.metrics
                  .filter((item) =>
                    [
                      'Documents',
                      'Frames',
                      'JSEventListeners',
                      'Nodes',
                      'JSHeapUsedSize',
                      'JSHeapTotalSize'
                    ].includes(item.name)
                  )
                  .map((item) => [item.name, item.value])
              )
            }
            const pageInspect = async (): Promise<Record<string, unknown>> =>
              active.webContents.executeJavaScript(
                `(async()=>{const app=(await import('/src/stores/app.ts')).useAppStore.getState();const editorStore=(await import('/src/stores/editor.ts')).useEditorStore;const editor=editorStore.getState().editor;const panel=(await import('/src/stores/nodePanel.ts')).useNodePanelStore.getState();const queue=(await import('/src/engine/resource-queue.ts')).useResourceQueue.getState();const timers=window.__per04Intervals;return {view:app.view,panel:panel.kind,domNodeCount:document.getElementsByTagName('*').length,jsHeapUsedBytes:performance.memory?.usedJSHeapSize??null,canvasShapeCount:editor?.getCurrentPageShapes().length??0,queue:queue.tasks.length,activeIntervalCount:timers?.active.size??null,intervalsCreated:timers?.stats.created??null,intervalsCleared:timers?.stats.cleared??null,editorStoreIsNull:editorStore.getState().editor===null,rendererFailures:(window.__per04Failures||[]).slice(-20),previousEditorRefs:(window.__per04EditorRefs||[]).map((entry,index)=>({index:index+1,storeCleared:entry.storeCleared,alive:!!entry.ref.deref()})),previousDomRefs:(window.__per04DomRefs||[]).map((entry,index)=>({index:index+1,alive:Object.fromEntries(Object.entries(entry).map(([key,ref])=>[key,!!ref?.deref()]))}))}})()`
              )
            const sample = async (cycle: number): Promise<Record<string, unknown>> => {
              if (agentPanelChurnForceGc)
                await debuggerSession.sendCommand('HeapProfiler.collectGarbage')
              const rendererMetric = app
                .getAppMetrics()
                .find((item) => item.pid === active.webContents.getOSProcessId())
              return {
                cycle,
                timestamp: Date.now(),
                rendererId: active.webContents.id,
                rendererPid: active.webContents.getOSProcessId(),
                metrics: await metric(),
                page: await pageInspect(),
                listenerAudit: await active.webContents.executeJavaScript(
                  'window.__per04ListenerAudit.snapshot()'
                ),
                mainActiveHandles:
                  (
                    globalThis.process as unknown as { _getActiveHandles?: () => unknown[] }
                  )._getActiveHandles?.().length ?? null,
                rendererMemoryKB: rendererMetric?.memory.workingSetSize ?? null
              }
            }
            const samples: Array<Record<string, unknown>> = [await sample(0)]
            let projectCycles = 0
            const taskCountBefore = (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_agent_tasks WHERE project_id=?')
                .get(project.projectId) as { count: number }
            ).count
            const commandCountBefore = (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_commands WHERE project_id=?')
                .get(project.projectId) as { count: number }
            ).count
            if (taskCountBefore !== 0 || commandCountBefore !== 0)
              throw new Error('PER04_FIXTURE_NOT_EMPTY')
            await active.webContents
              .capturePage()
              .then((image) =>
                writeFileSync(join(directory, 'panel-churn-start.png'), image.toPNG())
              )
            for (let cycle = 1; cycle <= 30; cycle++) {
              await active.webContents.executeJavaScript(
                `(async()=>{const panel=(await import('/src/stores/nodePanel.ts')).useNodePanelStore;const delay=()=>new Promise(resolve=>setTimeout(resolve,30));const wait=async(test,code)=>{for(let i=0;i<200;i++){if(test())return;if(i===199)throw new Error(code);await delay();}};panel.getState().open('contract','shape:per04-agent','collaboration');await wait(()=>{const element=document.querySelector('.agent-collaboration');return !!element&&element.textContent?.includes('暂无任务。')===true;},'PER04_PANEL_OPEN_TIMEOUT');panel.getState().close();await wait(()=>!document.querySelector('.node-contract-panel'),'PER04_PANEL_CLOSE_TIMEOUT');})();`
              )
              if (cycle % 5 === 0) {
                await active.webContents.executeJavaScript(
                  `(async()=>{const app=(await import('/src/stores/app.ts')).useAppStore;const editor=(await import('/src/stores/editor.ts')).useEditorStore;const current=app.getState().currentProject;const oldEditor=editor.getState().editor;if(oldEditor)window.__per04EditorRefs.push({ref:new WeakRef(oldEditor),storeCleared:false});const weak=(selector)=>{const element=document.querySelector(selector);return element?new WeakRef(element):null;};window.__per04DomRefs.push({canvasHost:weak('.canvas-host'),tldrawContainer:weak('.tl-container'),nodeCard:weak('.node-card-wrap'),actionBar:weak('.node-standard-action-bar'),textarea:weak('textarea.node-textarea'),queueControl:weak('details.resource-queue-control'),brandIcon:weak('img.canvas-brand-icon')});app.getState().setHome();const delay=()=>new Promise(resolve=>setTimeout(resolve,30));for(let i=0;i<200;i++){if(app.getState().view==='home'&&!document.querySelector('.canvas-host'))break;if(i===199)throw new Error('PER04_CANVAS_UNMOUNT_TIMEOUT');await delay();}if(window.__per04EditorRefs.length)window.__per04EditorRefs[window.__per04EditorRefs.length-1].storeCleared=editor.getState().editor===null;app.getState().openProject(current);for(let i=0;i<200;i++){if(app.getState().view==='canvas'&&editor.getState().editor?.getShape('shape:per04-agent'))break;if(i===199)throw new Error('PER04_CANVAS_REMOUNT_TIMEOUT');await delay();}await (await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved();})();`
                )
                projectCycles++
              }
              samples.push(await sample(cycle))
            }
            // Record a second count after renderer cleanup and weak-reference
            // processing have had time to settle. The immediate cycle-30
            // sample remains the acceptance measurement for now.
            await new Promise<void>((resolve) => setTimeout(resolve, 2_000))
            if (agentPanelChurnForceGc)
              await debuggerSession.sendCommand('HeapProfiler.collectGarbage')
            const settledMetrics = await metric()
            const finalCounts = getDb()
              .prepare(
                'SELECT (SELECT COUNT(*) FROM flow_agent_tasks WHERE project_id=?) AS tasks,(SELECT COUNT(*) FROM flow_commands WHERE project_id=?) AS commands'
              )
              .get(project.projectId, project.projectId) as { tasks: number; commands: number }
            if (
              finalCounts.tasks !== taskCountBefore ||
              finalCounts.commands !== commandCountBefore ||
              samples.length !== 31 ||
              projectCycles !== 6
            )
              throw new Error('PER04_FACTS_CHANGED')
            await active.webContents
              .capturePage()
              .then((image) => writeFileSync(join(directory, 'panel-churn-end.png'), image.toPNG()))
            writeFileSync(
              join(directory, 'panel-churn-samples.jsonl'),
              samples.map((item) => JSON.stringify(item)).join('\n') + '\n'
            )
            if (agentPanelChurnForceGc && agentPanelChurnHeapSnapshot) {
              await debuggerSession.sendCommand('HeapProfiler.collectGarbage')
              const snapshotChunks: string[] = []
              const onHeapSnapshotMessage = (
                _event: Electron.Event,
                method: string,
                params: { chunk?: string }
              ): void => {
                if (method === 'HeapProfiler.addHeapSnapshotChunk' && params.chunk)
                  snapshotChunks.push(params.chunk)
              }
              debuggerSession.on('message', onHeapSnapshotMessage)
              try {
                await debuggerSession.sendCommand('HeapProfiler.takeHeapSnapshot', {
                  reportProgress: false,
                  captureNumericValue: true
                })
              } finally {
                debuggerSession.removeListener('message', onHeapSnapshotMessage)
              }
              writeFileSync(
                join(directory, 'per04-heap-snapshot.heapsnapshot'),
                snapshotChunks.join(''),
                'utf8'
              )
              const trackedObjects: Array<Record<string, unknown>> = []
              const eventListenerDetails: Array<Record<string, unknown>> = []
              const captureEventListeners = async (
                label: string,
                expression: string
              ): Promise<void> => {
                const evaluated = (await debuggerSession.sendCommand('Runtime.evaluate', {
                  expression,
                  returnByValue: false,
                  objectGroup: 'per04-event-listeners'
                })) as { result?: { type?: string; subtype?: string; objectId?: string; className?: string } }
                const remote = evaluated.result
                if (!remote?.objectId || remote.subtype === 'null') {
                  eventListenerDetails.push({ label, available: false })
                  return
                }
                try {
                  const result = (await debuggerSession.sendCommand(
                    'DOMDebugger.getEventListeners',
                    { objectId: remote.objectId, depth: 0, pierce: false }
                  )) as {
                    eventListeners?: Array<{
                      type?: string
                      useCapture?: boolean
                      passive?: boolean
                      once?: boolean
                      scriptId?: string
                      lineNumber?: number
                      columnNumber?: number
                      handler?: { description?: string; functionName?: string }
                    }>
                  }
                  const listeners = (result.eventListeners ?? []).map((listener) => ({
                    type: listener.type,
                    useCapture: listener.useCapture,
                    passive: listener.passive,
                    once: listener.once,
                    functionName: listener.handler?.functionName ?? '',
                    description: listener.handler?.description?.slice(0, 180) ?? '',
                    scriptId: listener.scriptId,
                    lineNumber: listener.lineNumber,
                    columnNumber: listener.columnNumber
                  }))
                  eventListenerDetails.push({
                    label,
                    className: remote.className ?? remote.type,
                    count: listeners.length,
                    listeners
                  })
                } catch (error) {
                  eventListenerDetails.push({
                    label,
                    className: remote.className ?? remote.type,
                    error: error instanceof Error ? error.message : String(error)
                  })
                }
              }
              const trackedCounts = (await active.webContents.executeJavaScript(
                '({editors:window.__per04EditorRefs?.length??0,dom:window.__per04DomRefs?.length??0})'
              )) as { editors: number; dom: number }
              for (const [label, expression] of [
                ['window', 'window'],
                ['document', 'document'],
                ['body', 'document.body']
              ]) {
                await captureEventListeners(label, expression)
              }
              for (let index = 0; index < trackedCounts.dom; index++) {
                for (const key of ['canvasHost', 'tldrawContainer', 'nodeCard', 'actionBar']) {
                  await captureEventListeners(
                    `old-dom-${index + 1}-${key}`,
                    `window.__per04DomRefs[${index}].${key}?.deref()`
                  )
                }
              }
              await debuggerSession
                .sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'per04-event-listeners' })
                .catch(() => undefined)
              writeFileSync(
                join(directory, 'per04-event-listeners.json'),
                JSON.stringify(
                  { capturedAt: new Date().toISOString(), targets: eventListenerDetails },
                  null,
                  2
                )
              )
              const captureHeapObject = async (
                label: string,
                expression: string
              ): Promise<void> => {
                const evaluated = (await debuggerSession.sendCommand('Runtime.evaluate', {
                  expression,
                  returnByValue: false,
                  objectGroup: 'per04-heap-audit'
                })) as { result?: { type?: string; subtype?: string; objectId?: string; className?: string } }
                const remote = evaluated.result
                if (!remote?.objectId || remote.subtype === 'null') {
                  trackedObjects.push({ label, available: false })
                  return
                }
                const heapObject = (await debuggerSession.sendCommand('HeapProfiler.getHeapObjectId', {
                  objectId: remote.objectId
                })) as { heapSnapshotObjectId?: string }
                trackedObjects.push({
                  label,
                  available: true,
                  className: remote.className ?? remote.type,
                  heapSnapshotObjectId: heapObject.heapSnapshotObjectId
                })
              }
              for (let index = 0; index < trackedCounts.editors; index++) {
                await captureHeapObject(
                  `old-editor-${index + 1}`,
                  `window.__per04EditorRefs[${index}].ref.deref()`
                )
              }
              for (let index = 0; index < trackedCounts.dom; index++) {
                for (const key of ['canvasHost', 'tldrawContainer', 'nodeCard', 'actionBar']) {
                  await captureHeapObject(
                    `old-dom-${index + 1}-${key}`,
                    `window.__per04DomRefs[${index}].${key}?.deref()`
                  )
                }
              }
              await debuggerSession
                .sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'per04-heap-audit' })
                .catch(() => undefined)
              writeFileSync(
                join(directory, 'per04-heap-object-ids.json'),
                JSON.stringify(
                  {
                    capturedAt: new Date().toISOString(),
                    rendererId: active.webContents.id,
                    rendererPid: active.webContents.getOSProcessId(),
                    objects: trackedObjects
                  },
                  null,
                  2
                )
              )
            }
            const beforeMetric = samples[0].metrics as Record<string, number>
            const immediateAfterMetric = samples.at(-1)?.metrics as Record<string, number>
            const beforePage = samples[0].page as Record<string, number | null>
            const afterPage = samples.at(-1)?.page as Record<string, number | null>
            const listenerDelta =
              immediateAfterMetric.JSEventListeners - beforeMetric.JSEventListeners
            const listenerSettledDelta =
              settledMetrics.JSEventListeners - beforeMetric.JSEventListeners
            const listenerGrowthLimit = Math.max(
              100,
              Math.ceil(beforeMetric.JSEventListeners * 0.25)
            )
            const intervalDelta =
              beforePage.activeIntervalCount === null || afterPage.activeIntervalCount === null
                ? null
                : afterPage.activeIntervalCount - beforePage.activeIntervalCount
            const listenerCleanupFailed = listenerDelta > listenerGrowthLimit
            const intervalCleanupFailed = intervalDelta !== null && intervalDelta > 0
            const acceptanceStatus =
              listenerCleanupFailed || intervalCleanupFailed ? 'failed' : 'pass'
            report = {
              projectId: project.projectId,
              rounds: 30,
              panelOpenCloseCycles: 30,
              projectCanvasUnmountRemountCycles: projectCycles,
              rendererId: active.webContents.id,
              rendererPid: active.webContents.getOSProcessId(),
              sampleCount: samples.length,
              taskCount: finalCounts.tasks,
              commandCount: finalCounts.commands,
              listenerStart: beforeMetric.JSEventListeners,
              listenerEnd: immediateAfterMetric.JSEventListeners,
              listenerSettledEnd: settledMetrics.JSEventListeners,
              listenerDelta,
              listenerSettledDelta,
              listenerGrowthLimit,
              domStart: beforePage.domNodeCount,
              domEnd: afterPage.domNodeCount,
              activeIntervalsStart: beforePage.activeIntervalCount,
              activeIntervalsEnd: afterPage.activeIntervalCount,
              activeIntervalDelta: intervalDelta,
              forcedGcSamples: agentPanelChurnForceGc ? samples.length : 0,
              warmupIdleMs: 2000,
              acceptance: {
                status: acceptanceStatus,
                listenerCleanup: listenerCleanupFailed ? 'failed' : 'pass',
                intervalCleanup: intervalCleanupFailed ? 'failed' : 'pass',
                criteria:
                  'after 30 closed-panel cycles, listeners may grow at most 25% (minimum allowance 100); global active setInterval count must return to its post-warmup baseline',
                pollingMeasurement:
                  'global window.setInterval calls made after instrumentation was installed'
              },
              checks: [
                '30 collaboration-panel open/close cycles',
                'six project/canvas unmount/remount cycles',
                'same renderer observed via CDP',
                'no Agent task or command side effects',
                'per-cycle CDP listener/node/heap, renderer memory, and active global interval samples',
                ...(agentPanelChurnForceGc
                  ? ['forced CDP garbage collection before every baseline and cycle sample']
                  : [])
              ]
            }
            if (acceptanceStatus === 'failed') failed = true
            writeFileSync(statePath, JSON.stringify({ projectId: project.projectId }))
          } finally {
            debuggerSession.detach()
          }
        } else {
          const reopen = (await active.webContents.executeJavaScript(
            `(async()=>{const app=(await import('/src/stores/app.ts')).useAppStore.getState();const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const file=await window.api.openProject(${JSON.stringify(projectId)});if(!file.ok)throw new Error('PER04_REOPEN_PROJECT_FAILED');const agent=editor?.getShape('shape:per04-agent');if(!agent||app.currentProject?.id!==${JSON.stringify(projectId)})throw new Error('PER04_REOPEN_STATE_MISSING');const facts=await window.api.inspectFlowAgent({projectId:${JSON.stringify(projectId)},nodeId:'shape:per04-agent'});if(!facts.ok&&facts.error.code!=='AGENT_TASK_NOT_FOUND')throw new Error('PER04_REOPEN_AGENT_FACT_FAILED');return {projectId:${JSON.stringify(projectId)},agentShapePresent:true,view:app.view,persisted:true};})()`
          )) as { projectId: string; agentShapePresent: boolean; view: string; persisted: boolean }
          const counts = getDb()
            .prepare(
              'SELECT (SELECT COUNT(*) FROM flow_agent_tasks WHERE project_id=?) AS tasks,(SELECT COUNT(*) FROM flow_commands WHERE project_id=?) AS commands'
            )
            .get(projectId, projectId) as { tasks: number; commands: number }
          if (!reopen.agentShapePresent || counts.tasks !== 0 || counts.commands !== 0)
            throw new Error('PER04_REOPEN_FACTS_CHANGED')
          report = { ...reopen, tasks: counts.tasks, commands: counts.commands, noReplay: true }
        }
      } else if (agentGate) {
        const gateFailureCount = async (): Promise<number> => {
          await diagnostics.flushNow()
          const result = await diagnostics.query({ limit: 5000 })
          return result.events.filter(
            (event) =>
              event.event === 'command.operation.failed' &&
              event.nodeId === 'shape:c3-agent' &&
              event.attributes?.code === 'FLOW_REVIEW_NOT_READY'
          ).length
        }
        const modelRequestCount = async (): Promise<number> => {
          await diagnostics.flushNow()
          const result = await diagnostics.query({ limit: 5000 })
          return result.events.filter((event) => event.event === 'model.request.started').length
        }
        const waitForGateFailureCount = async (expected: number): Promise<void> => {
          for (let attempt = 0; attempt < 40; attempt++) {
            if ((await gateFailureCount()) === expected) return
            await new Promise((done) => setTimeout(done, 50))
          }
          throw new Error('CMD08_AGENT_GATE_ENTRY_NOT_RECORDED')
        }
        if (phase === 'execute') {
          report = await active.webContents.executeJavaScript(`(async()=>{${common}
            const {createEdge}=await import('/src/canvas/graph.ts');
            editor.createShape({id:'shape:c3-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'固定材料',text:'private-c3-gate-material'}});
            editor.createShape({id:'shape:c3-agent',type:'node-card',x:650,y:100,props:{nodeType:'agent',title:'受审核 Agent',text:'执行授权处理并交付固定结果。',config:JSON.stringify({schemaVersion:1,role:'specialist',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:['shape:c3-worker'],maxSteps:8,relations:[]})}});
            editor.createShape({id:'shape:c3-worker',type:'node-card',x:1100,y:100,props:{nodeType:'processor',title:'授权处理',config:JSON.stringify({operation:'pass'})}});
            editor.createShape({id:'shape:c3-review',type:'node-card',x:400,y:520,props:{nodeType:'ai-review',title:'尚未完成的审核',text:'检查固定材料是否达到交付要求。',config:JSON.stringify({schemaVersion:1,rulesVersion:'rules-1',modelDefinitionId:'agent-test-model',rejectPolicy:'stop',maxReworks:0,responsibleNodeId:'shape:c3-source',subjectSources:[{nodeId:'shape:c3-source',portId:'out-text'}],gatedNodeIds:['shape:c3-agent'],relations:[]})}});
            for(const [from,port,to,target] of [['shape:c3-source','out-text','shape:c3-review','in-text'],['shape:c3-source','out-text','shape:c3-agent','in-text'],['shape:c3-source','out-text','shape:c3-worker','in-value']])if(!createEdge(editor,{shapeId:from,portId:port},{shapeId:to,portId:target}))throw new Error('CMD08_AGENT_GATE_EDGE_MISSING');
            await ensureCanvasSaved();
            const title=document.querySelector('[data-node-id="shape:c3-agent"] .node-run-btn');if(!title||title.disabled)throw new Error('CMD08_AGENT_TITLE_ENTRY_UNAVAILABLE');title.click();
            return {projectId,agentNodeId:'shape:c3-agent',entries:['title']};
          })()`)
          await waitForGateFailureCount(1)
          const entries = ['title']
          for (const entry of ['footer', 'multi-select']) {
            await active.webContents.executeJavaScript(
              `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const delay=()=>new Promise(r=>setTimeout(r,50));if(${JSON.stringify(entry)}==='footer'){const button=[...document.querySelectorAll('[data-node-id="shape:c3-agent"] .node-standard-primary')].find(node=>node.textContent.trim()==='启动任务');if(!button||button.disabled)throw new Error('CMD08_AGENT_FOOTER_ENTRY_UNAVAILABLE');button.click();return;}editor.select('shape:c3-source','shape:c3-agent');editor.zoomToSelection();for(let i=0;i<40;i++){const button=document.querySelector('[data-tool="run"]');if(button){button.click();return;}await delay();}throw new Error('CMD08_AGENT_MULTISELECT_ENTRY_UNAVAILABLE');})()`
            )
            await waitForGateFailureCount(entries.length + 1)
            entries.push(entry)
          }
          const manual = await active.webContents.executeJavaScript(
            `(async()=>{${common}const {runNodeManually}=await import('/src/engine/executor.ts');const result=await runNodeManually(editor,projectId,[],'shape:c3-agent');return {status:result.status,reason:result.reason};})()`
          )
          if (manual.status !== 'skipped' || !String(manual.reason).includes('审核节点'))
            throw new Error('CMD08_AGENT_MANUAL_GATE_CONTRACT_FAILED')
          await waitForGateFailureCount(4)
          if (
            (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_agent_tasks WHERE project_id=?')
                .get(projectId) as { count: number }
            ).count !== 0 ||
            (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_commands WHERE project_id=?')
                .get(projectId) as { count: number }
            ).count !== 0 ||
            (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_reviews WHERE project_id=?')
                .get(projectId) as { count: number }
            ).count !== 0
          )
            throw new Error('CMD08_AGENT_GATE_CREATED_EXECUTION_FACTS')
          if ((await modelRequestCount()) !== 0)
            throw new Error('CMD08_AGENT_GATE_SENT_MODEL_REQUEST')
          report = {
            ...(report as object),
            entries: [...entries, 'manual-api'],
            manual,
            gateFailures: await gateFailureCount(),
            databaseFacts: { agentTasks: 0, commands: 0, reviews: 0 },
            modelRequests: await modelRequestCount(),
            checks: [
              'Agent title run enters the shared public admission gate',
              'Agent footer start enters the shared public admission gate',
              'multi-select run enters the shared public admission gate',
              'direct manual executor returns the same review-gated skip',
              'blocked entries create no Agent task, command, review or model request'
            ]
          }
          writeFileSync(statePath, JSON.stringify(report))
        } else {
          const priorGateFailures = await gateFailureCount()
          report = await active.webContents.executeJavaScript(`(async()=>{${common}
            const gate=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:c3-agent'});
            if(gate.ok||gate.error.code!=='FLOW_REVIEW_NOT_READY')throw new Error('CMD08_AGENT_GATE_DID_NOT_SURVIVE_REOPEN');
            const saved=value(await window.api.openProject(projectId));
            const agent=saved.nodes.find(node=>node.id==='shape:c3-agent');
            const review=saved.nodes.find(node=>node.id==='shape:c3-review');
            if(!agent||!review||!JSON.parse(review.params.config).gatedNodeIds.includes('shape:c3-agent'))throw new Error('CMD08_AGENT_GATE_GRAPH_NOT_PERSISTED');
            return {projectId,gateCode:gate.error.code,persistedGate:true};
          })()`)
          await waitForGateFailureCount(priorGateFailures + 1)
          const previous = JSON.parse(readFileSync(statePath, 'utf8')) as { entries: string[] }
          if (previous.entries.join(',') !== 'title,footer,multi-select,manual-api')
            throw new Error('CMD08_AGENT_GATE_ENTRY_FACTS_NOT_PERSISTED')
          if (
            (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_agent_tasks WHERE project_id=?')
                .get(projectId) as { count: number }
            ).count !== 0 ||
            (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_commands WHERE project_id=?')
                .get(projectId) as { count: number }
            ).count !== 0 ||
            (
              getDb()
                .prepare('SELECT COUNT(*) AS count FROM flow_reviews WHERE project_id=?')
                .get(projectId) as { count: number }
            ).count !== 0
          )
            throw new Error('CMD08_AGENT_GATE_FACTS_CHANGED_AFTER_REOPEN')
          report = { ...(report as object), originalEntriesAfterReopen: previous.entries }
        }
      } else if (agentUnknown) {
        const occupancyBlockCount = async (): Promise<number> => {
          await diagnostics.flushNow()
          const result = await diagnostics.query({ limit: 5000 })
          return result.events.filter(
            (event) =>
              event.event === 'agent.runtime.blocked' &&
              event.nodeId === 'shape:c3-agent' &&
              event.attributes?.code === 'FLOW_NODE_OCCUPIED'
          ).length
        }
        if (phase === 'execute') {
          report = await active.webContents.executeJavaScript(`(async()=>{${common}
            const {createEdge}=await import('/src/canvas/graph.ts');
            const bridge=await import('/src/engine/flow-command-bridge.ts');
            editor.createShape({id:'shape:c3-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'固定材料',text:'private-c3-unknown-footer-material'}});
            editor.createShape({id:'shape:c3-agent',type:'node-card',x:650,y:100,props:{nodeType:'agent',title:'占用检查 Agent',text:'尝试执行授权处理并保留真实失败状态。',config:JSON.stringify({schemaVersion:1,role:'specialist',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:['shape:c3-worker'],maxSteps:8,relations:[]})}});
            editor.createShape({id:'shape:c3-worker',type:'node-card',x:1100,y:100,props:{nodeType:'processor',title:'已占用处理',config:JSON.stringify({operation:'pass'})}});
            for(const [from,port,to,target] of [['shape:c3-source','out-text','shape:c3-agent','in-text'],['shape:c3-source','out-text','shape:c3-worker','in-value']])if(!createEdge(editor,{shapeId:from,portId:port},{shapeId:to,portId:target}))throw new Error('CMD08_UNKNOWN_FOOTER_EDGE_MISSING');
            await ensureCanvasSaved();
            const file=value(await window.api.openProject(projectId));
            const asset=value(await window.api.submitFlowAsset({projectId,nodeId:'shape:c3-source',portId:'out-text',submissionId:'cmd08-unknown-footer-source',expectedGraphVersion:file.meta.graphVersion,traceId:'trace-cmd08-source',spanId:'span-cmd08-source'}));
            const command={schemaVersion:1,kind:'node.execute',commandId:'cmd08-unknown-footer-reservation',projectId,taskId:'cmd08-reservation-task',agentNodeId:'shape:c3-agent',targetNodeId:'shape:c3-worker',contractVersion:1,expectedSemanticRevision:await bridge.canvasSemanticRevision(editor,file),inputs:[{targetPortId:'in-value',assets:[asset.ref]}],traceId:'trace-cmd08-reservation',spanId:'span-cmd08-reservation'};
            const prepared=value(await window.api.prepareFlowCommand(command));
            if(prepared.state!=='ready')throw new Error('CMD08_UNKNOWN_FOOTER_RESERVATION_NOT_PREPARED');
            const unknown=value(await window.api.markFlowCommandUnknown({projectId,commandId:command.commandId,leaseId:prepared.grant.leaseId}));
            if(unknown.state!=='unknown')throw new Error('CMD08_UNKNOWN_FOOTER_RESERVATION_NOT_UNKNOWN');
            const beforeHistory=editor.getShape('shape:c3-worker').meta.nodeRunHistory?.length||0;
            const worker=editor.getShape('shape:c3-worker');const beforeExec=worker.props.exec;const beforeResult=worker.meta.nodeResult??null;
            const runButton=document.querySelector('[data-node-id="shape:c3-worker"] .node-run-btn');
            if(!runButton||runButton.disabled)throw new Error('REL03_OCCUPIED_MANUAL_BUTTON_UNAVAILABLE');
            runButton.click();
            const toastStore=await import('/src/stores/toast.ts');let manualToast=null;
            for(let i=0;i<40;i++){manualToast=toastStore.useToastStore.getState().msg;if(manualToast)break;await new Promise(done=>setTimeout(done,25));}
            const afterManual=editor.getShape('shape:c3-worker');const afterHistory=afterManual.meta.nodeRunHistory?.length||0;
            if(manualToast!=='该节点由主 Agent 协调，请先停止对应流程'||afterHistory!==beforeHistory||afterManual.props.exec!==beforeExec||(afterManual.meta.nodeResult??null)!==beforeResult)throw new Error('REL03_OCCUPIED_MANUAL_ENTRY_NOT_BLOCKED:'+JSON.stringify({manualToast,beforeHistory,afterHistory,beforeExec,afterExec:afterManual.props.exec,beforeResult,afterResult:afterManual.meta.nodeResult??null}));
            const manualAttempt={buttonClicked:true,toast:manualToast,beforeHistory,afterHistory,beforeExec,afterExec:afterManual.props.exec,outputUnchanged:(afterManual.meta.nodeResult??null)===beforeResult};
            const button=[...document.querySelectorAll('[data-node-id="shape:c3-agent"] .node-standard-primary')].find(node=>node.textContent.trim()==='启动任务');
            if(!button||button.disabled)throw new Error('CMD08_UNKNOWN_FOOTER_ENTRY_UNAVAILABLE');
            button.click();
            return {projectId,agentNodeId:'shape:c3-agent',commandId:command.commandId,beforeHistory,manualAttempt};
          })()`)
          const state = report as {
            projectId: string
            agentNodeId: string
            commandId: string
            beforeHistory: number
            manualAttempt: { buttonClicked: boolean; toast: string; beforeHistory: number; afterHistory: number; beforeExec: string; afterExec: string; outputUnchanged: boolean }
          }
          let blocked = false
          for (let attempt = 0; attempt < 200; attempt++) {
            if ((await occupancyBlockCount()) > 0) {
              blocked = true
              break
            }
            await new Promise((done) => setTimeout(done, 50))
          }
          if (!blocked) throw new Error('CMD08_UNKNOWN_FOOTER_OCCUPANCY_NOT_RECORDED')
          const commandCount = Number(
            (getDb().prepare('SELECT COUNT(*) AS count FROM flow_commands WHERE project_id=?').get(state.projectId) as { count: number }).count
          )
          if (commandCount !== 1) throw new Error(`REL03_OCCUPIED_MANUAL_CREATED_COMMAND_${commandCount}`)
          await diagnostics.flushNow()
          const manualGateEvents = (await diagnostics.query({ limit: 5000 })).events.filter(
            (event) => event.event === 'command.operation.failed' &&
              event.nodeId === 'shape:c3-worker' &&
              event.attributes?.phase === 'occupancy' &&
              event.attributes?.code === 'FLOW_NODE_OCCUPIED'
          )
          if (manualGateEvents.length !== 1) throw new Error(`REL03_OCCUPIED_MANUAL_GATE_EVENT_COUNT_${manualGateEvents.length}`)
          const afterAction = await active.webContents.executeJavaScript(`(async()=>{${common}
            const receipt=value(await window.api.lookupFlowCommand({projectId,commandId:'cmd08-unknown-footer-reservation'}));
            const history=editor.getShape('shape:c3-worker').meta.nodeRunHistory?.length||0;
            if(receipt.state!=='unknown'||history!==${JSON.stringify(state.beforeHistory)})throw new Error('CMD08_UNKNOWN_FOOTER_OCCUPANCY_EFFECT');
            const beforeStop=await inspect();
            if(beforeStop?.state!=='blocked')throw new Error('CMD08_UNKNOWN_FOOTER_TASK_NOT_BLOCKED');
            const stopped=value(await window.api.stopFlowAgent({projectId,nodeId:'shape:c3-agent'}));
            if(stopped?.state!=='cancelled')throw new Error('CMD08_UNKNOWN_FOOTER_TASK_CLEANUP_FAILED');
            return {receiptState:receipt.state,workerHistory:history,taskStateBeforeStop:beforeStop.state,taskStateAfterStop:stopped.state};
          })()`)
          writeFileSync(statePath, JSON.stringify({ ...state, afterAction, commandCount }))
          report = {
            ...state,
            ...afterAction,
            commandCount,
            manualGateEvents: manualGateEvents.map((event) => ({ event: event.event, phase: event.attributes?.phase, code: event.attributes?.code, nodeId: event.nodeId })),
            occupancyBlocks: await occupancyBlockCount(),
            modelRequests: (await diagnostics.query({ limit: 5000 })).events.filter(
              (event) => event.event === 'model.request.started'
            ).length,
            checks: [
              'Agent footer starts the Agent task in the real canvas UI',
              'Agent runtime blocks the tool call with FLOW_NODE_OCCUPIED before command creation',
              'legacy target manual run button displays the shared occupancy block and creates no run/output/command',
              'unknown receipt and worker output history remain unchanged',
              'blocked Agent task is explicitly stopped after evidence capture'
            ]
          }
        } else {
          const previous = JSON.parse(readFileSync(statePath, 'utf8')) as {
            projectId: string
            agentNodeId: string
            commandId: string
            afterAction: { receiptState: string; workerHistory: number }
            manualAttempt: { buttonClicked: boolean; toast: string; beforeHistory: number; afterHistory: number; beforeExec: string; afterExec: string; outputUnchanged: boolean }
            commandCount: number
          }
          report = await active.webContents.executeJavaScript(`(async()=>{${common}
            const receipt=value(await window.api.lookupFlowCommand({projectId,commandId:${JSON.stringify(previous.commandId)}}));
            const task=await inspect();
            const history=editor.getShape('shape:c3-worker').meta.nodeRunHistory?.length||0;
            if(receipt.state!=='unknown'||history!==${JSON.stringify(previous.afterAction.workerHistory)})throw new Error('CMD08_UNKNOWN_FOOTER_REOPEN_CHANGED_FACTS');
            return {projectId,receiptState:receipt.state,workerHistory:history,taskState:task?.state||null,persistedUnknown:true};
          })()`)
          const currentBlockCount = await occupancyBlockCount()
          if (currentBlockCount < 1)
            throw new Error('CMD08_UNKNOWN_FOOTER_OCCUPANCY_DIAGNOSTIC_MISSING')
          report = {
            ...(report as object),
            occupancyBlocks: currentBlockCount,
            manualAttempt: previous.manualAttempt,
            commandCount: previous.commandCount,
            checks: [
              'unknown reservation persists after a second process opens the project',
              'reopen does not replay the blocked Agent action'
            ]
          }
        }
      } else if (agentResidency) {
        const samplePath = join(directory, 'residency-samples.jsonl')
        const processPath = join(directory, 'residency-processes.json')
        if (phase === 'execute') {
          const setup = await active.webContents.executeJavaScript(`(async()=>{${common}
            const {createEdge}=await import('/src/canvas/graph.ts');
            // Mirrors src/renderer/src/engine/runRecord.ts; recent node-run history is capped.
            const NODE_RUN_HISTORY_LIMIT=12;
            const delay=()=>new Promise(done=>setTimeout(done,100));
            for(let attempt=0;!document.querySelector('.canvas-page');attempt++){if(attempt>600)throw new Error('PER01_CANVAS_PAGE_TIMEOUT');await delay();}
            editor.createShape({id:'shape:per01-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'固定长驻材料',text:'private-per01-residency-material'}});
            editor.createShape({id:'shape:c3-worker',type:'node-card',x:1100,y:100,props:{nodeType:'processor',title:'长驻本地处理',config:JSON.stringify({operation:'pass'})}});
            editor.createShape({id:'shape:c3-agent',type:'node-card',x:600,y:400,props:{nodeType:'agent',title:'长驻 Agent',text:'每轮调用本地处理两次，等待人工确认后继续并交付固定成果。',config:JSON.stringify({schemaVersion:1,role:'specialist',interactionMode:'collaborative',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:['shape:c3-worker'],maxSteps:12,relations:[]})}});
            if(!createEdge(editor,{shapeId:'shape:per01-source',portId:'out-text'},{shapeId:'shape:c3-agent',portId:'in-text'})||!createEdge(editor,{shapeId:'shape:per01-source',portId:'out-text'},{shapeId:'shape:c3-worker',portId:'in-value'}))throw new Error('PER01_FIXTURE_EDGES_FAILED');
            await ensureCanvasSaved();
            editor.select('shape:c3-agent');editor.zoomToSelection();
            for(let attempt=0;!document.querySelector('[data-node-id="shape:c3-agent"] .node-standard-primary');attempt++){if(attempt>200)throw new Error('PER01_AGENT_CONTROLS_TIMEOUT');await delay();}
            const clickPrimary=async()=>{for(let attempt=0;attempt<200;attempt++){const button=document.querySelector('[data-node-id="shape:c3-agent"] .node-standard-primary');if(button&&!button.disabled){button.click();return;}await delay();}throw new Error('PER01_AGENT_BUTTON_UNAVAILABLE');};
            window.__agentResidencyProgress={cycle:0,stage:'ready',startedAt:Date.now()};
            window.__agentResidencyRun=(async()=>{
              const startedAt=Date.now(),durationMs=${agentResidencySeconds * 1000},intervalMs=60000,endAt=startedAt+durationMs,cycles=[];
              while(Date.now()<endAt){
                const cycle=cycles.length+1,cycleStartedAt=Date.now(),beforeHistory=editor.getShape('shape:c3-worker').meta.nodeRunHistory?.length||0;
                window.__agentResidencyProgress={cycle,stage:'start',startedAt,cycleStartedAt};
                await clickPrimary();
                const waiting=await wait('waiting');
                window.__agentResidencyProgress={cycle,stage:'human-wait',startedAt,cycleStartedAt,taskId:waiting.taskId};
                await new Promise(done=>setTimeout(done,1000));
                await clickPrimary();
                const completed=await wait('completed');
                while(editor.getShape('shape:c3-agent').props.exec==='running')await new Promise(done=>setTimeout(done,50));
                await ensureCanvasSaved();
                const afterHistory=editor.getShape('shape:c3-worker').meta.nodeRunHistory?.length||0;
                if(afterHistory!==Math.min(beforeHistory+2,NODE_RUN_HISTORY_LIMIT))throw new Error('PER01_TOOL_HISTORY_DRIFT');
                cycles.push({cycle,taskId:completed.taskId,cycleStartedAt,completedAt:Date.now(),workerHistory:afterHistory,waitKind:waiting.waitKind});
                window.__agentResidencyProgress={cycle,stage:'complete',startedAt,completedAt:Date.now(),taskId:completed.taskId,workerHistory:afterHistory};
                const nextAt=startedAt+cycles.length*intervalMs;
                while(Date.now()<nextAt&&Date.now()<endAt)await new Promise(done=>setTimeout(done,Math.min(1000,nextAt-Date.now())));
              }
              while(Date.now()<endAt)await new Promise(done=>setTimeout(done,Math.min(1000,endAt-Date.now())));
              await ensureCanvasSaved();
              const lastTask=await inspect();
              return {durationMs:Date.now()-startedAt,startedAt,completedAt:Date.now(),cycles,cycleCount:cycles.length,finalTaskId:lastTask?.taskId||null,finalTaskState:lastTask?.state||null,workerHistory:editor.getShape('shape:c3-worker').meta.nodeRunHistory?.length||0,rendererId:${active.webContents.id}};
            })();
            window.__agentResidencyFailure=null;
            window.__agentResidencyRun.catch(error=>{const message=String(error?.message||''),reference=message.match(/^([A-Za-z_$][A-Za-z0-9_$]*) is not defined$/)?.[1];window.__agentResidencyFailure={name:String(error?.name||'unknown'),code:/^[A-Z0-9_]+$/.test(message)?message:'UNCLASSIFIED',...(reference?{reference}:{})};});
            return {projectId,agentNodeId:'shape:c3-agent',workerNodeId:'shape:c3-worker',startedAt:window.__agentResidencyProgress.startedAt,targetSeconds:${agentResidencySeconds},cycleIntervalSeconds:60};
          })()`)
          const rendererPid = active.webContents.getOSProcessId()
          writeFileSync(
            processPath,
            JSON.stringify({ mainPid: process.pid, rendererPid, rendererId: active.webContents.id })
          )
          let debuggerAttached = false
          try {
            active.webContents.debugger.attach('1.3')
            await active.webContents.debugger.sendCommand('Performance.enable')
            debuggerAttached = true
          } catch {
            debuggerAttached = false
          }
          let sampleCount = 0
          let sampleErrors = 0
          let lastScreenshotSlot = -1
          let sampleInProgress = false
          const sample = async (): Promise<void> => {
            if (sampleInProgress) return
            sampleInProgress = true
            try {
              const timestamp = Date.now()
              const elapsedSeconds =
                (timestamp - Number((setup as { startedAt?: number }).startedAt || timestamp)) /
                1000
              const page = await active.webContents.executeJavaScript(
                `(async()=>{const queue=await import('/src/engine/resource-queue.ts');const tasks=queue.useResourceQueue.getState().tasks;const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;return {jsHeapUsedBytes:performance.memory?.usedJSHeapSize??null,jsHeapTotalBytes:performance.memory?.totalJSHeapSize??null,domNodeCount:document.getElementsByTagName('*').length,canvasShapeCount:editor?.getCurrentPageShapes().length??0,queue:{total:tasks.length,queued:tasks.filter(task=>task.status==='queued').length,running:tasks.filter(task=>task.status==='running').length},progress:window.__agentResidencyProgress??null}})()`
              )
              const cdp = debuggerAttached
                ? (
                    (await active.webContents.debugger.sendCommand('Performance.getMetrics')) as {
                      metrics?: Array<{ name: string; value: number }>
                    }
                  ).metrics
                : undefined
              const wantedMetrics = cdp?.filter((metric) =>
                [
                  'JSHeapUsedSize',
                  'JSHeapTotalSize',
                  'Documents',
                  'Nodes',
                  'JSEventListeners',
                  'Frames'
                ].includes(metric.name)
              )
              const processStats = await new Promise<unknown>((done) => {
                const command = `$ids=@(${process.pid},${rendererPid}); Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64,HandleCount,@{Name='ThreadCount';Expression={$_.Threads.Count}} | ConvertTo-Json -Compress`
                execFile(
                  'powershell.exe',
                  ['-NoProfile', '-Command', command],
                  { windowsHide: true, timeout: 15000 },
                  (error, stdout) => {
                    if (error) return done({ error: 'OS_PROCESS_SAMPLE_FAILED' })
                    try {
                      const parsed = JSON.parse(stdout.trim()) as unknown
                      done(Array.isArray(parsed) ? parsed : [parsed])
                    } catch {
                      done({ error: 'OS_PROCESS_SAMPLE_INVALID' })
                    }
                  }
                )
              })
              const appMetrics = app
                .getAppMetrics()
                .filter((metric) => [process.pid, rendererPid].includes(metric.pid))
                .map((metric) => ({
                  pid: metric.pid,
                  type: metric.type,
                  cpu: metric.cpu,
                  memory: metric.memory
                }))
              const processHandles =
                (
                  process as NodeJS.Process & { _getActiveHandles?: () => unknown[] }
                )._getActiveHandles?.().length ?? null
              const record = {
                sample: sampleCount,
                timestamp,
                elapsedSeconds,
                webContentsId: active.webContents.id,
                mainPid: process.pid,
                rendererPid,
                mainMemory: process.memoryUsage(),
                processHandles,
                appMetrics,
                cdpMetrics: wantedMetrics ?? null,
                page,
                osProcessStats: processStats
              }
              appendFileSync(samplePath, JSON.stringify(record) + '\n')
              sampleCount += 1
              const screenshotSlot = Math.floor(Math.max(0, elapsedSeconds) / 900)
              if (screenshotSlot > lastScreenshotSlot) {
                const screenshot = await active.webContents.capturePage()
                const minute = screenshotSlot * 15
                writeFileSync(
                  join(directory, `residency-${String(minute).padStart(4, '0')}m.png`),
                  screenshot.toPNG()
                )
                lastScreenshotSlot = screenshotSlot
              }
            } catch (error) {
              sampleErrors += 1
              appendFileSync(
                samplePath,
                JSON.stringify({
                  sample: sampleCount,
                  timestamp: Date.now(),
                  error: String((error as Error)?.name ?? 'SAMPLE_FAILED')
                }) + '\n'
              )
              sampleCount += 1
            } finally {
              sampleInProgress = false
            }
          }
          await sample()
          const sampler = setInterval(() => void sample(), 60000)
          try {
            const run = await active.webContents.executeJavaScript('window.__agentResidencyRun')
            await sample()
            if (
              run.durationMs < agentResidencySeconds * 1000 ||
              run.cycleCount !== Math.floor(agentResidencySeconds / 60)
            )
              throw new Error('PER01_TARGET_DURATION_OR_CYCLES_NOT_MET')
            if (sampleErrors > 0 || sampleCount < Math.floor(agentResidencySeconds / 60) + 1)
              throw new Error('PER01_RESOURCE_SAMPLING_INCOMPLETE')
            const taskCount = (
              getDb()
                .prepare(
                  'SELECT COUNT(*) AS count FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=?'
                )
                .get(projectId, 'shape:c3-agent') as { count: number }
            ).count
            const commandCount = (
              getDb()
                .prepare(
                  'SELECT COUNT(*) AS count FROM flow_commands WHERE project_id=? AND target_node_id=?'
                )
                .get(projectId, 'shape:c3-worker') as { count: number }
            ).count
            const screenshotCount = lastScreenshotSlot + 1
            if (
              taskCount !== run.cycleCount ||
              commandCount !== run.cycleCount * 2 ||
              screenshotCount < Math.floor(agentResidencySeconds / 900) + 1
            )
              throw new Error('PER01_DURABLE_FACTS_OR_SCREENSHOTS_MISMATCH')
            report = {
              ...(setup as object),
              ...run,
              status: 'pass',
              taskCount,
              commandCount,
              sampleCount,
              sampleErrors,
              screenshotCount,
              debuggerAttached,
              evidenceFiles: [
                'residency-samples.jsonl',
                'residency-processes.json',
                `residency-${String(lastScreenshotSlot * 15).padStart(4, '0')}m.png`
              ]
            }
            writeFileSync(statePath, JSON.stringify(report))
          } finally {
            clearInterval(sampler)
            if (debuggerAttached) active.webContents.debugger.detach()
          }
        } else {
          const previous = JSON.parse(readFileSync(statePath, 'utf8')) as {
            projectId: string
            cycleCount: number
            finalTaskId: string
            workerHistory: number
          }
          report = await active.webContents.executeJavaScript(`(async()=>{${common}
            const task=await inspect();
            const workerHistory=editor.getShape('shape:c3-worker').meta.nodeRunHistory?.length||0;
            const saved=value(await window.api.openProject(projectId));
            if(task?.state!=='completed'||task.taskId!==${JSON.stringify(previous.finalTaskId)}||workerHistory!==${JSON.stringify(previous.workerHistory)})throw new Error('PER01_REOPEN_FACTS_CHANGED');
            return {projectId,taskId:task.taskId,taskState:task.state,workerHistory,shapeCount:saved.nodes.length,persisted:true};
          })()`)
          const currentTasks = (
            getDb()
              .prepare(
                'SELECT COUNT(*) AS count FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=?'
              )
              .get(projectId, 'shape:c3-agent') as { count: number }
          ).count
          const currentCommands = (
            getDb()
              .prepare(
                'SELECT COUNT(*) AS count FROM flow_commands WHERE project_id=? AND target_node_id=?'
              )
              .get(projectId, 'shape:c3-worker') as { count: number }
          ).count
          if (currentTasks !== previous.cycleCount || currentCommands !== previous.cycleCount * 2)
            throw new Error('PER01_REOPEN_REPLAYED_WORK')
          report = {
            ...(report as object),
            tasksUnchanged: true,
            commandsUnchanged: true,
            checks: [
              'same renderer met two-hour run/wait/continue loop',
              'per-minute process/heap/handle/queue sampling',
              '15-minute screenshots captured',
              'new process reopened final task and fixed outputs without replay'
            ]
          }
        }
      } else if (video) {
        const frame =
          firstFrame && phase === 'execute'
            ? await importMedia(projectId, join(directory, 'first-frame.png'))
            : null
        if (frame && !frame.ok) throw new Error('FRAME_IMPORT_FAILED')
        const tail =
          lastFrame && phase === 'execute'
            ? await importMedia(projectId, join(directory, 'last-frame.png'))
            : null
        if (tail && !tail.ok) throw new Error('TAIL_IMPORT_FAILED')
        const third =
          referenceImages && phase === 'execute'
            ? await importMedia(projectId, join(directory, 'reference-third.png'))
            : null
        if (third && !third.ok) throw new Error('REFERENCE_IMPORT_FAILED')
        const motion =
          motionReference && phase === 'execute'
            ? await importMedia(projectId, join(directory, 'fixture.mp4'))
            : null
        if (motion && !motion.ok) throw new Error('MOTION_IMPORT_FAILED')
        const sound =
          audioReference && phase === 'execute'
            ? await importMedia(projectId, join(directory, 'reference.wav'))
            : null
        if (sound && !sound.ok) throw new Error('AUDIO_IMPORT_FAILED')
        const motionSecond =
          multiReference && phase === 'execute'
            ? await importMedia(projectId, join(directory, 'motion-second.mp4'))
            : null
        const soundSecond =
          multiReference && phase === 'execute'
            ? await importMedia(projectId, join(directory, 'reference-second.wav'))
            : null
        if ((motionSecond && !motionSecond.ok) || (soundSecond && !soundSecond.ok))
          throw new Error('MULTI_REFERENCE_IMPORT_FAILED')
        report = await active.webContents.executeJavaScript(`(async()=>{${common}
          const read=(id)=>window.api.inspectFlowAgent({projectId,nodeId:id}).then(value);
          const run=async(id)=>{await ensureCanvasSaved();const task=await read(id);if(task)editor.updateShape({id,type:'node-card',meta:{...editor.getShape(id).meta,agentTask:JSON.stringify(task)}});const result=await(await import('/src/engine/executor.ts')).runNodeManually(editor,projectId,(await import('/src/stores/gateway.ts')).useGatewayStore.getState().providers,id);const shape=editor.getShape(id);(window.__agentRunResults??=[]).push({nodeId:id,result:result.status,nodeRun:shape?.meta.nodeRun?.status,history:shape?.meta.nodeRunHistory?.length});await ensureCanvasSaved();const after=await read(id);if(after?.state==='completed'&&result.status!=='done')throw new Error('VIDEO_PUBLIC_PROJECTION_FAILED');return after};
          if(${phase === 'execute'}) {
            const config=(role,allowedNodeIds)=>JSON.stringify({schemaVersion:1,role,interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:role==='coordinator'?'agent.dispatch':'node.execute',version:'1'}],allowedNodeIds,maxSteps:12,relations:role==='coordinator'?[{relationId:'video-state',kind:'observes',sourceNodeId:'shape:c3-agent',targetNodeId:'shape:video-state'}]:[]});
            const nodes=[{id:'shape:c3-agent',nodeType:'agent',title:'主 Agent',text:'调度视频专业 Agent 并交付视频',config:config('coordinator',['shape:video-agent'])},{id:'shape:video-agent',nodeType:'agent',title:'视频 Agent',text:'使用视频节点生成一次视频，交付固定成果',config:config('specialist',['shape:video-target'])},{id:'shape:video-target',nodeType:'video',title:'视频生成',text:'',config:JSON.stringify({mode:${JSON.stringify(videoMode)},modelKey:'video-test::doubao-seedance-2-0',params:{}})},{id:'shape:video-prompt',nodeType:'text',title:'材料',text:'private-c3-video-prompt'}];
            nodes.forEach(({id,...props},i)=>editor.createShape({id,type:'node-card',x:100+i*430,y:100,props}));
            editor.createShape({id:'shape:video-state',type:'node-card',x:100,y:700,props:{nodeType:'state-machine',title:'流程状态',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]})}});
            const {createEdge}=await import('/src/canvas/graph.ts');
            const frame=${JSON.stringify(frame && frame.ok ? frame.asset : null)};
            if(frame){editor.createShape({id:'shape:first-frame',type:'node-card',x:100,y:950,props:{nodeType:'image',title:'首帧输入',mediaId:frame.id,mediaPath:frame.path,mediaMime:frame.mime}});createEdge(editor,{shapeId:'shape:first-frame',portId:'out-image'},{shapeId:'shape:video-target',portId:'in-images'});}
            const tail=${JSON.stringify(tail && tail.ok ? tail.asset : null)};
            const third=${JSON.stringify(third && third.ok ? third.asset : null)};
            if(tail){editor.createShape({id:'shape:last-frame',type:'node-card',x:530,y:950,props:{nodeType:'image',title:'尾帧输入',mediaId:tail.id,mediaPath:tail.path,mediaMime:tail.mime}});createEdge(editor,{shapeId:'shape:last-frame',portId:'out-image'},{shapeId:'shape:video-target',portId:'in-images'});}
            if(third){editor.createShape({id:'shape:third-reference',type:'node-card',x:960,y:950,props:{nodeType:'image',title:'参考三',mediaId:third.id,mediaPath:third.path,mediaMime:third.mime}});}
            if(third)createEdge(editor,{shapeId:'shape:third-reference',portId:'out-image'},{shapeId:'shape:video-target',portId:'in-images'});
            const motion=${JSON.stringify(motion && motion.ok ? motion.asset : null)};
            if(motion){editor.createShape({id:'shape:motion-input',type:'node-card',x:100,y:950,props:{nodeType:'video-asset',title:'运动参考',mediaId:motion.id,mediaPath:motion.path,mediaMime:motion.mime}});createEdge(editor,{shapeId:'shape:motion-input',portId:'out-video'},{shapeId:'shape:video-target',portId:'in-reference-video'});}
            for(const to of ['shape:video-agent','shape:video-target'])createEdge(editor,{shapeId:'shape:video-prompt',portId:'out-text'},{shapeId:to,portId:'in-text'});
            const sound=${JSON.stringify(sound && sound.ok ? sound.asset : null)};
            if(sound){editor.createShape({id:'shape:audio-input',type:'node-card',x:1400,y:950,props:{nodeType:'audio',title:'参考音频',mediaId:sound.id,mediaPath:sound.path,mediaMime:sound.mime}});createEdge(editor,{shapeId:'shape:audio-input',portId:'out-audio'},{shapeId:'shape:video-target',portId:'in-reference-audio'});}
            if(${multiReference}){
              const motion2=${JSON.stringify(motionSecond && motionSecond.ok ? motionSecond.asset : null)},sound2=${JSON.stringify(soundSecond && soundSecond.ok ? soundSecond.asset : null)};
              for(const [name,media,type,port,target] of [['motion-second',motion2,'video-asset','out-video','in-reference-video'],['audio-second',sound2,'audio','out-audio','in-reference-audio']]){editor.createShape({id:'shape:'+name,type:'node-card',x:1800,y:name==='motion-second'?950:1400,props:{nodeType:type,title:name,mediaId:media.id,mediaPath:media.path,mediaMime:media.mime}});if(!createEdge(editor,{shapeId:'shape:'+name,portId:port},{shapeId:'shape:video-target',portId:target}))throw new Error('MULTI_REFERENCE_EDGE_MISSING');}
              editor.createShape({id:'shape:prompt-bundle',type:'node-card',x:1800,y:100,props:{nodeType:'json',title:'固定提示词包',text:JSON.stringify({prompt:'private-c3-bundle-prompt',style:'private-c3-bundle-style'})}});if(!createEdge(editor,{shapeId:'shape:prompt-bundle',portId:'out-json'},{shapeId:'shape:video-target',portId:'in-prompt'}))throw new Error('PROMPT_BUNDLE_EDGE_MISSING');
            }
            if(frame||motion||sound){await new Promise(done=>setTimeout(done,300));const target=editor.getShape('shape:video-target');editor.updateShape({id:target.id,type:'node-card',props:{config:JSON.stringify({...JSON.parse(target.props.config),mode:${JSON.stringify(videoMode)}})}});}
            const root=await run('shape:c3-agent'),child=await read('shape:video-agent');
            if(root.state!=='waiting'||child?.state!=='waiting'||child?.waitKind!=='reconcile'){window.__reviewAcceptanceStage=JSON.stringify({mode:JSON.parse(editor.getShape('shape:video-target').props.config).mode,rootCode:root.code,childCode:child?.code});throw new Error('VIDEO_UNKNOWN_NOT_HELD');}
            if(editor.getCurrentPageShapes().some(s=>s.props?.nodeType==='video-asset'&&s.meta.agentAssetVersionId))throw new Error('VIDEO_UNKNOWN_PUBLISHED');
            return {projectId,taskId:root.taskId,executionResults:window.__agentRunResults||[],checks:['main dispatches video specialist through public executor','supplier unknown holds original command','no unverified artifact']};
          }
          let child=await read('shape:video-agent');
          const reconciled=value(await window.api.runFlowAgent({projectId,nodeId:'shape:video-agent',action:'reconcile',eventId:crypto.randomUUID(),requestId:crypto.randomUUID(),expectedTaskId:child.taskId,expectedWaitRevision:child.waitRevision,traceId:crypto.randomUUID(),spanId:crypto.randomUUID()}));
          if(reconciled.task.code!=='FLOW_VIDEO_RECONCILE_READY')throw new Error('VIDEO_RECOVERY_NOT_READY');
          child=await run('shape:video-agent');if(child.state!=='completed')throw new Error('VIDEO_SPECIALIST_NOT_COMPLETED');
          const root=await run('shape:c3-agent');if(root.state!=='completed')throw new Error('VIDEO_MAIN_NOT_COMPLETED');
          const assets=editor.getCurrentPageShapes().filter(s=>s.props?.nodeType==='video-asset'&&s.meta.agentAssetVersionId);
          if(assets.length!==1||!assets[0].props.mediaId)throw new Error('VIDEO_FIXED_ASSET_MISSING');
          const output=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(assets[0])['out-video'];if(output?.kind!=='video')throw new Error('VIDEO_ASSET_PORT_INVALID');
          editor.centerOnPoint(editor.getShapePageBounds(assets[0].id).center);
          await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
          let el;
          for(let i=0;i<100;i++){el=document.querySelector('[data-node-id="'+assets[0].id+'"] video');if(el)break;await new Promise(done=>setTimeout(done,50));}
          if(!el)throw new Error('VIDEO_PREVIEW_MISSING');
          for(let i=0;i<100&&!el.videoWidth;i++)await new Promise(r=>setTimeout(r,50));
          if(!el.videoWidth)throw new Error('VIDEO_METADATA_NOT_LOADED');
          let frameAssetShapeId;
          if(${firstFrame}){const versions=value(await window.api.listFlowAssets({projectId,nodeId:'shape:first-frame',portId:'out-image'}));const version=value(await window.api.readFlowAsset({projectId,versionId:versions[0].ref.versionId}));frameAssetShapeId=(await import('/src/canvas/flow-asset-actions.ts')).placeFlowAsset(editor,version,'shape:first-frame');editor.centerOnPoint(editor.getShapePageBounds(frameAssetShapeId).center);await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));let image;for(let i=0;i<100;i++){image=document.querySelector('[data-node-id="'+frameAssetShapeId+'"] img');if(image?.naturalWidth)break;await new Promise(done=>setTimeout(done,20));}if(!image?.naturalWidth)throw new Error('FRAME_PREVIEW_MISSING');}
          let audioAssetShapeId;
          if(${audioReference}){
            const panels=(await import('/src/stores/nodePanel.ts')).useNodePanelStore;
            panels.getState().open('contract','shape:audio-input','overview');
            for(let i=0;!document.querySelector('#contract-tab-io');i++){if(i===100)throw new Error('AUDIO_CONTRACT_PANEL_MISSING');await new Promise(done=>setTimeout(done,25));}
            document.querySelector('#contract-tab-io').click();
            let submit;for(let i=0;i<100;i++){submit=[...document.querySelectorAll('.flow-asset-panel button')].find(b=>b.textContent.includes('提交当前输出为新版本'));if(submit)break;await new Promise(done=>setTimeout(done,25));}if(!submit||submit.disabled)throw new Error('AUDIO_ASSET_SUBMIT_UNAVAILABLE');submit.click();
            let place;for(let i=0;i<200;i++){place=[...document.querySelectorAll('.flow-asset-panel button')].find(b=>b.textContent.includes('将此版本放到画布'));if(place&&!place.disabled)break;await new Promise(done=>setTimeout(done,25));}if(!place||place.disabled||!document.querySelector('.flow-asset-panel pre')?.textContent.includes('音频成果'))throw new Error('AUDIO_ASSET_UI_NOT_COMMITTED');
            place.click();panels.getState().close();
            audioAssetShapeId=editor.getSelectedShapeIds()[0];if(editor.getShape(audioAssetShapeId)?.props.nodeType!=='audio'||!editor.getShape(audioAssetShapeId)?.meta.flowAssetRef)throw new Error('AUDIO_ASSET_UI_NOT_PLACED');
            editor.centerOnPoint(editor.getShapePageBounds(audioAssetShapeId).center);let audio;for(let i=0;i<200;i++){audio=document.querySelector('[data-node-id="'+audioAssetShapeId+'"] audio');if(audio?.duration>0)break;await new Promise(done=>setTimeout(done,25));}if(!(audio?.duration>0)||!audio.paused)throw new Error('AUDIO_FIXED_DECODE_FAILED');await audio.play();if(audio.paused)throw new Error('AUDIO_FIXED_PLAY_FAILED');audio.pause();}
          await ensureCanvasSaved();return {projectId,frameAssetShapeId,audioAssetShapeId,taskId:root.taskId,mediaId:assets[0].props.mediaId,assetShapeId:assets[0].id,executionResults:window.__agentRunResults||[],checks:['same supplier task after process reopen','explicit continue restores fixed video version','main collects committed specialist result','one playable video asset with ordinary out-video','saved project retains media and version reference']};
        })()`)
        if (phase === 'reopen') {
          const identities = report as {
            assetShapeId: string
            frameAssetShapeId?: string
            audioAssetShapeId?: string
          }
          for (const [assetId, kind] of [
            [identities.assetShapeId, 'video'],
            ...(identities.audioAssetShapeId ? [[identities.audioAssetShapeId, 'audio']] : []),
            ...(identities.frameAssetShapeId ? [[identities.frameAssetShapeId, 'img']] : [])
          ]) {
            await active.webContents.executeJavaScript(
              `(async()=>{const e=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;e.selectNone();e.centerOnPoint(e.getShapePageBounds(${JSON.stringify(assetId)}).center)})()`
            )
            await active.webContents.executeJavaScript(
              'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'
            )
            active.webContents.invalidate()
            await new Promise((done) => setTimeout(done, 300))
            const point = (await active.webContents.executeJavaScript(
              `(()=>{const box=document.querySelector('[data-node-id="'+${JSON.stringify(assetId)}+'"] [data-node-interactive="media-preview"]').getBoundingClientRect();return {x:Math.round(box.x+box.width/2),y:Math.round(box.y+(${JSON.stringify(kind)}==='audio'?10:box.height/2))}})()`
            )) as { x: number; y: number }
            const mouse = (
              type: 'mouseDown' | 'mouseUp' | 'mouseMove',
              x: number,
              y: number,
              clickCount = 1
            ): void => active.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount })
            mouse('mouseMove', point.x, point.y)
            mouse('mouseDown', point.x, point.y)
            mouse('mouseUp', point.x, point.y)
            let selected = false
            for (let attempt = 0; attempt < 20 && !selected; attempt++) {
              selected = await active.webContents.executeJavaScript(
                `import('/src/stores/editor.ts').then(m=>m.useEditorStore.getState().editor.getSelectedShapeIds().includes(${JSON.stringify(assetId)}))`
              )
              if (!selected) await new Promise((done) => setTimeout(done, 50))
            }
            if (!selected) {
              writeFileSync(
                join(directory, 'pointer-failure.png'),
                (await active.webContents.capturePage()).toPNG()
              )
              throw new Error('VIDEO_FIXED_CLICK_FAILED')
            }
            const before = await active.webContents.executeJavaScript(
              `import('/src/stores/editor.ts').then(m=>{const s=m.useEditorStore.getState().editor.getShape(${JSON.stringify(assetId)});return {x:s.x,y:s.y}})`
            )
            mouse('mouseDown', point.x, point.y)
            await new Promise((done) => setTimeout(done, 50))
            mouse('mouseMove', point.x + 20, point.y + 10)
            await new Promise((done) => setTimeout(done, 50))
            mouse('mouseMove', point.x + 45, point.y + 25)
            mouse('mouseUp', point.x + 45, point.y + 25)
            await new Promise((done) => setTimeout(done, 100))
            const moved = await active.webContents.executeJavaScript(
              `import('/src/stores/editor.ts').then(m=>{const s=m.useEditorStore.getState().editor.getShape(${JSON.stringify(assetId)});return s.x!==${before.x}||s.y!==${before.y}})`
            )
            if (!moved) {
              writeFileSync(
                join(directory, 'pointer-failure.png'),
                (await active.webContents.capturePage()).toPNG()
              )
              const debug = await active.webContents.executeJavaScript(
                `import('/src/stores/editor.ts').then(m=>{const e=m.useEditorStore.getState().editor,t=document.elementFromPoint(${point.x},${point.y});return {kind:${JSON.stringify(kind)},point:${JSON.stringify(point)},before:${JSON.stringify(before)},after:{x:e.getShape(${JSON.stringify(assetId)}).x,y:e.getShape(${JSON.stringify(assetId)}).y},state:e.getPath(),target:t?.tagName,classes:t?.className,control:t?.closest('[data-node-pointer=control]')?.tagName}})`
              )
              writeFileSync(join(directory, 'pointer-debug.json'), JSON.stringify(debug))
              throw new Error(`${kind.toUpperCase()}_FIXED_DRAG_FAILED`)
            }
            const afterPoint = await active.webContents.executeJavaScript(
              `(()=>{const box=document.querySelector('[data-node-id="'+${JSON.stringify(assetId)}+'"] [data-node-interactive="media-preview"]').getBoundingClientRect();return {x:Math.round(box.x+box.width/2),y:Math.round(box.y+(${JSON.stringify(kind)}==='audio'?10:box.height/2))}})()`
            )
            mouse('mouseMove', afterPoint.x, afterPoint.y)
            mouse('mouseDown', afterPoint.x, afterPoint.y)
            mouse('mouseUp', afterPoint.x, afterPoint.y)
            mouse('mouseDown', afterPoint.x, afterPoint.y, 2)
            mouse('mouseUp', afterPoint.x, afterPoint.y, 2)
            await new Promise((done) => setTimeout(done, 150))
            if (
              !(await active.webContents.executeJavaScript(
                `!!document.querySelector('.media-preview-mask ${kind}')`
              ))
            ) {
              writeFileSync(
                join(directory, 'pointer-failure.png'),
                (await active.webContents.capturePage()).toPNG()
              )
              throw new Error(`${kind.toUpperCase()}_FIXED_PREVIEW_FAILED`)
            }
            active.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
            active.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
            await active.webContents.executeJavaScript(
              "import('/src/canvas/flow-asset-actions.ts').then(m=>m.ensureCanvasSaved())"
            )
            await active.webContents.executeJavaScript(
              'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'
            )
            await new Promise((done) => setTimeout(done, 300))
            writeFileSync(
              join(
                directory,
                kind === 'video'
                  ? 'video-fixed.png'
                  : kind === 'audio'
                    ? 'audio-fixed.png'
                    : 'image-fixed.png'
              ),
              (await active.webContents.capturePage()).toPNG()
            )
          }
          report = {
            ...(report as object),
            fixedVideoPointerAndPreview: true,
            ...(firstFrame ? { fixedImagePointerAndPreview: true } : {})
          }
        }
        const db = getDb()
        const posts = Number(
          (
            db.prepare("SELECT value FROM settings WHERE key='video-posts'").get() as {
              value: string
            }
          ).value
        )
        const downloads = Number(
          (
            db.prepare("SELECT value FROM settings WHERE key='video-downloads'").get() as {
              value: string
            }
          ).value
        )
        const tasks = (
          db.prepare("SELECT count(*) AS n FROM tasks WHERE kind='video'").get() as { n: number }
        ).n
        if (posts !== 1 || tasks !== 1 || downloads !== (phase === 'execute' ? 0 : 1))
          throw new Error('VIDEO_REPLAY_DETECTED')
        if (motionReference) {
          const rows = db
            .prepare(
              "SELECT value_json FROM flow_asset_versions WHERE node_id='shape:motion-input'"
            )
            .all() as { value_json: string }[]
          if (rows.length !== 1 || !JSON.parse(rows[0].value_json).contentSha256)
            throw new Error('MOTION_NOT_FIXED')
        }
        if (firstFrame) {
          const fixed = db
            .prepare(
              "SELECT value_json FROM flow_asset_versions WHERE json_extract(value_json,'$.kind')='image'"
            )
            .all() as { value_json: string }[]
          if (
            fixed.length !== (referenceImages ? 3 : lastFrame ? 2 : 1) ||
            fixed.some((row) => !JSON.parse(row.value_json).contentSha256)
          )
            throw new Error('FRAME_NOT_FIXED')
        }
        report = {
          ...(report as object),
          posts,
          downloads,
          videoTasks: tasks,
          firstFrameFixed: firstFrame,
          lastFrameFixed: lastFrame,
          referenceImageCount: referenceImages ? 3 : 0,
          motionReferenceFixed: motionReference,
          audioReferenceFixed: audioReference
        }
        if (mediaTransfer && phase === 'reopen') {
          const oldSave = dialog.showSaveDialog,
            oldOpen = dialog.showOpenDialog
          let imported: {
            id: string
            name: string
            createdAt: number
            updatedAt: number
            graphVersion: number
          }
          try {
            dialog.showSaveDialog = async () => ({
              canceled: false,
              filePath: join(directory, 'media-project.canvasbundle')
            })
            const bundle = await active.webContents.executeJavaScript(
              `(async()=>{const reply=await window.api.exportProject({id:${JSON.stringify(projectId)},name:'isolated-media'});if(!reply.ok)throw new Error('MEDIA_EXPORT_IPC_FAILED');return reply.data.path})()`
            )
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [bundle] })
            imported = await active.webContents.executeJavaScript(
              "(async()=>{const reply=await window.api.importProject();if(!reply.ok)throw new Error('MEDIA_IMPORT_IPC_FAILED');return reply.data})()"
            )
          } finally {
            dialog.showSaveDialog = oldSave
            dialog.showOpenDialog = oldOpen
          }
          const file = openProject(imported.id)!
          const original = (report as { assetShapeId: string }).assetShapeId
          const store = (
            file.tldrawSnapshot as {
              store: Record<
                string,
                { id: string; props: { nodeType: string }; meta?: Record<string, unknown> }
              >
            }
          ).store
          const fixed = file.nodes.filter(
            (node) => typeof store[node.id]?.meta?.flowAssetRef === 'string'
          )
          if (fixed.length < 2 || fixed.some((node) => node.id === original))
            throw new Error('MEDIA_GRAPH_ID_NOT_REMAPPED')
          for (const table of ['tasks', 'flow_commands', 'flow_agent_tasks', 'flow_review_runs']) {
            const exists = db
              .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
              .get(table)
            if (
              exists &&
              (
                db
                  .prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id=?`)
                  .get(imported.id) as { n: number }
              ).n
            )
              throw new Error('MEDIA_IMPORT_OLD_AUTHORITY')
          }
          const { FlowAssetStore } = await import('./asset-store')
          const assets = new FlowAssetStore(db, (id) => openProject(id))
          const versions = db
            .prepare(
              'SELECT asset_id,version_id,node_id,port_id FROM flow_asset_versions WHERE project_id=?'
            )
            .all(imported.id) as {
            asset_id: string
            version_id: string
            node_id: string
            port_id: string
          }[]
          const originalCount = (
            db
              .prepare('SELECT count(*) AS n FROM flow_asset_versions WHERE project_id=?')
              .get(projectId) as { n: number }
          ).n
          if (versions.length !== originalCount || versions.length < 5)
            throw new Error('MEDIA_IMPORTED_VERSIONS_MISSING')
          for (const row of versions)
            assets.resolveInputs(imported.id, [
              {
                assetId: row.asset_id,
                versionId: row.version_id,
                sourceNodeId: row.node_id,
                sourcePortId: row.port_id
              }
            ])
          for (const node of fixed) {
            const ref = JSON.parse(String(store[node.id].meta!.flowAssetRef))
            assets.resolveInputs(imported.id, [ref])
          }
          await active.webContents.executeJavaScript(`(async()=>{
            const meta=${JSON.stringify(imported)},ids=${JSON.stringify(fixed.map((node) => node.id))};
            const saves=(await import('/src/stores/save-coordinator.ts')).useSaveCoordinator,oldDeps=saves.getState().deps;
            (await import('/src/stores/app.ts')).useAppStore.getState().openProject(meta);
            let editor;for(let i=0;i<300;i++){editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;if(editor?.getShape(ids[0])&&saves.getState().deps!==oldDeps)break;if(i===299)throw new Error('MEDIA_IMPORTED_CANVAS_MISSING');await new Promise(done=>setTimeout(done,50));}
            const outputs=await import('/src/nodes/nodeValues.ts');
            for(const id of ids){const shape=editor.getShape(id),values=Object.values(outputs.projectNodeOutputs(shape));if(values.length!==1)throw new Error('MEDIA_IMPORTED_OUTPUT_MISSING');const value=values[0];if(!['image','video','audio'].includes(value.kind))continue;editor.centerOnPoint(editor.getShapePageBounds(id).center);let element;for(let i=0;i<200;i++){element=document.querySelector('[data-node-id="'+id+'"] '+(value.kind==='image'?'img':value.kind==='audio'?'audio':'video'));if(value.kind==='image'?element?.naturalWidth:value.kind==='audio'?element?.duration>0:element?.videoWidth)break;if(i===199)throw new Error('MEDIA_IMPORTED_DECODE_FAILED');await new Promise(done=>setTimeout(done,25));}}
            await (await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved();
          })()`)
          writeFileSync(
            join(directory, 'media-imported.png'),
            (await active.webContents.capturePage()).toPNG()
          )
          report = {
            ...(report as object),
            mediaBundleImported: true,
            importedFixedNodes: fixed.length,
            importedVersions: versions.length
          }
        }
        writeFileSync(statePath, JSON.stringify({ projectId }))
      } else if (rework) {
        report = await active.webContents.executeJavaScript(`(async()=>{${common}
          const mode=${JSON.stringify(reworkMode)};
          const delay=()=>new Promise(r=>setTimeout(r,100));
          const inspectNode=async(nodeId)=>value(await window.api.inspectFlowAgent({projectId,nodeId}));
          const until=async(nodeId,state)=>{for(let i=0;i<1800;i++){const task=await inspectNode(nodeId);if(task?.state===state)return task;if(task&&['failed','blocked'].includes(task.state))throw new Error(task.code||'RW_TASK_FAILED');await delay();}throw new Error('RW_TASK_TIMEOUT')};
          const publicRun=async(nodeId)=>{await ensureCanvasSaved();const task=await inspectNode(nodeId);if(task)editor.updateShape({id:nodeId,type:'node-card',meta:{...editor.getShape(nodeId).meta,agentTask:JSON.stringify(task)}});const {runNodeManually}=await import('/src/engine/executor.ts');const reply=await runNodeManually(editor,projectId,[],nodeId);if(reply.status==='failed')throw new Error('RW_EXECUTOR_FAILED');await ensureCanvasSaved();return await inspectNode(nodeId)};
          const confirm=async(nodeId)=>{const task=await inspectNode(nodeId);const view=value(await window.api.flowAgentCollaboration({projectId,nodeId}));value(await window.api.cooperateFlowAgent({projectId,nodeId,taskId:task.taskId,waitRevision:task.waitRevision,revision:view.revision,eventId:'rw-confirm-'+task.taskId,text:'明确接受已提交的返工成果',action:'submit',accepted:true}));await publicRun(nodeId)};
          if(${JSON.stringify(phase)}==='execute'){
            const cfg=(role,allowedNodeIds,interactionMode='autonomous')=>({schemaVersion:1,role,interactionMode,modelDefinitionId:'agent-test-model',skills:[],tools:[{id:role==='coordinator'?'agent.dispatch':'node.execute',version:'1'}],allowedNodeIds,maxSteps:24,relations:[]});
            const main=cfg('coordinator',['shape:rw-first','shape:rw-second','shape:rw-review']);main.tools.push({id:'review.execute',version:'1'});main.relations=[{relationId:'state',kind:'observes',sourceNodeId:'shape:rw-main',targetNodeId:'shape:rw-state'}];
            const nodes=[
              {id:'shape:rw-material',nodeType:'text',title:'测试材料',text:'private-c3-material'},
              {id:'shape:rw-main',nodeType:'agent',title:'主 Agent',text:'按顺序派发负责修订 Agent，再派发下游 Agent，交付下游的唯一真实文本成果。审核与返工由宿主处理。只复制当前 available 的节点和引用；完成只交付最后下游成果，不交付中间成果。',config:JSON.stringify(main)},
              {id:'shape:rw-first',nodeType:'agent',title:'负责修订 Agent',text:'普通任务严格执行 shape:rw-pass 两次并交付第二次的唯一固定成果。若输入有 rework 则严格执行 shape:rw-repair 两次并交付第二次唯一固定成果。人机协作时在两次处理后等待人工确认。',config:JSON.stringify(cfg('specialist',['shape:rw-pass','shape:rw-repair'],mode==='collaborative'?'collaborative':'autonomous'))},
              {id:'shape:rw-second',nodeType:'agent',title:'下游 Agent',text:'严格执行 shape:rw-downstream 两次，再交付第二次唯一固定成果。',config:JSON.stringify(cfg('specialist',['shape:rw-downstream']))},
              {id:'shape:rw-pass',nodeType:'processor',title:'原样处理',config:JSON.stringify({operation:'pass'})},
              {id:'shape:rw-repair',nodeType:'processor',title:'前缀修订',config:JSON.stringify({operation:'template',template:'交付：{{value}}'})},
              {id:'shape:rw-downstream',nodeType:'processor',title:'下游处理',config:JSON.stringify({operation:'pass'})},
              {id:'shape:rw-review',nodeType:'ai-review',title:'审核',text:'只检查是否以交付：开头：以交付：开头必须通过，否则必须拒绝。不要检查其他条件。',config:JSON.stringify({schemaVersion:1,modelDefinitionId:'agent-test-model',rulesVersion:'rules-1',rejectPolicy:'rework',maxReworks:1,responsibleNodeId:mode==='manual'?'shape:rw-material':'shape:rw-first',subjectSources:[{nodeId:mode==='manual'?'shape:rw-material':'shape:rw-first',portId:'out-text'}],gatedNodeIds:[mode==='manual'?'shape:rw-first':'shape:rw-second'],relations:[]})},
              {id:'shape:rw-state',nodeType:'state-machine',title:'阶段',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','review.started','review.passed','review.rejected','rework.created','human.wait','flow.paused','flow.completed'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]})}
            ];
            nodes.forEach(({id,...props},index)=>editor.createShape({id,type:'node-card',x:100+(index%3)*450,y:100+Math.floor(index/3)*350,props}));
            const {createEdge}=await import('/src/canvas/graph.ts');
            for(const [from,to,port] of [['shape:rw-material','shape:rw-first','in-text'],['shape:rw-material','shape:rw-pass','in-value'],['shape:rw-material','shape:rw-repair','in-value'],['shape:rw-first','shape:rw-second','in-text'],['shape:rw-first','shape:rw-downstream','in-value'],[mode==='manual'?'shape:rw-material':'shape:rw-first','shape:rw-review','in-text']])createEdge(editor,{shapeId:from,portId:'out-text'},{shapeId:to,portId:port});
            let root=await publicRun('shape:rw-main');
            if(mode==='collaborative'){await confirm('shape:rw-first');root=await publicRun('shape:rw-main');const prepared=await inspectNode('shape:rw-first');if(!prepared.prepared||prepared.state!=='ready'||!prepared.reviewFeedback)throw new Error('RW_PREPARED_WAIT_MISSING');}
            if(mode==='autonomous'){if(root.state!=='completed')throw new Error('RW_AUTO_NOT_COMPLETED');}else if(root.state!=='waiting')throw new Error('RW_HUMAN_WAIT_MISSING');
            const decision=JSON.parse(editor.getShape('shape:rw-review').meta.nodeResult);if(decision.passed!==(mode==='autonomous'))throw new Error('RW_VERDICT_INVALID');
            await ensureCanvasSaved();return {projectId,taskId:root.taskId,mode,checks:['public main start','automatic fixed-version review','bounded independent rework or manual wait','feedback on responsible node','no downstream before approval']};
          }
          let root=await inspectNode('shape:rw-main');
          if(mode==='manual'){
            editor.updateShape({id:'shape:rw-material',type:'node-card',props:{text:'交付：private-c3-material'}});await ensureCanvasSaved();
            const feedback=await inspectNode('shape:rw-material');if(!feedback?.reviewFeedback)throw new Error('RW_MANUAL_FEEDBACK_MISSING');
              let button;for(let i=0;i<100;i++){button=[...document.querySelectorAll('[data-node-id="shape:rw-material"] button')].find(button=>button.textContent==='提交返工新版本');if(button)break;await delay();}if(!button)throw new Error('RW_MANUAL_SUBMIT_MISSING');button.click();await delay();
            for(let i=0;i<200;i++){const versions=value(await window.api.listFlowAssets({projectId,nodeId:'shape:rw-material',portId:'out-text'}));if(versions.length>=2)break;if(i===199)throw new Error('RW_MANUAL_SUBMIT_TIMEOUT');await delay();}
            root=await publicRun('shape:rw-main');
          }else if(mode==='collaborative'){
            const prepared=await inspectNode('shape:rw-first');if(!prepared.prepared)throw new Error('RW_REOPEN_LOST_WAIT');
            await publicRun('shape:rw-first');await until('shape:rw-first','waiting');await confirm('shape:rw-first');root=await publicRun('shape:rw-main');
          }else{
            const result=value(await window.api.runFlowAgent({projectId,nodeId:'shape:rw-main',action:'start',requestId:root.taskId,traceId:'rw-replay',spanId:'rw-replay'}));if(result.task.state!=='completed')throw new Error('RW_REPLAY_FAILED');
          }
          if(root.state!=='completed')throw new Error('RW_FINAL_NOT_COMPLETED');
          const decision=JSON.parse(editor.getShape('shape:rw-review').meta.nodeResult);if(!decision.passed||decision.reviewRevision!==1)throw new Error('RW_REVIEW_ROUND_INVALID');
          const outputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape('shape:rw-main'));if(outputs['out-text']?.text!=='交付：private-c3-material')throw new Error('RW_OUTPUT_INVALID');
          if(editor.getShape('shape:rw-downstream').meta.nodeRunHistory?.length!==2)throw new Error('RW_DOWNSTREAM_REPLAY');
          const availability=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:rw-downstream'});if(!availability.ok)throw new Error('RW_GATE_STILL_BLOCKED');
          return {projectId,mode,checks:['new process wait or completed replay','explicit responsible start/submit','second review passes fixed new version','downstream public executor only after approval','final committed text','no duplicate downstream execution']};
        })()`)
        if (phase === 'execute' && reworkMode !== 'autonomous') {
          const owner = reworkMode === 'manual' ? 'shape:rw-material' : 'shape:rw-first'
          for (const selector of ['p', 'pre']) {
            const point = await active.webContents.executeJavaScript(`(async()=>{
              const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;
              const id=${JSON.stringify(owner)};const before=editor.getShape(id);editor.centerOnPoint(editor.getShapePageBounds(id).center,{animation:{duration:0}});
              for(let i=0;i<100;i++){const element=document.querySelector('[data-node-id="'+id+'"] .flow-review-feedback ${selector}');if(element){const rect=element.getBoundingClientRect();return {x:Math.round(rect.left+Math.min(rect.width/2,80)),y:Math.round(rect.top+rect.height/2),beforeX:before.x,beforeY:before.y};}await new Promise(done=>setTimeout(done,100));}throw new Error('RW_FEEDBACK_UI_MISSING');
            })()`)
            active.webContents.sendInputEvent({
              type: 'mouseDown',
              x: point.x,
              y: point.y,
              button: 'left',
              clickCount: 1
            })
            active.webContents.sendInputEvent({
              type: 'mouseMove',
              x: point.x + 30,
              y: point.y + 20,
              button: 'left'
            })
            active.webContents.sendInputEvent({
              type: 'mouseUp',
              x: point.x + 30,
              y: point.y + 20,
              button: 'left',
              clickCount: 1
            })
            const moved = await active.webContents.executeJavaScript(
              `(async()=>{await new Promise(done=>setTimeout(done,100));const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const id=${JSON.stringify(owner)},shape=editor.getShape(id);return editor.getSelectedShapeIds().includes(id)&&(Math.abs(shape.x-${point.beforeX})>5||Math.abs(shape.y-${point.beforeY})>5);})()`
            )
            if (!moved) throw new Error('RW_FEEDBACK_POINTER_FAILED')
          }
          await active.webContents.executeJavaScript(
            "import('/src/canvas/flow-asset-actions.ts').then(module=>module.ensureCanvasSaved())"
          )
          ;(report as { checks: string[] }).checks.push('feedback label/body select and drag')
        }
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (agentOutputSet) {
        const { acceptAgentOutputSet } = await import('./agent-output-set-acceptance')
        report = await acceptAgentOutputSet({ window: active, directory, statePath, projectId, phase: phase! })
      } else if (agentFixedInputVersion) {
        const { acceptAgentFixedInputVersion } = await import('./agent-fixed-input-acceptance')
        type Ast01Acceptance = {
          projectId: string
          taskId: string
          sourceNodeId: string
          agentNodeId: string
          processorNodeId: string
          v1VersionId: string
          v2VersionId: string
          assetId: string
          v1Ordinal: number
          v2Ordinal: number
          selectedVersionId: string
          state?: string
          taskState?: string
        }
        const acceptance = await acceptAgentFixedInputVersion({ window: active, directory, statePath, projectId, phase: phase! }) as Ast01Acceptance
        const row = getDb()
          .prepare('SELECT task_id,snapshot_json,state,output_refs_json FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? AND task_id=?')
          .get(projectId, acceptance.agentNodeId, acceptance.taskId) as { task_id: string; snapshot_json: string; state: string; output_refs_json: string } | undefined
        if (!row) throw new Error('AST01_PERSISTED_TASK_MISSING')
        const snapshot = JSON.parse(row.snapshot_json) as {
          directInputs: Array<{ assetId: string; versionId: string; sourceNodeId: string; sourcePortId: string }>
          targets: Array<{ nodeId: string; inputs: Array<{ assets: Array<{ assetId: string; versionId: string }> }> }>
        }
        const directInputVersionIds = snapshot.directInputs.map((ref) => ref.versionId)
        const processor = snapshot.targets.find((target) => target.nodeId === acceptance.processorNodeId)
        const targetInputVersionIds = processor?.inputs.flatMap((port) => port.assets.map((ref) => ref.versionId)) ?? []
        if (!directInputVersionIds.includes(acceptance.v1VersionId) || !targetInputVersionIds.includes(acceptance.v1VersionId))
          throw new Error('AST01_PERSISTED_V1_BINDING_MISMATCH')
        const versions = getDb()
          .prepare('SELECT version_id,asset_id,ordinal,value_json FROM flow_asset_versions WHERE project_id=? AND node_id=? AND port_id=? ORDER BY ordinal')
          .all(projectId, acceptance.sourceNodeId, 'out-text') as Array<{ version_id: string; asset_id: string; ordinal: number; value_json: string }>
        const v1 = versions.find((version) => version.version_id === acceptance.v1VersionId)
        const v2 = versions.find((version) => version.version_id === acceptance.v2VersionId)
        if (!v1 || !v2 || v1.asset_id !== acceptance.assetId || v2.asset_id !== acceptance.assetId || v1.ordinal !== 1 || v2.ordinal !== 2)
          throw new Error('AST01_PERSISTED_ASSET_VERSIONS_INVALID')
        if (JSON.parse(v1.value_json).text !== 'AST01_FIXED_V1' || JSON.parse(v2.value_json).text !== 'AST01_FIXED_V2')
          throw new Error('AST01_PERSISTED_ASSET_CONTENT_INVALID')
        const commands = getDb()
          .prepare('SELECT command_json,target_node_id,state,receipt_json FROM flow_commands WHERE project_id=? AND task_id=? ORDER BY created_at,command_id')
          .all(projectId, acceptance.taskId) as Array<{ command_json: string; target_node_id: string; state: string; receipt_json: string }>
        const commandAudit = commands.map((command) => {
          const parsed = JSON.parse(command.command_json) as { inputs: Array<{ assets: Array<{ versionId: string }> }> }
          const receipt = JSON.parse(command.receipt_json) as { state: string; outputRefs: Array<{ versionId: string }> }
          return { targetNodeId: command.target_node_id, state: command.state, inputVersionIds: parsed.inputs.flatMap((port) => port.assets.map((ref) => ref.versionId)), receiptState: receipt.state, outputVersionIds: receipt.outputRefs.map((ref) => ref.versionId) }
        })
        if (phase === 'execute' && (row.state !== 'waiting' || commands.length !== 0))
          throw new Error('AST01_TOOL_STARTED_BEFORE_REOPEN')
        if (phase === 'reopen') {
          if (row.state !== 'completed' || commands.length !== 1 || commands[0].target_node_id !== acceptance.processorNodeId || commands[0].state !== 'committed')
            throw new Error('AST01_RESUMED_COMMAND_NOT_COMMITTED')
          if (!commandAudit[0].inputVersionIds.includes(acceptance.v1VersionId) || commandAudit[0].inputVersionIds.includes(acceptance.v2VersionId))
            throw new Error('AST01_RESUMED_COMMAND_USED_WRONG_VERSION')
          const outputAsset = getDb()
            .prepare('SELECT value_json FROM flow_asset_versions WHERE project_id=? AND version_id=?')
            .get(projectId, commandAudit[0].outputVersionIds[0]) as { value_json: string } | undefined
          if (JSON.parse(outputAsset?.value_json ?? '{}').text !== 'AST01_FIXED_V1')
            throw new Error('AST01_COMMITTED_OUTPUT_NOT_V1')
        }
        const persistedAudit = {
          taskId: row.task_id,
          taskState: row.state,
          directInputVersionIds,
          processorTargetInputVersionIds: targetInputVersionIds,
          assetVersions: versions.filter((version) => [acceptance.v1VersionId, acceptance.v2VersionId].includes(version.version_id)).map((version) => ({ versionId: version.version_id, assetId: version.asset_id, ordinal: version.ordinal, value: JSON.parse(version.value_json) })),
          commandCount: commands.length,
          commands: commandAudit
        }
        report = { ...acceptance, persistedAudit }
        writeFileSync(join(directory, `ast01-persisted-${phase}.json`), JSON.stringify(persistedAudit, null, 2))
        writeFileSync(statePath, JSON.stringify(report))
      } else if (parallelReview) {
        const { acceptParallelReview } = await import('./parallel-review-acceptance')
        report = await acceptParallelReview({
          window: active,
          directory,
          projectId,
          phase: phase!,
          common
        })
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (parallelMedia) {
        if (parallelQueueMedia) {
          const { acceptParallelQueueMedia } = await import('./parallel-media-acceptance')
          report = await acceptParallelQueueMedia({
            window: active,
            directory,
            projectId,
            phase: phase!,
            common
          })
        } else {
          const { acceptParallelMedia } = await import('./parallel-media-acceptance')
          report = await acceptParallelMedia({
            window: active,
            directory,
            projectId,
            phase: phase!,
            common
          })
        }
        if (phase === 'execute') {
          writeFileSync(statePath, JSON.stringify(report))
          if (parallelMediaForcedExit) {
            await window.webContents.executeJavaScript(`(async()=>{
              const diagnostics=await import('/src/engine/diagnosticsReporter.ts');
              await diagnostics.drainDiagnosticsEvents();
              if(diagnostics.pendingDiagnosticsEventCount()||diagnostics.diagnosticsTransportDropCount())throw new Error('AGENT_DIAGNOSTICS_FLUSH_FAILED');
            })()`)
            await diagnostics.flushNow()
            writeFileSync(
              join(directory, 'parallel-media-forced-exit.json'),
              JSON.stringify({
                phase,
                projectId,
                taskId: (report as { taskId?: string }).taskId,
                checkpointWritten: true,
                diagnosticEventsFlushed: true
              })
            )
            await new Promise<void>(() => {})
          }
        }
      } else if (videoRework) {
        const { acceptVideoRework } = await import('./video-rework-acceptance')
        report = await acceptVideoRework({
          window: active,
          directory,
          projectId,
          phase: phase!,
          common
        })
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (videoReview) {
        const { acceptVideoReview } = await import('./video-review-acceptance')
        report = await acceptVideoReview({
          window: active,
          directory,
          projectId,
          phase: phase!,
          common
        })
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (mediaReview) {
        const { acceptMediaReview } = await import('./media-review-acceptance')
        report = await acceptMediaReview({
          window: active,
          directory,
          projectId,
          phase: phase!,
          common
        })
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (review) {
        report = await active.webContents.executeJavaScript(`(async()=>{${common}
          const delay=()=>new Promise(r=>setTimeout(r,100));
          const waitReview=async(passed)=>{for(let i=0;i<900;i++){const node=editor.getShape('shape:c3-review');if(node.props.exec==='failed')throw new Error('REVIEW_EXECUTION_FAILED');try{const report=JSON.parse(node.meta.nodeResult);if(node.props.exec==='success'&&report.passed===passed)return report;}catch{}await delay();}throw new Error('REVIEW_TIMEOUT')};
          let sourceBefore;
          const sourceFields=async()=>{const file=value(await window.api.openProject(projectId));const source=file.tldrawSnapshot.store['shape:c3-source'];const node=file.nodes.find(node=>node.id==='shape:c3-source');return {text:source.props.text,config:source.props.config,result:source.meta.nodeResult,run:source.meta.nodeRun,pinned:source.meta.pinnedOutput,fixedRef:source.meta.flowAssetRef,type:node.type,contractVersion:node.contractVersion,edges:file.edges.filter(edge=>edge.from.nodeId==='shape:c3-source'&&edge.to.nodeId==='shape:c3-review')};};
          const runReview=async()=>{sourceBefore=await sourceFields();const b=[...document.querySelectorAll('[data-node-id="shape:c3-review"] .node-standard-primary')].find(b=>b.textContent.includes('审核')||b.textContent.includes('复审'));if(!b||b.disabled)throw new Error('REVIEW_BUTTON_UNAVAILABLE');b.click();};
          const blocked=async()=>{const r=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:c3-target'});if(r.ok||r.error.code!=='FLOW_REVIEW_NOT_READY')throw new Error('REVIEW_GATE_BYPASSED')};
          if(${JSON.stringify(phase)}==='execute'){
            editor.createShape({id:'shape:c3-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'人工材料',text:'private-c3-material'}});
            editor.createShape({id:'shape:c3-target',type:'node-card',x:1000,y:100,props:{nodeType:'processor',title:'受控下游',config:JSON.stringify({operation:'pass'})}});
            editor.createShape({id:'shape:c3-review',type:'node-card',x:530,y:100,props:{nodeType:'ai-review',title:'AI 审核',text:'检查输入文本是否以交付：开头。以此开头则通过，否则不通过。',config:JSON.stringify({schemaVersion:1,modelDefinitionId:'agent-test-model',rulesVersion:'rules-1',rejectPolicy:'rework',maxReworks:1,responsibleNodeId:'shape:c3-source',subjectSources:[{nodeId:'shape:c3-source',portId:'out-text'}],gatedNodeIds:['shape:c3-target'],relations:[]})}});
            const {createEdge}=await import('/src/canvas/graph.ts');createEdge(editor,{shapeId:'shape:c3-source',portId:'out-text'},{shapeId:'shape:c3-review',portId:'in-text'});createEdge(editor,{shapeId:'shape:c3-source',portId:'out-text'},{shapeId:'shape:c3-target',portId:'in-value'});
            await ensureCanvasSaved();await blocked();await runReview();const decision=await waitReview(false);await ensureCanvasSaved();await blocked();
            if(editor.getShape('shape:c3-source').props.text!=='private-c3-material')throw new Error('REVIEW_MUTATED_INPUT');
            return {projectId,reviewId:decision.reviewId,versionId:decision.subjects[0].versionId,checks:['public executor real negative review','negative quality is successful node execution','downstream gated before and after rejection','original asset preserved']};
          }
          window.__reviewAcceptanceStage='old-gate';await blocked();const old=JSON.parse(editor.getShape('shape:c3-review').meta.nodeResult);
          editor.updateShape({id:'shape:c3-source',type:'node-card',props:{text:'交付：private-c3-material'}});await ensureCanvasSaved();await runReview();let decision;try{decision=await waitReview(true);}catch(error){const after=await sourceFields();window.__reviewBindingChanges=Object.keys(after).filter(key=>JSON.stringify(after[key])!==JSON.stringify(sourceBefore[key]));throw error;}await ensureCanvasSaved();
          if(decision.subjects[0].versionId===old.subjects[0].versionId||decision.reviewRevision!==1)throw new Error('REVIEW_VERSION_OR_BUDGET_INVALID');
          window.__reviewAcceptanceStage='released-gate';value(await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:c3-target'}));
          const {runNodeManually}=await import('/src/engine/executor.ts');const executed=await runNodeManually(editor,projectId,[],'shape:c3-target');if(executed.status!=='done')throw new Error('REVIEW_GATE_DID_NOT_RELEASE');await ensureCanvasSaved();
          const outputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape('shape:c3-review'));if(outputs['out-review']?.data.reviewId!==decision.reviewId||outputs['out-feedback']?.text!==decision.feedback)throw new Error('REVIEW_OUTPUT_FORK');
          editor.updateShape({id:'shape:c3-source',type:'node-card',props:{text:'v3 private-c3-material'}});await ensureCanvasSaved();await blocked();
          return {projectId,checks:['negative report survives new process','explicit manual rework produces new fixed version','second round passes','common manual gate releases same source','report and feedback share authority','new v3 invalidates v2 approval']};
        })()`)
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (builder) {
        report = await active.webContents.executeJavaScript(`(async()=>{${common}
          let builderStage='opening';const build=async(action,extra={})=>value(await window.api.buildFlowAgent({projectId,nodeId:'shape:c3-builder',action,...extra}));
          const delay=()=>new Promise(r=>setTimeout(r,100));
          const button=(label)=>[...document.querySelectorAll('[data-node-id="shape:c3-builder"] .node-standard-primary')].find(b=>b.textContent.includes(label));
          const until=async(fn)=>{for(let i=0;i<800;i++){if(await fn())return;await delay();}throw new Error('BUILDER_TIMEOUT_'+builderStage.toUpperCase().replaceAll('-','_'))};
          if(${JSON.stringify(phase)}==='execute'){
            editor.createShape({id:'shape:c3-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'材料',text:'private-c3-material'}});
            const builderGoal=${JSON.stringify(builderParallelMode ? '建三个独立并行的文本模板分支，分别输出摘要：{{value}}、要点：{{value}}、标签：{{value}}。三路都必须完成，主 Agent 选择一份成果交付。' : '建一个两个自主步骤的文本模板流程。第一步 template 必须是 整理：{{value}}，第二步必须是 交付：{{value}}。每步用其数据处理节点执行一次并交付真实输出。只需文本模板能力。')};
            editor.createShape({id:'shape:c3-builder',type:'node-card',x:100,y:450,props:{nodeType:'agent',title:'搭建 Agent',text:builderGoal,config:JSON.stringify({schemaVersion:1,role:'builder',interactionMode:'collaborative',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'graph.preview',version:'1'}],allowedNodeIds:['shape:c3-source'],maxSteps:12,relations:[]})}});
            await ensureCanvasSaved();builderStage='propose-button';await until(()=>button('生成建图预览'));button('生成建图预览').click();builderStage='proposal';await until(async()=>!!(await build('inspect')));
            const preview=await build('inspect');const ghostLayer=document.querySelector('.flow-build-preview-layer');const reviewNode=preview.nodes.find(node=>node.type==='ai-review');const reviewConfig=reviewNode&&JSON.parse(reviewNode.config);if(preview.state!=='preview'||editor.getCurrentPageShapes().filter(s=>s.type==='node-card').length!==2||preview.plan.topology!==(${builderParallelMode ? "'parallel-fork'" : "'sequential'"})||ghostLayer?.querySelectorAll('[data-preview-node-id]').length!==preview.nodes.length||Number(ghostLayer?.firstElementChild?.getAttribute('data-preview-data-edges'))!==preview.edges.length||(!${builderParallelMode}&&(!reviewConfig||reviewConfig.gatedNodeIds.length!==1||Number(ghostLayer?.firstElementChild?.getAttribute('data-preview-gate-edges'))!==1||Number(ghostLayer?.firstElementChild?.getAttribute('data-preview-rework-edges'))!==1)))throw new Error('BUILDER_PREVIEW_SPATIAL_CONTRACT');
            return {projectId,buildId:preview.buildId,checks:['public node button proposes bounded flow','spatial ghost nodes match host positions','typed data edges are visible','preview saved without graph mutation','explicit commit required']};
          }
          const preview=await build('inspect');if(!preview||preview.state!=='preview')throw new Error('BUILDER_REOPEN_PREVIEW_MISSING');
          builderStage='commit-button';editor.select('shape:c3-builder');editor.zoomToSelection();await until(()=>button('提交图变更'));button('提交图变更').click();builderStage='commit';await until(async()=>(await build('inspect'))?.state==='committed');await ensureCanvasSaved();
          const committed=await build('inspect');const {commitFlowBuild}=await import('/src/canvas/flow-build-actions.ts');await commitFlowBuild(editor,committed);
          if(editor.getCurrentPageShapes().filter(s=>s.type==='node-card').length!==committed.nodes.length+2)throw new Error('BUILDER_DUPLICATE_COMMIT');
          if(committed.nodes.some(node=>{const shape=editor.getShape(node.id);return !shape||shape.x!==node.x||shape.y!==node.y||shape.props.nodeType!==node.type}))throw new Error('BUILDER_COMMIT_POSITION_MISMATCH');
          if(!${builderParallelMode}){editor.undo();await ensureCanvasSaved();if(editor.getCurrentPageShapes().filter(s=>s.type==='node-card').length!==2||committed.nodes.some(node=>editor.getShape(node.id)))throw new Error('BUILDER_UNDO_ATOMICITY');editor.redo();await ensureCanvasSaved();if(committed.nodes.some(node=>!editor.getShape(node.id)||editor.getShape(node.id).x!==node.x||editor.getShape(node.id).y!==node.y))throw new Error('BUILDER_REDO_ATOMICITY');}
          const main=committed.nodes.find(n=>n.type==='agent'&&JSON.parse(n.config).role==='coordinator');
          const mainButton=document.querySelector('[data-node-id="'+main.id+'"] .node-standard-primary');if(!mainButton)throw new Error('BUILDER_MAIN_BUTTON');mainButton.click();builderStage='execution';
          await until(async()=>{const task=value(await window.api.inspectFlowAgent({projectId,nodeId:main.id}));if(task&&['failed','blocked'].includes(task.state))throw new Error(task.code||'BUILDER_RUN_FAILED');return task?.state==='completed'});
          await until(()=>editor.getShape(main.id).props.exec!=='running');await ensureCanvasSaved();
          const projectOutputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs;const output=projectOutputs(editor.getShape(main.id))['out-text'];
          if(!${builderParallelMode}){const reviewNode=committed.nodes.find(node=>node.type==='ai-review');const decision=reviewNode&&projectOutputs(editor.getShape(reviewNode.id))['out-review'];if(!reviewNode||decision?.kind!=='json'||decision.data.passed!==true)throw new Error('BUILDER_REVIEW_NOT_PASSED');}
          if(${builderParallelMode}){
            const task=value(await window.api.inspectFlowAgent({projectId,nodeId:main.id}));
            const processors=committed.nodes.filter(n=>n.type==='processor');
            const branchOutputs=processors.map(n=>projectOutputs(editor.getShape(n.id))['out-value']?.text).sort();
            if(task.children.length!==3||task.children.some(child=>child.state!=='completed')||JSON.stringify(branchOutputs)!==JSON.stringify(['摘要：private-c3-material','要点：private-c3-material','标签：private-c3-material'].sort())||!branchOutputs.includes(output?.text))throw new Error('BUILDER_PARALLEL_BRANCH_OUTPUTS');
            return {projectId,checks:['three-branch parallel-fork preview and contract validation','public commit survives fresh process','coordinator dispatches three independent branches together','all branches execute through public processors','main Agent selects one fixed result while every branch asset remains']};
          }
          if(output?.text!=='交付：整理：private-c3-material')throw new Error('BUILDER_WRONG_REAL_OUTPUT');
          return {projectId,checks:['preview survives fresh process','public commit button saves complete graph','repeated commit creates no duplicates','built flow runs through public executors','two independent specialists','real transformed text output']};
        })()`)
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (coordination) {
        if (recovery && phase === 'reopen') {
          const row = getDb()
            .prepare('SELECT task_id,body_json FROM flow_coordination_runs WHERE project_id=?')
            .get(projectId) as { task_id: string; body_json: string }
          const interrupted = JSON.parse(row.body_json)
          interrupted.state = 'running'
          getDb()
            .prepare(
              'UPDATE flow_coordination_runs SET body_json=? WHERE project_id=? AND task_id=?'
            )
            .run(JSON.stringify(interrupted), projectId, row.task_id)
          await diagnostics.flushNow()
          const before = (await diagnostics.query({ limit: 5000 })).events.filter(
            (event) => event.event === 'model.request.started'
          ).length
          await active.webContents.executeJavaScript(`(async()=>{${common}
            const task=await inspect();if(task.state!=='blocked')throw new Error('C4_NOT_INTERRUPTED');
            for(let i=0;i<100;i++){const button=[...document.querySelectorAll('[data-node-id="shape:c3-agent"] button')].find(button=>button.textContent==='核对执行事实');if(button){button.click();break;}if(i===99)throw new Error('C4_RECONCILE_BUTTON_MISSING');await new Promise(done=>setTimeout(done,100));}
            for(let i=0;i<150;i++){const current=await inspect();if(current.state==='waiting')break;if(current.state==='blocked'&&current.code!=='AGENT_SESSION_LOST')throw new Error(current.code||'C4_RECONCILE_FAILED');if(i===149)throw new Error('C4_RECONCILE_TIMEOUT');await new Promise(done=>setTimeout(done,100));}for(let i=0;editor.getShape('shape:c3-agent').props.exec==='running';i++){if(i>100)throw new Error('C4_RECONCILE_SAVE_TIMEOUT');await new Promise(done=>setTimeout(done,100));}await ensureCanvasSaved();
          })()`)
          await diagnostics.flushNow()
          const after = (await diagnostics.query({ limit: 5000 })).events.filter(
            (event) => event.event === 'model.request.started'
          ).length
          if (after !== before) throw new Error('C4_RECONCILE_REPEATED_MODEL')
        }
        report = await active.webContents.executeJavaScript(`(async()=>{${common}
          const delay=()=>new Promise(r=>setTimeout(r,150));
          const inspectNode=async(nodeId)=>value(await window.api.inspectFlowAgent({projectId,nodeId}));
          const until=async(nodeId,state)=>{for(let i=0;i<1800;i++){const task=await inspectNode(nodeId);if(task?.state===state)return task;if(task&&['blocked','failed'].includes(task.state))throw new Error(task.code||'C33_TASK_FAILED');await delay();}throw new Error('C33_TASK_TIMEOUT');};
          const clickNode=(id)=>{const button=document.querySelector('[data-node-id="'+id+'"] .node-standard-primary');if(!button||button.disabled)throw new Error('C33_BUTTON_UNAVAILABLE');button.click();};
          if(${JSON.stringify(phase)}==='execute'){
            const specialist=(id,target,mode)=>({schemaVersion:1,role:'specialist',interactionMode:mode,modelDefinitionId:'agent-test-model',skills:[{id:'result-check',version:'1'}],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:[target],maxSteps:12,relations:[]});
            const nodes=[
              {id:'shape:c3-source',nodeType:'text',title:'人工材料',text:'private-c3-material',x:50,y:80},
              {id:'shape:c3-first',nodeType:'agent',title:'分析 Agent',text:'加载 result-check Skill。执行 shape:c3-p1 两次，每次观察真实回执；两次后用第二次 committed 回执的 outputRefs 完成。不要等待人或额外执行。',config:JSON.stringify(specialist('shape:c3-first','shape:c3-p1','autonomous')),x:450,y:80},
              {id:'shape:c3-second',nodeType:'agent',title:'整理 Agent',text:'加载 result-check Skill。执行 shape:c3-p2 两次，每次观察真实回执；两次后 wait_for_human。humanAccepted=true 后提交人工 selectedOutputs 或第二次回执的 outputRefs，不再执行。',config:JSON.stringify(specialist('shape:c3-second','shape:c3-p2','collaborative')),x:850,y:80},
              {id:'shape:c3-p1',nodeType:'processor',title:'分析处理',config:JSON.stringify({operation:'pass'}),x:450,y:650},
              {id:'shape:c3-p2',nodeType:'processor',title:'整理处理',config:JSON.stringify({operation:'pass'}),x:850,y:650},
              {id:'shape:c3-agent',nodeType:'agent',title:'主 Agent',text:${JSON.stringify(agentHum07Pause ? 'HUM07_PAUSE_FIXTURE：先把材料交给分析 Agent，再把分析的真实成果交给整理 Agent。分派目标与完成条件保持专业节点原要求。' : '先把材料交给分析 Agent，再把分析的真实成果交给整理 Agent。分派目标与完成条件保持专业节点原要求，不添加更多步骤。两者都真实完成后，仅提交整理 Agent 成果。')},config:JSON.stringify({schemaVersion:1,role:'coordinator',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'agent.dispatch',version:'1'}],allowedNodeIds:['shape:c3-first','shape:c3-second'],maxSteps:8,relations:[{relationId:'state',kind:'observes',sourceNodeId:'shape:c3-agent',targetNodeId:'shape:c3-state'}]}),x:50,y:400},
              {id:'shape:c3-state',nodeType:'state-machine',title:'Flow 阶段',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]}),x:1250,y:80}
            ];
            nodes.forEach(({id,x,y,...props})=>editor.createShape({id,type:'node-card',x,y,props}));
            const {createEdge}=await import('/src/canvas/graph.ts');
            for(const [from,port,to,target] of [['shape:c3-source','out-text','shape:c3-first','in-text'],['shape:c3-source','out-text','shape:c3-p1','in-value'],['shape:c3-first','out-text','shape:c3-second','in-text'],['shape:c3-first','out-text','shape:c3-p2','in-value']])createEdge(editor,{shapeId:from,portId:port},{shapeId:to,portId:target});
            if(${JSON.stringify(agentHum07Pause)}){
              const childConfig={schemaVersion:1,role:'specialist',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:['shape:hum07-stop-processor'],maxSteps:4,relations:[]};
              const rootConfig={schemaVersion:1,role:'coordinator',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'agent.dispatch',version:'1'}],allowedNodeIds:['shape:hum07-stop-child'],maxSteps:4,relations:[{relationId:'stop-state',kind:'observes',sourceNodeId:'shape:hum07-stop-root',targetNodeId:'shape:hum07-stop-state'}]};
              editor.createShape({id:'shape:hum07-stop-processor',type:'node-card',x:1750,y:900,props:{nodeType:'processor',title:'停止后不得运行的处理器',config:JSON.stringify({operation:'pass'})}});
              editor.createShape({id:'shape:hum07-stop-state',type:'node-card',x:1750,y:1300,props:{nodeType:'state-machine',title:'停止场景状态',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed','cancelled'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed','flow.cancelled'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':event==='flow.cancelled'?'cancelled':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'},{from:'waiting',event:'flow.cancelled',to:'cancelled'}],relations:[]})}});
              editor.createShape({id:'shape:hum07-stop-child',type:'node-card',x:1300,y:900,props:{nodeType:'agent',title:'停止场景专业 Agent',text:'执行授权处理器并交付回执。',config:JSON.stringify(childConfig)}});
              editor.createShape({id:'shape:hum07-stop-root',type:'node-card',x:1300,y:1300,props:{nodeType:'agent',title:'HUM-07 停止主 Agent',text:'HUM07_STOP_FIXTURE：把材料交给授权专业 Agent 并等待完成。',config:JSON.stringify(rootConfig)}});
              createEdge(editor,{shapeId:'shape:c3-source',portId:'out-text'},{shapeId:'shape:hum07-stop-processor',portId:'in-value'});
              createEdge(editor,{shapeId:'shape:c3-source',portId:'out-text'},{shapeId:'shape:hum07-stop-child',portId:'in-text'});
              createEdge(editor,{shapeId:'shape:c3-source',portId:'out-text'},{shapeId:'shape:hum07-stop-root',portId:'in-text'});
            }
            await ensureCanvasSaved();await delay();clickNode('shape:c3-agent');
            let pauseStopAudit=null;
            if(${JSON.stringify(agentHum07Pause)}){
              await until('shape:c3-agent','running');
              const controls=()=>[...document.querySelectorAll('[data-node-id="shape:c3-agent"] button')];
              const pauseButton=controls().find(button=>button.textContent.trim()==='暂停派发');
              const runningStop=controls().find(button=>button.textContent.trim()==='停止任务');
              if(!pauseButton||!runningStop||pauseButton===runningStop)throw new Error('HUM07_RUNNING_CONTROLS_NOT_DISTINCT');
              await delay();pauseButton.click();
              const paused=await until('shape:c3-agent','waiting');
              const unstartedReply=await window.api.inspectFlowAgent({projectId,nodeId:'shape:c3-first'});
              if(!unstartedReply.ok&&unstartedReply.error.code!=='AGENT_TASK_NOT_FOUND')throw new Error('HUM07_CHILD_INSPECTION_FAILED');
              const noDispatch=(!unstartedReply.ok||!unstartedReply.data)&&paused.children?.length===0&&(editor.getShape('shape:c3-p1').meta.nodeRunHistory?.length??0)===0&&(editor.getShape('shape:c3-p2').meta.nodeRunHistory?.length??0)===0;
              if(!noDispatch)throw new Error('HUM07_PAUSE_DISPATCHED_CHILD');
              let resumeButton,waitingStop;
              for(let i=0;i<40;i++){const waitingControls=controls();resumeButton=waitingControls.find(button=>button.textContent.trim()==='确认并继续');waitingStop=waitingControls.find(button=>button.textContent.trim()==='停止任务');if(resumeButton&&waitingStop)break;await delay();}
              if(!resumeButton||!waitingStop||resumeButton===waitingStop)throw new Error('HUM07_PAUSED_CONTROLS_NOT_DISTINCT');
              resumeButton.click();
              let resumed=false;
              for(let i=0;i<1800;i++){const current=await inspectNode('shape:c3-agent');if(current?.state==='waiting'&&current.waitRevision>paused.waitRevision){resumed=true;break;}if(current&&['blocked','failed','cancelled'].includes(current.state))throw new Error(current.code||'HUM07_CONTINUE_FAILED');await delay();}
              if(!resumed)throw new Error('HUM07_CONTINUE_DID_NOT_ADVANCE');
              pauseStopAudit={pauseHeldDispatch:true,controlsDistinct:true,continuedAfterPause:true,pauseDecisionCount:paused.decisions,childrenBeforeContinue:paused.children.length,resumeButton:'确认并继续',stopButton:'停止任务'};
            }
            const root=await until('shape:c3-agent','waiting');
            if(root.children?.length!==2||root.children[0].state!=='completed'||root.children[1].state!=='waiting')throw new Error('C33_CHILD_FACTS_INVALID');
            for(const id of ['shape:c3-p1','shape:c3-p2'])if(editor.getShape(id).meta.nodeRunHistory?.length!==2)throw new Error('C33_TWO_TOOL_PATH_MISSING');
            if((await inspectNode('shape:c3-state')).phase!=='waiting')throw new Error('C33_STATE_NOT_WAITING');
            const blocked=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:c3-p2'});if(blocked.ok||blocked.error.code!=='FLOW_CONTROL_OCCUPIED')throw new Error('C33_MANUAL_SCOPE_BYPASS');
            let stopAudit=null;
            if(${JSON.stringify(agentHum07Pause)}){
              await ensureCanvasSaved();editor.select('shape:hum07-stop-root');editor.zoomToSelection();
              const start=controls=>([...document.querySelectorAll('[data-node-id="shape:hum07-stop-root"] button')].find(button=>button.textContent.trim()==='启动任务'));
              const startButton=start();if(!startButton||startButton.disabled)throw new Error('HUM07_STOP_TASK_START_UNAVAILABLE');startButton.click();
              await until('shape:hum07-stop-root','running');await delay();
              const stopButton=[...document.querySelectorAll('[data-node-id="shape:hum07-stop-root"] button')].find(button=>button.textContent.trim()==='停止任务');
              const pauseControl=[...document.querySelectorAll('[data-node-id="shape:hum07-stop-root"] button')].find(button=>button.textContent.trim()==='暂停派发');
              if(!stopButton||!pauseControl||stopButton===pauseControl)throw new Error('HUM07_STOP_CONTROLS_NOT_DISTINCT');
              const stopClickedAt=performance.now();stopButton.click();
              let stopUiFeedbackAt=null;for(let i=0;i<100;i++){const status=document.querySelector('[data-node-id="shape:hum07-stop-root"] .agent-flow-pending');if(status?.textContent?.includes('已停止')){stopUiFeedbackAt=performance.now();break;}if(i===99)throw new Error('HUM07_STOP_UI_FEEDBACK_TIMEOUT');await delay();}
              let stopped;for(let i=0;i<100;i++){stopped=await inspectNode('shape:hum07-stop-root');if(stopped?.state==='cancelled')break;if(i===99)throw new Error('HUM07_STOP_TASK_CANCEL_TIMEOUT');await delay();}
              const stopUiFeedbackLatencyMs=Math.round(stopUiFeedbackAt-stopClickedAt);const stopTaskObservedLatencyMs=Math.round(performance.now()-stopClickedAt);const stopCancelledAtUtc=new Date().toISOString();await new Promise(resolve=>setTimeout(resolve,2400));
              stopped=await inspectNode('shape:hum07-stop-root');
              const stopChildReply=await window.api.inspectFlowAgent({projectId,nodeId:'shape:hum07-stop-child'});if(!stopChildReply.ok&&stopChildReply.error.code!=='AGENT_TASK_NOT_FOUND')throw new Error('HUM07_STOP_CHILD_INSPECTION_FAILED');const stopChild=stopChildReply.ok?stopChildReply.data:null;
              const stopProcessorRuns=editor.getShape('shape:hum07-stop-processor').meta.nodeRunHistory?.length||0;
              if(stopped?.state!=='cancelled'||stopChild||stopProcessorRuns!==0)throw new Error('HUM07_STOP_DISPATCHED_SUCCESSOR');
              await ensureCanvasSaved();stopAudit={stopTaskId:stopped.taskId,stopTaskState:stopped.state,stopClickedAtPerformanceMs:Math.round(stopClickedAt),stopUiFeedbackLatencyMs,stopTaskObservedLatencyMs,stopCancelledAtUtc,stopChildTaskExists:false,stopProcessorRuns};
            }
            await ensureCanvasSaved();return {projectId,taskId:root.taskId,pauseStopAudit,stopAudit,stopTaskId:stopAudit?.stopTaskId||null,stopTaskState:stopAudit?.stopTaskState||null,stopCancelledAtUtc:stopAudit?.stopCancelledAtUtc||null,checks:['main canvas start','two independent specialist tasks','fixed first-to-second asset handoff','two tools per specialist','node-local human wait','authoritative state waiting','manual scope occupancy',...(pauseStopAudit?['visible pause and stop controls are distinct','pause at an in-flight decision prevents child dispatch','explicit continue releases the paused coordinator','stop cancels a later in-flight handoff without dispatching its child']:[])]};
          }
          const root=await until('shape:c3-agent','waiting');
          const child=await until('shape:c3-second','waiting');
          const {useNodePanelStore}=await import('/src/stores/nodePanel.ts');useNodePanelStore.getState().open('contract','shape:c3-second','collaboration');
          for(let i=0;!document.querySelector('[aria-label="选择交付版本"]');i++){if(i>100)throw new Error('C33_SELECTION_PANEL');await delay();}
          const get=async()=>value(await window.api.flowAgentCollaboration({projectId,nodeId:'shape:c3-second'}));const candidates=(await get()).candidates;
          const select=document.querySelector('[aria-label="选择交付版本"]');select.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));for(let i=0;!document.querySelector('[role="option"]');i++){if(i>100)throw new Error("C33_SELECT_OPEN");await delay();}const option=[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes("候选 "+candidates.length));if(!option)throw new Error('C33_VERSION_OPTION');option.click();await delay();
          [...document.querySelectorAll('.agent-collaboration button')].find(b=>b.textContent.trim()==='提交意见与选择').click();
          for(let i=0;(await get()).revision<1;i++){if(i>100)throw new Error('C33_SELECTION_SAVE');await delay();}useNodePanelStore.getState().close();await ensureCanvasSaved();
          clickNode('shape:c3-second');await until('shape:c3-second','completed');for(let i=0;editor.getShape('shape:c3-second').props.exec==='running';i++){if(i>100)throw new Error('C33_CHILD_SAVE');await delay();}await ensureCanvasSaved();
          clickNode('shape:c3-agent');const done=await until('shape:c3-agent','completed');for(let i=0;editor.getShape('shape:c3-agent').props.exec==='running';i++){if(i>100)throw new Error('C33_ROOT_SAVE');await delay();}await ensureCanvasSaved();
          for(const id of ['shape:c3-p1','shape:c3-p2'])if(editor.getShape(id).meta.nodeRunHistory?.length!==2)throw new Error('C33_REPLAY');
          if((await inspectNode('shape:c3-state')).phase!=='completed')throw new Error('C33_STATE_NOT_COMPLETED');
          const outputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape('shape:c3-agent'));if(outputs['out-text']?.text!=='private-c3-material')throw new Error('C33_FORMAL_OUTPUT');
          const saved=value(await window.api.openProject(projectId));const version=value(await window.api.submitFlowAsset({projectId,nodeId:'shape:c3-agent',portId:'out-text',submissionId:'c33-final-publish',expectedGraphVersion:saved.meta.graphVersion,traceId:'c33-publish',spanId:'c33-span'}));if(version.value.text!=='private-c3-material')throw new Error('C33_OUTPUT_INVALID');
          let stopTaskId=null,stopTaskState=null,stopChildTaskExists=false,stopProcessorRuns=0;
          if(${JSON.stringify(agentHum07Pause)}){const stopped=await inspectNode('shape:hum07-stop-root'),childReply=await window.api.inspectFlowAgent({projectId,nodeId:'shape:hum07-stop-child'});if(!childReply.ok&&childReply.error.code!=='AGENT_TASK_NOT_FOUND')throw new Error('HUM07_STOP_CHILD_INSPECTION_FAILED_ON_REOPEN');const child=childReply.ok?childReply.data:null;stopTaskId=stopped?.taskId||null;stopTaskState=stopped?.state||null;stopChildTaskExists=!!child;stopProcessorRuns=editor.getShape('shape:hum07-stop-processor').meta.nodeRunHistory?.length||0;if(stopTaskId!==${JSON.stringify(null)}&&stopTaskState!=='cancelled')throw new Error('HUM07_STOP_TERMINAL_CHANGED_ON_REOPEN');if(stopChildTaskExists||stopProcessorRuns!==0)throw new Error('HUM07_STOP_SIDE_EFFECT_AFTER_REOPEN');}
          return {taskId:done.taskId,stopTaskId,stopTaskState,stopChildTaskExists,stopProcessorRuns,checks:['new process specialist selection and explicit continue','main observes child completion','no tool or specialist replay','authoritative state completed','formal main output','verified Agent publication',...(stopTaskId?['stopped coordinator remains cancelled after reopen','stopped child is absent and processor has no run']:[])]};
        })()`)
        if (recovery && phase === 'reopen') {
          const originalSave = dialog.showSaveDialog,
            originalOpen = dialog.showOpenDialog
          let imported!: ReturnType<typeof createProject>
          try {
            stage = 'c4-export'
            dialog.showSaveDialog = async () => ({
              canceled: false,
              filePath: join(directory, 'portable-project.canvasbundle')
            })
            const bundle = await active.webContents.executeJavaScript(
              `(async()=>{const reply=await window.api.exportProject({id:${JSON.stringify(projectId)},name:'isolated'});if(!reply.ok)throw new Error('C4_EXPORT_IPC_FAILED');return reply.data.path;})()`
            )
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [bundle] })
            stage = 'c4-import'
            imported = await active.webContents.executeJavaScript(
              "(async()=>{const reply=await window.api.importProject();if(!reply.ok)throw new Error('C4_IMPORT_IPC_FAILED');return reply.data;})()"
            )
          } finally {
            dialog.showSaveDialog = originalSave
            dialog.showOpenDialog = originalOpen
          }
          const file = openProject(imported.id)!
          stage = 'c4-open-imported-file'
          const main = file.nodes.find(
            (node) =>
              node.type === 'agent' && JSON.parse(String(node.params.config)).role === 'coordinator'
          )!
          if (main.id === 'shape:c3-agent') throw new Error('C4_IMPORT_ID_NOT_REMAPPED')
          stage = 'c4-open-imported-canvas'
          await active.webContents.executeJavaScript(
            `(async()=>{
            const meta=${JSON.stringify(imported)},id=${JSON.stringify(main.id)};
            window.__reviewAcceptanceStage='c4-imported-open';
            const saves=(await import('/src/stores/save-coordinator.ts')).useSaveCoordinator,oldDeps=saves.getState().deps;
            (await import('/src/stores/app.ts')).useAppStore.getState().openProject(meta);
            for(let i=0;i<200;i++){const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor,save=saves.getState();if(editor?.getShape(id)&&save.deps!==oldDeps&&!save.inFlight&&save.phase==='saved')break;if(i===199)throw new Error('C4_IMPORTED_CANVAS_NOT_READY');await new Promise(done=>setTimeout(done,100));}
            const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor,shape=editor.getShape(id);
            if(shape.meta.agentTask||shape.meta.nodeRun)throw new Error('C4_IMPORTED_OLD_AUTHORITY');
            window.__reviewAcceptanceStage='c4-imported-assets';
            const reply=await window.api.listFlowAssets({projectId:meta.id,nodeId:id,portId:'out-text'});if(!reply.ok||!reply.data.length)throw new Error('C4_IMPORTED_ASSET_MISSING');
            const asset=await window.api.readFlowAsset({projectId:meta.id,versionId:reply.data[0].ref.versionId});if(!asset.ok||asset.data.value.text!=='private-c3-material')throw new Error('C4_IMPORTED_ASSET_VALUE_INVALID');
            if(reply.data[0].ref.sourceNodeId!==id)throw new Error('C4_IMPORTED_ASSET_SOURCE_INVALID');
            window.__reviewAcceptanceStage='c4-imported-save';
            await (await import('/src/canvas/flow-asset-actions.ts')).ensureCanvasSaved().catch(()=>{throw new Error('C4_IMPORTED_SAVE_NOT_READY')});
            const saved=await window.api.openProject(meta.id);if(!saved.ok||!saved.data.nodes.some(node=>node.id===id)||saved.data.nodes.some(node=>node.id==='shape:c3-agent'))throw new Error('C4_IMPORTED_SAVE_IDENTITY_INVALID');
          })()`
          )
          ;(report as { checks: string[] }).checks.push(
            'interrupted coordinator public fact reconciliation without model requests'
          )
          ;(report as { checks: string[] }).checks.push(
            'self-contained project import opens real canvas with new identities and readable immutable assets; old execution authority removed'
          )
        }
        if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
      } else if (phase === 'execute') {
        report = await active.webContents.executeJavaScript(`(async()=>{${common}
          editor.createShape({id:'shape:c3-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'人工材料',text:'private-c3-material'}});
          editor.createShape({id:'shape:c3-processor',type:'node-card',x:900,y:100,props:{nodeType:'processor',title:'明确处理',config:JSON.stringify({operation:'pass'})}});
          editor.createShape({id:'shape:c3-agent',type:'node-card',x:100,y:450,props:{nodeType:'agent',title:'协作 Agent',
            text:'加载 result-check Skill。请按严格顺序执行：调用 shape:c3-processor 两次，每次观察真实回执和输出；第二次后在此节点等待人工确认。人工继续且 humanAccepted=true 后，用第二次 committed 回执的 outputRefs 结束任务，不再调用处理器。严禁提前结束、提前等待或额外执行。',
            config:JSON.stringify({schemaVersion:1,role:'specialist',interactionMode:'collaborative',modelDefinitionId:'agent-test-model',skills:[],tools:[],allowedNodeIds:['shape:c3-processor'],maxSteps:12,relations:[]})}});
          (await import('/src/canvas/graph.ts')).createEdge(editor,{shapeId:'shape:c3-source',portId:'out-text'},{shapeId:'shape:c3-processor',portId:'in-value'});
          (await import('/src/canvas/graph.ts')).createEdge(editor,{shapeId:'shape:c3-source',portId:'out-text'},{shapeId:'shape:c3-agent',portId:'in-text'});
          await ensureCanvasSaved();
          document.querySelector('[data-node-id="shape:c3-agent"] .node-info-btn').click();
          for(let i=0;!document.querySelector('[aria-label="Skill：结果检查"]');i++) {if(i>300)throw new Error('AGENT_SKILL_UI_MISSING');await new Promise(r=>setTimeout(r,100));}
          document.querySelector('[aria-label="Skill：结果检查"]').click();
          document.querySelector('[aria-label="启用画布节点工具"]').click();
          document.querySelector('.agent-flow-settings .website-settings-save').click();
          const selected=JSON.parse(editor.getShape('shape:c3-agent').props.config);
          if(selected.skills[0]?.id!=='result-check'||selected.tools[0]?.id!=='node.execute')throw new Error('AGENT_SKILL_UI_NOT_SAVED');
          document.querySelector('.node-contract-panel .side-panel-close').click();
          await ensureCanvasSaved(); await new Promise(r=>setTimeout(r,800)); click();
          const task=await wait('waiting');
          if(task.waitKind!=='human')throw new Error('AGENT_NOT_HUMAN_WAIT');
          while(editor.getShape('shape:c3-agent').props.exec==='running')await new Promise(r=>setTimeout(r,50));
          await ensureCanvasSaved();
          const history=editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0;
          if(history!==2)throw new Error('AGENT_TWO_STEP_FAILED_COUNT_'+history);
          return {projectId,taskId:task.taskId,history,checks:['Skill/tool settings selection','direct declared Agent input','canvas start','Skill progressive load','two public processor receipts','persistent human wait']};
        })()`)
        if (collaboration) {
          const originalRecord = getDb()
            .prepare(
              'SELECT task_id,snapshot_json,skills_json FROM flow_agent_tasks WHERE project_id=? AND agent_node_id=? ORDER BY rowid DESC LIMIT 1'
            )
            .get(projectId, 'shape:c3-agent') as {
            task_id: string
            snapshot_json: string
            skills_json: string
          }
          const originalCommands = (): unknown =>
            getDb()
              .prepare(
                'SELECT command_json,receipt_json FROM flow_commands WHERE project_id=? AND task_id=? ORDER BY command_id'
              )
              .all(projectId, originalRecord.task_id)
          const digest = (value: unknown): string =>
            createHash('sha256').update(JSON.stringify(value)).digest('hex')
          const oldSnapshotHash = digest(originalRecord)
          const oldCommandsHash = digest(originalCommands())
          const progress = setInterval(() => {
            void active.webContents
              .executeJavaScript(
                `(async()=>{const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;const shape=editor.getShape('shape:c3-agent');const task=await window.api.inspectFlowAgent({projectId:${JSON.stringify(projectId)},nodeId:'shape:c3-agent'});const label=document.querySelector('[data-node-id="shape:c3-agent"] .node-standard-primary')?.textContent;return {stage:window.__c32stage||'opening',exec:shape.props.exec,state:task.ok?task.data?.state:'error',prepared:task.ok?task.data?.prepared:false,button:label?.includes('停止')?'stop':label?.includes('继续')?'continue':'start'};})()`
              )
              .then((value) => {
                if (value && typeof value === 'object')
                  writeFileSync(
                    join(directory, 'collaboration-progress.json'),
                    JSON.stringify(value)
                  )
              })
              .catch(() => {})
          }, 1000)
          try {
            report = await active.webContents.executeJavaScript(`(async()=>{${common}
            window.__c32stage='opening';
            const panel=(await import('/src/stores/nodePanel.ts')).useNodePanelStore;
            panel.getState().open('contract','shape:c3-agent','collaboration');
            const delay=()=>new Promise(r=>setTimeout(r,150));
            const until=async(test,code)=>{for(let i=0;!test();i++){if(i>30)throw new Error(code);await delay();}};
            await until(()=>document.querySelector('.agent-collaboration textarea'),'COLLABORATION_INITIAL_PANEL_TIMEOUT');
            const fill=async(label,text)=>{const element=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(element,text);element.dispatchEvent(new Event('input',{bubbles:true}));await delay();};
            const button=async(label)=>{const element=[...document.querySelectorAll('.agent-collaboration button')].find(el=>el.textContent.trim()===label);if(!element||element.disabled)throw new Error('COLLABORATION_BUTTON_UNAVAILABLE');element.click();await delay();};
            const get=()=>window.api.flowAgentCollaboration({projectId,nodeId:'shape:c3-agent'}).then(value);
            window.__c32stage='note';await fill('讨论或反馈','private-c3-discussion');await button('保存讨论');
            for(let i=0;(await get()).revision<1;i++){if(i>100)throw new Error('COLLABORATION_NOTE_TIMEOUT');await delay();}
            let before=await get();if(before.revision!==1)throw new Error('COLLABORATION_NOTE_MISSING');
            const discussionTaskBefore=await inspect();
            const discussionGraph=()=>JSON.stringify(editor.getCurrentPageShapes().filter(s=>s.type==='node-card').map(s=>({id:s.id,type:s.props.nodeType,text:s.props.text,config:s.props.config,fixed:s.meta.flowAssetRef,pinned:s.meta.pinnedOutput})).sort((a,b)=>a.id.localeCompare(b.id)));
            const discussionGraphBefore=discussionGraph();
            for(let round=0;round<3;round++){
              window.__c32stage='discussion-'+(round+1);await fill('讨论或反馈','private-c3-discuss-with-ai-'+round);await button('与 Agent 讨论');
              for(let i=0;(await get()).revision<round+2;i++){if(i>300)throw new Error('COLLABORATION_REPLY_TIMEOUT');await delay();}
              const observed=await inspect();
              if(observed.taskId!==discussionTaskBefore.taskId||observed.state!=='waiting'||observed.decisions!==discussionTaskBefore.decisions||observed.tools!==discussionTaskBefore.tools)throw new Error('COLLABORATION_DISCUSSION_TASK_CHANGED');
              if(discussionGraph()!==discussionGraphBefore)throw new Error('COLLABORATION_DISCUSSION_GRAPH_CHANGED');
              if((editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0)!==2)throw new Error('COLLABORATION_IMPLICIT_EXECUTION');
            }
            const discussionAudit={rounds:3,taskId:discussionTaskBefore.taskId,decisionsBefore:discussionTaskBefore.decisions,decisionsAfter:(await inspect()).decisions,toolsBefore:discussionTaskBefore.tools,toolsAfter:(await inspect()).tools,toolHistoryBefore:2,toolHistoryAfter:editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0,semanticGraphUnchanged:discussionGraph()===discussionGraphBefore};
            window.__c32stage='feedback';await fill('讨论或反馈','private-c3-human-feedback');await button('提交意见与选择');
            for(let i=0;(await get()).revision<5;i++){if(i>100)throw new Error('COLLABORATION_SUBMIT_TIMEOUT');await delay();}
            const original=await get();
            window.__c32stage='revision';await fill('新目标',editor.getShape('shape:c3-agent').props.text+' 新修订：保持同样两步处理与人工等待。');
            await button('采用为新要求');
            let revised;for(let i=0;(revised=await get()).task.taskId===original.task.taskId;i++){if(i>100)throw new Error('COLLABORATION_REVISION_TIMEOUT');await delay();}
            if(!revised.task.prepared||revised.task.state!=='ready')throw new Error('COLLABORATION_NOT_PREPARED');
            if((editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0)!==2)throw new Error('COLLABORATION_REVISION_EXECUTED');
            const stale=await window.api.cooperateFlowAgent({projectId,nodeId:'shape:c3-agent',taskId:original.task.taskId,waitRevision:original.task.waitRevision,revision:original.revision,eventId:'late-response',action:'submit',text:'private-c3-stale',accepted:true});
            if(stale.ok)throw new Error('COLLABORATION_STALE_ACCEPTED');
              window.__c32stage='launch';panel.getState().close();await until(()=>document.querySelector('[data-node-id="shape:c3-agent"] .node-standard-primary')?.textContent.includes('启动任务'),'COLLABORATION_START_BUTTON_TIMEOUT');click();await wait('waiting');
            while(editor.getShape('shape:c3-agent').props.exec==='running')await delay();
            await ensureCanvasSaved();
            const history=editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0;if(history!==4)throw new Error('COLLABORATION_REVISION_TOOLS');
            window.__c32stage='selection';panel.getState().open('contract','shape:c3-agent','collaboration');await until(()=>document.querySelector('.agent-collaboration textarea'),'COLLABORATION_REVISED_PANEL_TIMEOUT');
            const select=document.querySelector('[aria-label="选择交付版本"]');select.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await until(()=>document.querySelector('[role="option"]'),'COLLABORATION_SELECT_TIMEOUT');
            const candidate=[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes('候选 1'));if(!candidate)throw new Error('COLLABORATION_CANDIDATE_MISSING');candidate.click();await delay();
            await fill('讨论或反馈','private-c3-revised-choice');await button('提交意见与选择');
            for(let i=0;(await get()).revision<1;i++){if(i>100)throw new Error('COLLABORATION_FINAL_FEEDBACK');await delay();}
            const selected=(await get()).messages.at(-1);if(selected?.kind!=='submit')throw new Error('COLLABORATION_SELECTION_NOT_SAVED');
            panel.getState().close();await ensureCanvasSaved();
            return {projectId,taskId:(await inspect()).taskId,history,discussionAudit,checks:['node-local saved discussion','three explicit AI discussions without task budget, graph or tool changes','persistent human feedback','new immutable task revision prepared without execution','stale response rejected','explicit revised task launch','two more public tools']};
          })()`)
          } finally {
            clearInterval(progress)
          }
          const afterRecord = getDb()
            .prepare(
              'SELECT task_id,snapshot_json,skills_json FROM flow_agent_tasks WHERE project_id=? AND task_id=?'
            )
            .get(projectId, originalRecord.task_id)
          if (
            digest(afterRecord) !== oldSnapshotHash ||
            digest(originalCommands()) !== oldCommandsHash
          )
            throw new Error('COLLABORATION_OLD_FACTS_MUTATED')
          const revisionAudit = {
            oldTaskId: originalRecord.task_id,
            oldSnapshotHash,
            oldCommandsHash,
            unchangedAfterRevision: true
          }
          writeFileSync(
            join(directory, 'collaboration-immutability.json'),
            JSON.stringify(revisionAudit)
          )
          const originalTaskSnapshot = JSON.parse(originalRecord.snapshot_json) as {
            traceId?: string
          }
          const currentTaskId = (report as { taskId?: string }).taskId
          const currentTaskRecord = currentTaskId
            ? (getDb()
                .prepare(
                  'SELECT snapshot_json FROM flow_agent_tasks WHERE project_id=? AND task_id=?'
                )
                .get(projectId, currentTaskId) as { snapshot_json: string } | undefined)
            : undefined
          const currentTaskSnapshot = currentTaskRecord
            ? (JSON.parse(currentTaskRecord.snapshot_json) as { traceId?: string })
            : undefined
          report = {
            ...(report as object),
            revisionAudit,
            originalTaskSnapshotTraceId: originalTaskSnapshot.traceId,
            currentTaskSnapshotTraceId: currentTaskSnapshot?.traceId
          }
        }
        writeFileSync(statePath, JSON.stringify(report))
        foreign = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: resolve(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false
          }
        })
        await foreign.loadURL('about:blank')
        const foreignResult = await foreign.webContents.executeJavaScript(
          `window.api.inspectFlowAgent({projectId:${JSON.stringify(projectId)},nodeId:'shape:c3-agent'})`
        )
        if (foreignResult.ok || foreignResult.error?.code !== 'FLOW_SENDER_REJECTED')
          throw new Error('AGENT_FOREIGN_WINDOW_ACCEPTED')
        report = { ...(report as object), foreignWindowRejected: true }
        if (collaboration) {
          const rows = getDb()
            .prepare('SELECT body_json FROM flow_agent_collaboration ORDER BY rowid')
            .all() as Array<{ body_json: string }>
          const selected = rows
            .map((row) => JSON.parse(row.body_json))
            .filter((event) => event.action === 'submit')
            .at(-1)
          if (selected?.selectedOutputs?.length !== 1)
            throw new Error('COLLABORATION_SELECTION_NOT_FIXED')
          report = { ...(report as object), selectedVersionCount: 1 }
        }
      } else {
        report = await active.webContents.executeJavaScript(`(async()=>{${common}
          const task=await wait('waiting'); await new Promise(r=>setTimeout(r,800)); click();
          const done=await wait('completed');
          while(editor.getShape('shape:c3-agent').props.exec==='running')await new Promise(r=>setTimeout(r,50));
          await ensureCanvasSaved();
          const history=editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0;
          const agent=editor.getShape('shape:c3-agent');
          if(history!==${collaboration ? 4 : 2}||agent.props.exec!=='success')throw new Error('AGENT_RESUME_REPLAYED');
          const outputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(agent);
          if(outputs['out-text']?.text!=='private-c3-material')throw new Error('AGENT_FORMAL_OUTPUT_FAILED');
          const assets=editor.getCurrentPageShapes().filter(s=>s.meta.agentTaskId===done.taskId);
          if(assets.length!==1||!assets[0].meta.flowAssetRef||!assets[0].meta.pinnedOutput)throw new Error('AGENT_FIXED_ASSET_FAILED');
          const saved=value(await window.api.openProject(projectId));
          const version=value(await window.api.submitFlowAsset({projectId,nodeId:agent.id,portId:'out-text',submissionId:'c3-agent-output',expectedGraphVersion:saved.meta.graphVersion,traceId:'c3-publish',spanId:'c3-publish-span'}));
          if(version.value.text!=='private-c3-material')throw new Error('AGENT_PUBLISH_FAILED');
          return {taskId:done.taskId,checks:['new process human continue','observed tools not replayed','declared Agent output','fixed connected asset','verified Agent publication']};
        })()`)
        if (collaboration) {
          const prior = JSON.parse(
            readFileSync(join(directory, 'collaboration-immutability.json'), 'utf8')
          ) as { oldTaskId: string; oldSnapshotHash: string; oldCommandsHash: string }
          const snapshot = getDb()
            .prepare(
              'SELECT task_id,snapshot_json,skills_json FROM flow_agent_tasks WHERE project_id=? AND task_id=?'
            )
            .get(projectId, prior.oldTaskId)
          const commands = getDb()
            .prepare(
              'SELECT command_json,receipt_json FROM flow_commands WHERE project_id=? AND task_id=? ORDER BY command_id'
            )
            .all(projectId, prior.oldTaskId)
          const digest = (value: unknown): string =>
            createHash('sha256').update(JSON.stringify(value)).digest('hex')
          const discussions = getDb()
            .prepare(
              "SELECT COUNT(*) AS count FROM flow_agent_collaboration e JOIN flow_agent_tasks t ON t.thread=e.thread WHERE t.project_id=? AND t.task_id=? AND json_extract(e.body_json,'$.action')='discuss'"
            )
            .get(projectId, prior.oldTaskId) as { count: number }
          if (
            digest(snapshot) !== prior.oldSnapshotHash ||
            digest(commands) !== prior.oldCommandsHash ||
            discussions.count !== 3
          )
            throw new Error('COLLABORATION_REOPEN_FACTS_CHANGED')
          report = {
            ...(report as object),
            originalFactsRestored: true,
            discussionRecordsAfterReopen: discussions.count
          }
          const chosen = getDb()
            .prepare(
              "SELECT body_json FROM flow_agent_collaboration WHERE json_extract(body_json,'$.action')='submit' ORDER BY rowid DESC LIMIT 1"
            )
            .get() as { body_json: string }
          const actual = getDb()
            .prepare(
              "SELECT output_refs_json FROM flow_agent_tasks WHERE state='completed' ORDER BY rowid DESC LIMIT 1"
            )
            .get() as { output_refs_json: string }
          if (
            JSON.stringify(JSON.parse(chosen.body_json).selectedOutputs) !== actual.output_refs_json
          )
            throw new Error('COLLABORATION_SELECTION_NOT_HONORED')
          report = { ...(report as object), selectionHonored: true }
        }
        if (!real) {
          stage = 'stop'
          const stop = await active.webContents.executeJavaScript(`(async()=>{${common}
            editor.updateShape({id:'shape:c3-agent',type:'node-card',props:{text:'cancel-fixture',config:JSON.stringify({...JSON.parse(editor.getShape('shape:c3-agent').props.config),interactionMode:'autonomous'})}});
            await ensureCanvasSaved(); await new Promise(r=>setTimeout(r,800)); click();
            await wait('running'); await new Promise(r=>setTimeout(r,800)); click();
            await wait('cancelled'); await new Promise(r=>setTimeout(r,1000)); await ensureCanvasSaved();
            if((editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0)!==${collaboration ? 4 : 2})throw new Error('AGENT_CANCEL_LATE_EFFECT');
            return 'canvas stop cancels in-flight decision without late tool';
          })()`)
          report = { ...(report as object), stop }
        }
      }
    } catch (error) {
      failed = true
      const code =
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'AGENT_ACCEPTANCE_FAILED'
      let acceptanceStage: unknown
      let bindingChanges: unknown
      let residencyState: unknown
      let panelChurnFailures: unknown
        let per02Debug: unknown
      try {
        acceptanceStage = await window?.webContents.executeJavaScript(
          'window.__reviewAcceptanceStage'
        )
        bindingChanges = await window?.webContents.executeJavaScript(
          'window.__reviewBindingChanges'
        )
        if (agentResidency)
          residencyState = await window?.webContents.executeJavaScript(
            '({progress:window.__agentResidencyProgress??null,failure:window.__agentResidencyFailure??null})'
          )
        if (agentPanelChurn)
          panelChurnFailures = await window?.webContents.executeJavaScript(
            'window.__per04Failures??[]'
          )
        if (agentPerfMatrix)
          await window?.webContents
            .capturePage()
            .then((image) => writeFileSync(join(directory, 'agent-perf-failure.png'), image.toPNG()))
        if (agentPerfMatrix)
          per02Debug = await window?.webContents.executeJavaScript(
            `(()=>{const last=window.__per02LastInput||null;const editor=window.__per02Editor;return {last,camera:(editor?.getCamera?.()||null),target:last?.targetId?(()=>{const shape=editor.getShape(last.targetId),element=document.querySelector('[data-node-id="'+last.targetId+'"] .agent-flow-summary'),rect=element?.getBoundingClientRect(),hit=last.point?document.elementFromPoint(last.point.x,last.point.y):null;return {shape:shape?{x:shape.x,y:shape.y}:null,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,hit:hit?{tag:hit.tagName,classes:String(hit.className||''),text:(hit.textContent||'').slice(0,80)}:null,selectedIds:editor.getSelectedShapeIds()}})():null}})()`
          )
      } catch {
        /* Safe fixture stage only. */
      }
      report = {
        code,
        stage,
        ...(typeof acceptanceStage === 'string' ? { acceptanceStage } : {}),
        ...(Array.isArray(bindingChanges) ? { bindingChanges } : {}),
        ...(residencyState ? { residencyState } : {}),
        ...(per02Debug ? { per02Debug } : {}),
        ...(Array.isArray(panelChurnFailures) ? { rendererFailures: panelChurnFailures } : {}),
        errorName: error instanceof Error ? error.name : 'unknown',
        ...(agentPanelChurn && error instanceof Error
          ? { testFailureMessage: error.message.slice(0, 240) }
          : {}),
        ...(agentPerfMatrix && error instanceof Error
          ? { testFailureMessage: error.message.slice(0, 240) }
          : {}),
        ...(agentFixedInputVersion && error instanceof Error
          ? { testFailureMessage: error.message.slice(0, 240) }
          : {}),
        ...(agentRun06Fault && error instanceof Error
          ? { testFailureMessage: error.message.slice(0, 240) }
          : {}),
        ...(parallelQueueMedia && error instanceof Error
          ? { testFailureMessage: error.message.slice(0, 240) }
          : {}),
        nativeCode:
          typeof (error as { code?: unknown })?.code === 'string' &&
          /^[A-Z0-9_]+$/.test((error as { code: string }).code)
            ? (error as { code: string }).code
            : undefined,
        errorCategory:
          error instanceof Error
            ? ['protocol', 'database', 'module', 'workspace', 'permission'].find((word) =>
                error.message.toLowerCase().includes(word)
              )
            : undefined,
        stackLocations:
          error instanceof Error
            ? error.stack
                ?.split('\n')
                .slice(1)
                .map((line) => line.match(/([A-Za-z0-9_.-]+\.js:\d+:\d+)/)?.[1])
                .filter(Boolean)
                .slice(0, 5)
            : []
      }
    } finally {
      // This fixture exits with app.exit(), which does not wait for renderer
      // timers or IPC. Drain the renderer's normal diagnostic micro-batch
      // before destroying its webContents so final node/workflow terminals
      // reach the main-process writer and the session audit sees the full run.
      try {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
          await window.webContents.executeJavaScript(`(async()=>{
            const diagnostics=await import('/src/engine/diagnosticsReporter.ts');
            await diagnostics.drainDiagnosticsEvents();
            if(diagnostics.pendingDiagnosticsEventCount()||diagnostics.diagnosticsTransportDropCount())throw new Error('AGENT_DIAGNOSTICS_FLUSH_FAILED');
          })()`)
        }
      } catch {
        if (!failed) {
          failed = true
          report = { code: 'AGENT_DIAGNOSTICS_FLUSH_FAILED', stage: 'diagnostics-flush' }
        }
      }
      foreign?.destroy()
      window?.destroy()
      await diagnostics.flushOnQuit()
      closeDb()
      writeFileSync(
        join(directory, `${phase}-report.json`),
        JSON.stringify({
          status: failed ? 'failed' : 'pass',
          report,
          model: real ? 'real' : 'fixture'
        })
      )
      app.exit(failed ? 1 : 0)
    }
  })
}
