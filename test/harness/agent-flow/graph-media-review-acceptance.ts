// Isolated real-desktop acceptance helper, never imported by the application.
// ⑧ graph 模式媒体审核：视频专业 Agent 生成固定视频→抽帧审核门禁→通过后下游。
import type { BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../../../src/main/store/db'

export function installGraphMediaReviewSupplier(directory: string): void {
  const db = getDb()
  db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)').run(
    'video-test',
    '隔离图媒体',
    'seedance',
    'https://ark.cn-beijing.volces.com/api/v3',
    'private-gm-video-key',
    JSON.stringify([
      { id: 'doubao-seedance-2-0', name: '隔离视频', modality: 'video', operations: ['video.generate'] }
    ]),
    0
  )
  const native = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const address = String(url)
    if (address.startsWith('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')) {
      if (options?.method === 'POST') {
        const content = JSON.parse(String(options.body)).content
        const text = content
          .filter((part: { type: string }) => part.type === 'text')
          .map((part: { text: string }) => part.text)
          .join('\n')
        if (!text.includes('private-gm-video-prompt')) throw new Error('GM_VIDEO_PROMPT_NOT_BOUND')
        return new Response(JSON.stringify({ id: 'graph-media-1' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify({
          id: 'graph-media-1',
          status: 'succeeded',
          content: { video_url: 'https://fixture.example/graph-media/1' }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (address.startsWith('https://fixture.example/graph-media/')) {
      return new Response(readFileSync(join(directory, 'review-red.mp4')))
    }
    return native(url, options)
  }
}

export async function acceptGraphMediaReview(input: {
  window: BrowserWindow
  projectId: string
}): Promise<unknown> {
  const { window, projectId } = input
  return window.webContents.executeJavaScript(`(async()=>{
    const projectId=${JSON.stringify(projectId)};
    const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;
    const {ensureCanvasSaved}=await import('/src/canvas/flow-asset-actions.ts');
    const value=(reply)=>{if(!reply.ok)throw new Error(reply.error.code);return reply.data};
    const delay=()=>new Promise(r=>setTimeout(r,150));
    const graph={schemaVersion:1,graphId:'gmr',name:'媒体审核图',goal:'生成视频→抽帧审核→通过后下游',nodes:[{nodeId:'shape:gm-agent',title:'视频专业',participation:'autonomous',kind:'agent',goal:'生成并交付视频',completion:'交付固定视频'},{nodeId:'shape:gm-review',title:'抽帧审核',participation:'autonomous',kind:'review',goal:'审核视频画面',completion:'审核通过',review:{criteria:'四张样本必须均为红色画面',rejectPolicy:'stop',maxReworks:0}},{nodeId:'shape:gm-down',title:'下游',participation:'autonomous',kind:'agent',goal:'执行处理并交付',completion:'交付处理结果'}],edges:[{from:{nodeId:'shape:gm-agent',portId:'out-json'},to:{nodeId:'shape:gm-review',portId:'in-video'},kind:'data'},{from:{nodeId:'shape:gm-review',portId:'out-text'},to:{nodeId:'shape:gm-down',portId:'in-text'},kind:'data'}],entry:'shape:gm-agent',exits:['shape:gm-down']};
    const specialist=(targets)=>({schemaVersion:1,role:'specialist',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:targets,maxSteps:12,relations:[]});
    const rootConfig={schemaVersion:1,role:'coordinator',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'agent.dispatch',version:'1'},{id:'review.execute',version:'1'}],allowedNodeIds:['shape:gm-agent','shape:gm-review','shape:gm-down'],maxSteps:24,executionMode:'graph',graph,relations:[{relationId:'state',kind:'observes',sourceNodeId:'shape:gm-main',targetNodeId:'shape:gm-state'}]};
    const stateConfig={schemaVersion:1,initialState:'draft',states:['draft','working','waiting','completed'],transitions:[{from:'draft',event:'flow.started',to:'working'},...['agent.dispatched','agent.completed','human.wait','flow.paused','flow.completed','review.started','review.passed','review.rejected'].map(event=>({from:'working',event,to:event==='flow.completed'?'completed':['human.wait','flow.paused'].includes(event)?'waiting':'working'})),{from:'waiting',event:'human.continue',to:'working'}],relations:[]};
    const nodes=[
      {id:'shape:gm-prompt',nodeType:'text',title:'视频目标',text:'private-gm-video-prompt',x:50,y:80},
      {id:'shape:gm-agent',nodeType:'agent',title:'视频专业 Agent',text:'调用视频节点生成一次视频并交付固定视频版本。',config:JSON.stringify(specialist(['shape:gm-video'])),x:450,y:80},
      {id:'shape:gm-video',nodeType:'video',title:'视频生成',text:'',config:JSON.stringify({mode:'text',modelKey:'video-test::doubao-seedance-2-0',params:{}}),x:450,y:650},
      {id:'shape:gm-review',nodeType:'ai-review',title:'抽帧审核',text:'private-gm-video-rule：四张样本必须均为红色画面；其他颜色拒绝，不判断音轨与完整时序。',config:JSON.stringify({schemaVersion:1,reviewMode:'sampled-video',modelDefinitionId:'agent-test-model',rulesVersion:'gm-visual-1',rejectPolicy:'stop',maxReworks:0,responsibleNodeId:'shape:gm-agent',subjectSources:[{nodeId:'shape:gm-video',portId:'out-video'}],gatedNodeIds:['shape:gm-down'],relations:[]}),x:850,y:80},
      {id:'shape:gm-down',nodeType:'agent',title:'下游 Agent',text:'严格执行 shape:gm-downp 两次并交付第二次唯一固定成果。',config:JSON.stringify(specialist(['shape:gm-downp'])),x:1250,y:80},
      {id:'shape:gm-downp',nodeType:'processor',title:'下游处理',config:JSON.stringify({operation:'pass'}),x:1250,y:650},
      {id:'shape:gm-main',nodeType:'agent',title:'主 Agent',text:'按声明式图路由：视频生成→抽帧审核→通过后下游。',config:JSON.stringify(rootConfig),x:50,y:400},
      {id:'shape:gm-state',nodeType:'state-machine',title:'Flow 阶段',config:JSON.stringify(stateConfig),x:50,y:700}
    ];
    nodes.forEach(({id,x,y,...props})=>editor.createShape({id,type:'node-card',x,y,props}));
    const {createEdge}=await import('/src/canvas/graph.ts');
    for(const [from,port,to,target] of [['shape:gm-prompt','out-text','shape:gm-agent','in-text'],['shape:gm-prompt','out-text','shape:gm-video','in-text'],['shape:gm-video','out-video','shape:gm-review','in-video'],['shape:gm-agent','out-json','shape:gm-down','in-json'],['shape:gm-agent','out-json','shape:gm-downp','in-value']])if(!createEdge(editor,{shapeId:from,portId:port},{shapeId:to,portId:target}))throw new Error('GM_EDGE_MISSING');
    await ensureCanvasSaved();await delay();
    const blocked=async()=>{const r=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:gm-down'});if(r.ok||r.error.code!=='FLOW_REVIEW_NOT_READY')throw new Error('GM_GATE_BYPASSED');};
    await blocked();
    const button=document.querySelector('[data-node-id="shape:gm-main"] .node-standard-primary');if(!button||button.disabled)throw new Error('GM_ROOT_BUTTON_UNAVAILABLE');button.click();
    const inspectRoot=()=>window.api.inspectFlowAgent({projectId,nodeId:'shape:gm-main'}).then(value);
    let root;for(let i=0;i<2400;i++){root=await inspectRoot();if(root?.state==='completed')break;if(root&&['blocked','failed'].includes(root.state))throw new Error(root.code||'GM_ROOT_FAILED');await delay();}
    if(root?.state!=='completed')throw new Error('GM_ROOT_TIMEOUT');
    await ensureCanvasSaved();
    const decision=JSON.parse(editor.getShape('shape:gm-review').meta.nodeResult);
    if(!decision.passed||decision.evidenceScope!=='sampled'||decision.videoEvidence?.frames.length!==4)throw new Error('GM_REVIEW_EVIDENCE_INVALID');
    const downRun=editor.getShape('shape:gm-downp').meta.nodeRun;
    if(downRun?.status!=='success')throw new Error('GM_DOWNSTREAM_NOT_EXECUTED');
    value(await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:gm-down'}));
    return {status:'pass',projectId,rootTaskId:root.taskId,reviewId:decision.reviewId,evidenceScope:decision.evidenceScope,frameCount:decision.videoEvidence.frames.length,checks:['graph mode routes a real video-generation specialist through sampled-video review','four timestamped JPEG frames reach the model and pass the red-frame rule','downstream gated until the media review approves','coordinator completes with the approved media flow']};
  })()`)
}