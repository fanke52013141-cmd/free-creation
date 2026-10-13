// Isolated, hidden desktop acceptance; never imported by the application.
import { app, BrowserWindow } from 'electron'
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
import { createProject } from '../store/projects.repo'
import { closeDb, getDb, setSetting } from '../store/db'
import { initDiagnosticsService } from '../diagnostics/service'
import { setGatewayEventSink } from '../diagnostics/gateway-events'

const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const directory = arg('agent-directory'),
  phase = arg('agent-phase')
const real = process.argv.includes('--real-model')
const collaboration = process.argv.includes('--collaboration')
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
        baseUrl: real ? 'https://ark.cn-beijing.volces.com/api/v3' : 'http://127.0.0.1:5200/v1',
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
      if (phase === 'execute') {
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
      report = { code, stage }
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
