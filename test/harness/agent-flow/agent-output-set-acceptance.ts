// Isolated desktop acceptance; only loaded by the hidden Agent test harness.
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function acceptAgentOutputSet(input: {
  window: BrowserWindow
  directory: string
  statePath: string
  projectId: string
  phase: string
}): Promise<unknown> {
  const { window, directory, statePath, projectId, phase } = input
  const previous =
    phase === 'reopen'
      ? (JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>)
      : null
  const report = await window.webContents.executeJavaScript(`(async()=>{
    const projectId=${JSON.stringify(projectId)};
    const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;
    const {ensureCanvasSaved}=await import('/src/canvas/flow-asset-actions.ts');
    const value=(reply)=>{if(!reply.ok)throw new Error(reply.error.code);return reply.data};
    const inspect=async()=>value(await window.api.inspectFlowAgent({projectId,nodeId:'shape:ast05-agent'}));
    const check=async()=>{
      const task=await inspect();
      const agent=editor.getShape('shape:ast05-agent');
      const receiver=editor.getShape('shape:ast05-json');
      if(!agent||!receiver||task?.state!=='completed')throw new Error('AST05_REOPEN_TASK_MISSING');
      const result=JSON.parse(agent.meta.nodeResult||'{}');
      const outputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs;
      const projected=outputs(agent)['out-json'];
      const data=projected?.kind==='json'?projected.data:null;
      if(data?.schemaVersion!==1||data?.kind!=='flow.agent-output-set'||data.outputs?.length!==2)throw new Error('AST05_OUTPUT_SET_INVALID');
      const refs=data.outputs.map((item)=>item.ref);
      if(refs.some((ref,index)=>ref.sourceNodeId!==['shape:ast05-first','shape:ast05-second'][index]||ref.sourcePortId!=='out-value')||new Set(refs.map((ref)=>ref.versionId)).size!==2)throw new Error('AST05_REFERENCE_ORDER_OR_IDENTITY_INVALID');
      if(data.outputs.some((item)=>item.assetKind!=='text'))throw new Error('AST05_FIXED_OUTPUTS_INVALID');
      if(JSON.stringify(result.outputs?.['out-json']?.data)!==JSON.stringify(data))throw new Error('AST05_PERSISTED_PROJECTION_INVALID');
      const downstream=JSON.parse(receiver.props.text||'null');
      if(JSON.stringify(downstream)!==JSON.stringify(data))throw new Error('AST05_DOWNSTREAM_JSON_INVALID');
      const nodeOutput=outputs(receiver)['out-json'];
      if(nodeOutput?.kind!=='json'||JSON.stringify(nodeOutput.data)!==JSON.stringify(data))throw new Error('AST05_DOWNSTREAM_PORT_INVALID');
      return {projectId,taskId:task.taskId,taskState:task.state,decisions:task.decisions,tools:task.tools,outputRefs:refs,assetKinds:data.outputs.map((item)=>item.assetKind),agentRunHistory:agent.meta.nodeRunHistory?.length||0,jsonRunHistory:receiver.meta.nodeRunHistory?.length||0,jsonText:receiver.props.text,agentRunId:agent.meta.nodeRun?.runId||null,jsonRunId:receiver.meta.nodeRun?.runId||null};
    };
    if(${phase === 'execute'}){
      const config=JSON.stringify({schemaVersion:1,role:'specialist',interactionMode:'autonomous',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:['shape:ast05-first','shape:ast05-second'],maxSteps:12,relations:[]});
      editor.createShape({id:'shape:ast05-source',type:'node-card',x:100,y:100,props:{nodeType:'text',title:'固定多成果材料',text:'private-ast05-material'}});
      editor.createShape({id:'shape:ast05-first',type:'node-card',x:500,y:100,props:{nodeType:'processor',title:'第一成果',config:JSON.stringify({operation:'template',template:'first: {{value}}'})}});
      editor.createShape({id:'shape:ast05-second',type:'node-card',x:500,y:430,props:{nodeType:'processor',title:'第二成果',config:JSON.stringify({operation:'template',template:'second: {{value}}'})}});
      editor.createShape({id:'shape:ast05-agent',type:'node-card',x:950,y:180,props:{nodeType:'agent',title:'多成果专业 Agent',text:'依次执行第一成果和第二成果两个授权处理节点，将两份固定文本成果都作为最终交付。',config}});
      editor.createShape({id:'shape:ast05-json',type:'node-card',x:1420,y:180,props:{nodeType:'json',title:'普通 JSON 下游',text:'{}'}});
      const {createEdge}=await import('/src/canvas/graph.ts');
      for(const [from,fromPort,to,toPort] of [['shape:ast05-source','out-text','shape:ast05-agent','in-text'],['shape:ast05-source','out-text','shape:ast05-first','in-value'],['shape:ast05-source','out-text','shape:ast05-second','in-value'],['shape:ast05-agent','out-json','shape:ast05-json','in-json']])if(!createEdge(editor,{shapeId:from,portId:fromPort},{shapeId:to,portId:toPort}))throw new Error('AST05_EDGE_MISSING');
      await ensureCanvasSaved();
      const {runNodeManually}=await import('/src/engine/executor.ts');
      const agentResult=await runNodeManually(editor,projectId,[],'shape:ast05-agent');
      if(agentResult.status!=='done'){
        const task=await inspect().catch(()=>null);
        const agent=editor.getShape('shape:ast05-agent');
        const result=JSON.parse(agent?.meta.nodeResult||'{}');
        const outputs=result.outputs?.['out-json']?.data;
        const projected=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(agent)['out-json'];
        const downstreamResult=await runNodeManually(editor,projectId,[],'shape:ast05-json');
        await ensureCanvasSaved();
        const receiver=editor.getShape('shape:ast05-json');
        return {executionFailure:{status:agentResult.status,taskState:task?.state||null,taskCode:task?.code||null,decisions:task?.decisions||0,tools:task?.tools||0,execState:agent?.props.exec||null,runState:agent?.meta.nodeRun?.status||null,errorPhase:agent?.meta.nodeRun?.error?.phase||null,outputSetKind:outputs?.kind||null,outputCount:outputs?.outputs?.length||0,outputSources:outputs?.outputs?.map((item)=>item.ref.sourceNodeId)||[],versionIds:outputs?.outputs?.map((item)=>item.ref.versionId)||[],outJsonProjectionAvailable:projected?.kind==='json',downstreamStatus:downstreamResult.status,downstreamExecState:receiver?.props.exec||null,downstreamRunState:receiver?.meta.nodeRun?.status||null,downstreamTextLength:receiver?.props.text?.length||0}};
      }
      await ensureCanvasSaved();
      const task=await inspect();
      if(task?.state!=='completed')throw new Error('AST05_AGENT_NOT_COMPLETED');
      const jsonResult=await runNodeManually(editor,projectId,[],'shape:ast05-json');
      if(jsonResult.status!=='done')throw new Error('AST05_JSON_EXECUTOR_FAILED');
      await ensureCanvasSaved();
      const completed=await check();
      if(completed.agentRunHistory!==1||completed.jsonRunHistory!==1)throw new Error('AST05_EXECUTION_COUNT_INVALID');
      return {...completed,agentExecution:agentResult.status,jsonExecution:jsonResult.status,checks:['two authorized processors create distinct fixed text references','Agent out-json preserves both references in source order','ordinary JSON node consumes Agent out-json and preserves the complete output set','checkpoint is saved before a second Electron process reopens the project']};
    }
    const current=await check();
    const previous=${JSON.stringify(previous)};
    if(!previous||current.taskId!==previous.taskId||JSON.stringify(current.outputRefs)!==JSON.stringify(previous.outputRefs)||current.agentRunHistory!==previous.agentRunHistory||current.jsonRunHistory!==previous.jsonRunHistory||current.agentRunId!==previous.agentRunId||current.jsonRunId!==previous.jsonRunId||current.jsonText!==previous.jsonText)throw new Error('AST05_REOPEN_FACT_DRIFT');
    await ensureCanvasSaved();
    return {...current,modelReplay:false,checks:['output set, fixed references and ordinary downstream JSON output survive new-process reopen','Agent and downstream executors are not replayed on reopen']};
  })()`)
  if (phase === 'execute' && (report as { executionFailure?: unknown }).executionFailure) {
    writeFileSync(
      join(directory, 'ast05-agent-execution-failure.json'),
      JSON.stringify((report as { executionFailure: unknown }).executionFailure, null, 2)
    )
    await window.webContents.capturePage().then((image) => {
      writeFileSync(join(directory, 'ast05-execute-failure.png'), image.toPNG())
    })
    throw new Error('AST05_AGENT_OUTPUT_MATERIALIZATION_FAILED')
  }
  if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
  writeFileSync(join(directory, `ast05-${phase}.json`), JSON.stringify(report, null, 2))
  await window.webContents.capturePage().then((image) => {
    writeFileSync(join(directory, `ast05-${phase}.png`), image.toPNG())
  })
  return report
}
