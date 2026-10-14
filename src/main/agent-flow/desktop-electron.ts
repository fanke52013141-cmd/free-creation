// Isolated, hidden desktop acceptance; never imported by the application.
import { app, BrowserWindow, dialog } from 'electron'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
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
const collaboration = process.argv.includes('--collaboration')
const coordination = process.argv.includes('--coordination')
const recovery = process.argv.includes('--recovery')
const builder = process.argv.includes('--builder')
const review = process.argv.includes('--review')
const rework = process.argv.includes('--rework')
const reworkMode = process.env.CANVAS_AGENT_REWORK_MODE ?? 'autonomous'
if (
  !directory ||
  resolve(directory, '..') !== resolve(tmpdir()) ||
  !basename(directory).startsWith('canvas-flow-agent-') ||
  !['execute', 'reopen'].includes(phase ?? '')
) {
  app.exit(2)
} else {
  process.env.CANVAS_DATA_DIR = directory
  app.setPath('userData', directory)
  app.on('window-all-closed', () => {})
  void app.whenReady().then(async () => {
    const diagnostics = await initDiagnosticsService({ dataDir: directory, disableTimers: true })
    setGatewayEventSink(diagnostics)
    setDiagnosticsService(diagnostics)
    let foreign: BrowserWindow | undefined
    let window: BrowserWindow | undefined,
      failed = false,
      report: unknown,
      stage = 'setup'
    try {
      const statePath = join(directory, 'agent-state.json')
      const projectId =
        phase === 'execute'
          ? createProject('测试：画布 Agent C3').id
          : JSON.parse(readFileSync(statePath, 'utf8')).projectId
      setSetting('lastProjectId', projectId)
      const host = new SqliteModelHost(getDb())
      host.saveConnection({
        id: 'agent-test-connection',
        name: '隔离验收模型',
        protocol: 'openai-compatible',
        baseUrl: real
          ? (process.env.CANVAS_AGENT_PROBE_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3')
          : 'http://127.0.0.1:5200/v1',
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
            acceptedAssetKinds: [],
            producedAssetKinds: [],
            controls: {}
          }
        ]
      })
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
      await active.loadURL('http://127.0.0.1:5199')
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
      if (rework) {
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
            editor.createShape({id:'shape:c3-builder',type:'node-card',x:100,y:450,props:{nodeType:'agent',title:'搭建 Agent',text:'建一个两个自主步骤的文本模板流程。第一步 template 必须是 整理：{{value}}，第二步必须是 交付：{{value}}。每步用其数据处理节点执行一次并交付真实输出。只需文本模板能力。',config:JSON.stringify({schemaVersion:1,role:'builder',interactionMode:'collaborative',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'graph.preview',version:'1'}],allowedNodeIds:['shape:c3-source'],maxSteps:12,relations:[]})}});
            await ensureCanvasSaved();builderStage='propose-button';await until(()=>button('生成建图预览'));button('生成建图预览').click();builderStage='proposal';await until(async()=>!!(await build('inspect')));
            const preview=await build('inspect');if(preview.state!=='preview'||editor.getCurrentPageShapes().filter(s=>s.type==='node-card').length!==2)throw new Error('BUILDER_PREMATURE_MUTATION');
            return {projectId,buildId:preview.buildId,checks:['public node button proposes bounded flow','preview saved without graph mutation','explicit commit required']};
          }
          const preview=await build('inspect');if(!preview||preview.state!=='preview')throw new Error('BUILDER_REOPEN_PREVIEW_MISSING');
          builderStage='commit-button';editor.select('shape:c3-builder');editor.zoomToSelection();await until(()=>button('提交图变更'));button('提交图变更').click();builderStage='commit';await until(async()=>(await build('inspect'))?.state==='committed');await ensureCanvasSaved();
          const committed=await build('inspect');const {commitFlowBuild}=await import('/src/canvas/flow-build-actions.ts');await commitFlowBuild(editor,committed);
          if(editor.getCurrentPageShapes().filter(s=>s.type==='node-card').length!==committed.nodes.length+2)throw new Error('BUILDER_DUPLICATE_COMMIT');
          const main=committed.nodes.find(n=>n.type==='agent'&&JSON.parse(n.config).role==='coordinator');
          const mainButton=document.querySelector('[data-node-id="'+main.id+'"] .node-standard-primary');if(!mainButton)throw new Error('BUILDER_MAIN_BUTTON');mainButton.click();builderStage='execution';
          await until(async()=>{const task=value(await window.api.inspectFlowAgent({projectId,nodeId:main.id}));if(task&&['failed','blocked'].includes(task.state))throw new Error(task.code||'BUILDER_RUN_FAILED');return task?.state==='completed'});
          await until(()=>editor.getShape(main.id).props.exec!=='running');await ensureCanvasSaved();
          const output=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape(main.id))['out-text'];
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
              {id:'shape:c3-agent',nodeType:'agent',title:'主 Agent',text:'先把材料交给分析 Agent，再把分析的真实成果交给整理 Agent。分派目标与完成条件保持专业节点原要求，不添加更多步骤。两者都真实完成后，仅提交整理 Agent 成果。',config:JSON.stringify({schemaVersion:1,role:'coordinator',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'agent.dispatch',version:'1'}],allowedNodeIds:['shape:c3-first','shape:c3-second'],maxSteps:8,relations:[{relationId:'state',kind:'observes',sourceNodeId:'shape:c3-agent',targetNodeId:'shape:c3-state'}]}),x:50,y:400},
              {id:'shape:c3-state',nodeType:'state-machine',title:'Flow 阶段',config:JSON.stringify({schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]}),x:1250,y:80}
            ];
            nodes.forEach(({id,x,y,...props})=>editor.createShape({id,type:'node-card',x,y,props}));
            const {createEdge}=await import('/src/canvas/graph.ts');
            for(const [from,port,to,target] of [['shape:c3-source','out-text','shape:c3-first','in-text'],['shape:c3-source','out-text','shape:c3-p1','in-value'],['shape:c3-first','out-text','shape:c3-second','in-text'],['shape:c3-first','out-text','shape:c3-p2','in-value']])createEdge(editor,{shapeId:from,portId:port},{shapeId:to,portId:target});
            await ensureCanvasSaved();await delay();clickNode('shape:c3-agent');
            const root=await until('shape:c3-agent','waiting');
            if(root.children?.length!==2||root.children[0].state!=='completed'||root.children[1].state!=='waiting')throw new Error('C33_CHILD_FACTS_INVALID');
            for(const id of ['shape:c3-p1','shape:c3-p2'])if(editor.getShape(id).meta.nodeRunHistory?.length!==2)throw new Error('C33_TWO_TOOL_PATH_MISSING');
            if((await inspectNode('shape:c3-state')).phase!=='waiting')throw new Error('C33_STATE_NOT_WAITING');
            const blocked=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:c3-p2'});if(blocked.ok||blocked.error.code!=='FLOW_CONTROL_OCCUPIED')throw new Error('C33_MANUAL_SCOPE_BYPASS');
            await ensureCanvasSaved();return {projectId,taskId:root.taskId,checks:['main canvas start','two independent specialist tasks','fixed first-to-second asset handoff','two tools per specialist','node-local human wait','authoritative state waiting','manual scope occupancy']};
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
          return {taskId:done.taskId,checks:['new process specialist selection and explicit continue','main observes child completion','no tool or specialist replay','authoritative state completed','formal main output','verified final asset publication']};
        })()`)
        if (recovery && phase === 'reopen') {
          const originalSave = dialog.showSaveDialog,
            originalOpen = dialog.showOpenDialog
          let imported!: ReturnType<typeof createProject>
          try {
            stage = 'c4-export';
            dialog.showSaveDialog = async () => ({
              canceled: false,
              filePath: join(directory, 'portable-project.canvasbundle')
            })
            const bundle = await active.webContents.executeJavaScript(
              `(async()=>{const reply=await window.api.exportProject({id:${JSON.stringify(projectId)},name:'isolated'});if(!reply.ok)throw new Error('C4_EXPORT_IPC_FAILED');return reply.data.path;})()`
            )
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [bundle] })
            stage = 'c4-import';
            imported = await active.webContents.executeJavaScript(
              "(async()=>{const reply=await window.api.importProject();if(!reply.ok)throw new Error('C4_IMPORT_IPC_FAILED');return reply.data;})()"
            )
          } finally {
            dialog.showSaveDialog = originalSave
            dialog.showOpenDialog = originalOpen
          }
          const file = openProject(imported.id)!
          stage = 'c4-open-imported-file';
          const main = file.nodes.find(
            (node) =>
              node.type === 'agent' && JSON.parse(String(node.params.config)).role === 'coordinator'
          )!
          if (main.id === 'shape:c3-agent') throw new Error('C4_IMPORT_ID_NOT_REMAPPED')
          stage = 'c4-open-imported-canvas';
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
            window.__c32stage='discussion';await fill('讨论或反馈','private-c3-discuss-with-ai');await button('与 Agent 讨论');
            for(let i=0;(await get()).revision<2;i++){if(i>300)throw new Error('COLLABORATION_REPLY_TIMEOUT');await delay();}
            if((editor.getShape('shape:c3-processor').meta.nodeRunHistory?.length||0)!==2)throw new Error('COLLABORATION_IMPLICIT_EXECUTION');
            window.__c32stage='feedback';await fill('讨论或反馈','private-c3-human-feedback');await button('提交意见与选择');
            for(let i=0;(await get()).revision<3;i++){if(i>100)throw new Error('COLLABORATION_SUBMIT_TIMEOUT');await delay();}
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
            return {projectId,taskId:(await inspect()).taskId,history,checks:['node-local saved discussion','explicit AI discussion without tool execution','persistent human feedback','new immutable task revision prepared without execution','stale response rejected','explicit revised task launch','two more public tools']};
          })()`)
          } finally {
            clearInterval(progress)
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
      try {
        acceptanceStage = await window?.webContents.executeJavaScript(
          'window.__reviewAcceptanceStage'
        )
        bindingChanges = await window?.webContents.executeJavaScript(
          'window.__reviewBindingChanges'
        )
      } catch {
        /* Safe fixture stage only. */
      }
      report = {
        code,
        stage,
        ...(typeof acceptanceStage === 'string' ? { acceptanceStage } : {}),
        ...(Array.isArray(bindingChanges) ? { bindingChanges } : {}),
        errorName: error instanceof Error ? error.name : 'unknown'
      }
    } finally {
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
