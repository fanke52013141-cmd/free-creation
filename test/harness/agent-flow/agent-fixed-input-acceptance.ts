// Isolated desktop acceptance; only loaded by the hidden Agent test harness.
import type { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type AcceptanceState = {
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
  sourceTextAfterSelection: string
}

export async function acceptAgentFixedInputVersion(input: {
  window: BrowserWindow
  directory: string
  statePath: string
  projectId: string
  phase: string
}): Promise<unknown> {
  const { window, directory, statePath, projectId, phase } = input
  const previous =
    phase === 'reopen'
      ? (JSON.parse(readFileSync(statePath, 'utf8')) as AcceptanceState)
      : null
  const report = await window.webContents.executeJavaScript(`(async()=>{
    const projectId=${JSON.stringify(projectId)};
    const phase=${JSON.stringify(phase)};
    const editor=(await import('/src/stores/editor.ts')).useEditorStore.getState().editor;
    const {ensureCanvasSaved,placeFlowAsset}=await import('/src/canvas/flow-asset-actions.ts');
    const value=(reply)=>{if(!reply.ok)throw new Error(reply.error.code);return reply.data};
    const sourceNodeId='shape:ast01-source';
    const agentNodeId='shape:ast01-agent';
    const processorNodeId='shape:ast01-processor';
    const inspect=()=>window.api.inspectFlowAgent({projectId,nodeId:agentNodeId}).then(value);
    const delay=()=>new Promise(resolve=>setTimeout(resolve,50));
    const until=async(test,code)=>{for(let i=0;i<300;i++){if(test())return;await delay();}throw new Error(code);};
    const listVersions=()=>window.api.listFlowAssets({projectId,nodeId:sourceNodeId,portId:'out-text'}).then(value);
    const state=(await import('/src/stores/nodePanel.ts')).useNodePanelStore;
    const openAssetPanel=async()=>{
      state.getState().open('contract',sourceNodeId,'settings');
      await until(()=>document.querySelector('#contract-tab-io'),'AST01_CONTRACT_PANEL_MISSING');
      const ioTab=document.querySelector('#contract-tab-io');
      if(!ioTab)throw new Error('AST01_IO_TAB_MISSING');
      ioTab.click();
      await until(()=>document.querySelector('[aria-label="已提交资产版本"]'),'AST01_ASSET_VERSION_UI_MISSING');
      return document.querySelector('[aria-label="已提交资产版本"]');
    };
    const chooseVersion=async(versionId,ordinal,expectedText)=>{
      const select=await openAssetPanel();
      select.click();
      await until(()=>[...document.querySelectorAll('[role="option"]')].some(option=>option.textContent?.trim().startsWith('v'+ordinal+' ·')),'AST01_VERSION_OPTION_MISSING');
      const option=[...document.querySelectorAll('[role="option"]')].find(item=>item.textContent?.trim().startsWith('v'+ordinal+' ·'));
      if(!option)throw new Error('AST01_VERSION_OPTION_MISSING');
      option.click();
      await until(()=>select.textContent?.includes('v'+ordinal+' ·')&&document.querySelector('.flow-asset-panel pre')?.textContent===expectedText,'AST01_SELECTED_VERSION_NOT_RENDERED');
      return {selectedVersionId:versionId,triggerText:select.textContent||'',preview:document.querySelector('.flow-asset-panel pre')?.textContent||''};
    };

    if(phase==='execute'){
      const agentConfig={schemaVersion:1,role:'specialist',interactionMode:'collaborative',modelDefinitionId:'agent-test-model',skills:[],tools:[{id:'node.execute',version:'1'}],allowedNodeIds:[processorNodeId],maxSteps:8,relations:[]};
      editor.createShape({id:sourceNodeId,type:'node-card',x:100,y:100,props:{nodeType:'text',title:'AST-01 可变草稿',text:'AST01_FIXED_V1'}});
      editor.createShape({id:processorNodeId,type:'node-card',x:540,y:100,props:{nodeType:'processor',title:'固定输入检查处理器',config:JSON.stringify({operation:'pass'})}});
      editor.createShape({id:agentNodeId,type:'node-card',x:980,y:130,props:{nodeType:'agent',title:'AST-01 固定版本 Agent',text:'AST01_FIXED_INPUT_FIXTURE：等待人工继续后，只执行一次授权处理器并提交真实回执。任务开始时的输入版本必须保持固定。',config:JSON.stringify(agentConfig)}});
      const {createEdge}=await import('/src/canvas/graph.ts');
      for(const [from,fromPort,to,toPort] of [[sourceNodeId,'out-text',agentNodeId,'in-text'],[sourceNodeId,'out-text',processorNodeId,'in-value']]){
        if(!createEdge(editor,{shapeId:from,portId:fromPort},{shapeId:to,portId:toPort}))throw new Error('AST01_INITIAL_EDGE_MISSING');
      }
      await ensureCanvasSaved();
      const button=document.querySelector('[data-node-id="'+agentNodeId+'"] .node-standard-primary');
      if(!button||button.disabled)throw new Error('AST01_AGENT_START_BUTTON_UNAVAILABLE');
      button.click();
      const waiting=await (async()=>{for(let i=0;i<300;i++){const task=await inspect();if(task?.state==='waiting')return task;if(task&&['blocked','failed'].includes(task.state))throw new Error(task.code||'AST01_TASK_FAILED_BEFORE_WAIT');await delay();}throw new Error('AST01_TASK_WAIT_TIMEOUT');})();
      await until(()=>editor.getShape(agentNodeId)?.props.exec!=='running','AST01_TASK_RUN_DID_NOT_SETTLE');
      const v1=(await listVersions()).find(item=>item.ordinal===1);
      if(!v1)throw new Error('AST01_INITIAL_FIXED_VERSION_MISSING');
      if((editor.getShape(processorNodeId)?.meta.nodeRunHistory?.length||0)!==0)throw new Error('AST01_TOOL_RAN_BEFORE_CONTINUE');

      await openAssetPanel();
      editor.updateShape({id:sourceNodeId,type:'node-card',props:{text:'AST01_FIXED_V2'}});
      await ensureCanvasSaved();
      const submit=[...document.querySelectorAll('.flow-asset-panel button')].find(button=>button.textContent?.trim()==='提交当前输出为新版本');
      if(!submit||submit.disabled)throw new Error('AST01_NEW_VERSION_BUTTON_UNAVAILABLE');
      submit.click();
      await until(()=>document.querySelector('[aria-label="已提交资产版本"]')?.textContent?.includes('v2 ·')&&document.querySelector('.flow-asset-panel pre')?.textContent==='AST01_FIXED_V2','AST01_NEW_VERSION_SUBMIT_FAILED');
      const versions=await listVersions();
      const v2=versions.find(item=>item.ordinal===2);
      if(!v2||v1.ref.assetId!==v2.ref.assetId||v1.ref.versionId===v2.ref.versionId)throw new Error('AST01_VERSION_IDENTITY_INVALID');

      editor.updateShape({id:sourceNodeId,type:'node-card',props:{text:'AST01_FIXED_V1'}});
      await ensureCanvasSaved();
      const currentSelection=await chooseVersion(v2.ref.versionId,v2.ordinal,'AST01_FIXED_V2');
      const selected=document.querySelector('[aria-label="已提交资产版本"]');
      const preview=document.querySelector('.flow-asset-panel pre')?.textContent||'';
      if(currentSelection.selectedVersionId!==v2.ref.versionId||!selected?.textContent?.includes('v2 ·')||preview!=='AST01_FIXED_V2')throw new Error('AST01_CURRENT_VERSION_SELECTION_NOT_V2');
      const saved=value(await window.api.openProject(projectId));
      if(saved.tldrawSnapshot.store[sourceNodeId]?.props?.text!=='AST01_FIXED_V1')throw new Error('AST01_SOURCE_RESTORE_MISSING');
      state.getState().close();
      await ensureCanvasSaved();
      if((await inspect()).taskId!==waiting.taskId)throw new Error('AST01_WAITING_TASK_ID_DRIFT');
      const result={projectId,taskId:waiting.taskId,sourceNodeId,agentNodeId,processorNodeId,v1VersionId:v1.ref.versionId,v2VersionId:v2.ref.versionId,assetId:v1.ref.assetId,v1Ordinal:v1.ordinal,v2Ordinal:v2.ordinal,selectedVersionId:currentSelection.selectedVersionId,sourceTextAfterSelection:saved.tldrawSnapshot.store[sourceNodeId].props.text,state:'waiting',processorRuns:0,checks:['Agent task paused before any processor tool','the same source has immutable v1 and v2','asset version panel selects and renders v2','editable source is restored to its original semantic value before old task resume','waiting task identity is preserved for new-process continuation']};
      return result;
    }

    const previous=${JSON.stringify(previous)};
    if(!previous||projectId!==previous.projectId)throw new Error('AST01_REOPEN_STATE_MISSING');
    const task=await inspect();
    if(task?.taskId!==previous.taskId||task.state!=='waiting')throw new Error('AST01_WAITING_TASK_NOT_RESTORED');
    const source=editor.getShape(sourceNodeId);
    if(source?.props.text!=='AST01_FIXED_V1')throw new Error('AST01_RESTORED_SOURCE_SEMANTICS_DRIFT');
    if((editor.getShape(processorNodeId)?.meta.nodeRunHistory?.length||0)!==0)throw new Error('AST01_TOOL_REPLAYED_ON_REOPEN');
    const versions=await listVersions();
    const v1=versions.find(item=>item.ref.versionId===previous.v1VersionId);
    const v2=versions.find(item=>item.ref.versionId===previous.v2VersionId);
    if(!v1||!v2||v1.ref.assetId!==v2.ref.assetId)throw new Error('AST01_ASSET_VERSIONS_NOT_RESTORED');
    const selected=await chooseVersion(previous.v2VersionId,previous.v2Ordinal,'AST01_FIXED_V2');
    if(selected.selectedVersionId!==previous.v2VersionId||selected.preview!=='AST01_FIXED_V2')throw new Error('AST01_V2_NOT_SELECTED_AFTER_REOPEN');
    state.getState().close();
    await ensureCanvasSaved();
    const button=document.querySelector('[data-node-id="'+agentNodeId+'"] .node-standard-primary');
    if(!button||button.disabled)throw new Error('AST01_AGENT_CONTINUE_BUTTON_UNAVAILABLE');
    button.click();
    const done=await (async()=>{for(let i=0;i<600;i++){const current=await inspect();if(current?.state==='completed')return current;if(current&&['blocked','failed'].includes(current.state))throw new Error(current.code||'AST01_TASK_RESUME_FAILED');await delay();}throw new Error('AST01_TASK_COMPLETE_TIMEOUT');})();
    await until(()=>editor.getShape(agentNodeId)?.props.exec!=='running','AST01_AGENT_EXECUTOR_DID_NOT_SETTLE');
    await ensureCanvasSaved();
    const processor=editor.getShape(processorNodeId);
    const agent=editor.getShape(agentNodeId);
    const projectOutputs=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs;
    const processorOutput=projectOutputs(processor)?.['out-value'];
    const agentOutput=projectOutputs(agent)?.['out-text'];
    if(processor?.meta.nodeRun?.status!=='success'||processorOutput?.kind!=='text'||processorOutput.text!=='AST01_FIXED_V1')throw new Error('AST01_PROCESSOR_DID_NOT_USE_FIXED_V1');
    if(agent?.meta.nodeRun?.status!=='success'||agentOutput?.kind!=='text'||agentOutput.text!=='AST01_FIXED_V1')throw new Error('AST01_AGENT_OUTPUT_NOT_FIXED_V1');
    const result={...previous,taskState:done.state,decisions:done.decisions,tools:done.tools,processorRuns:processor.meta.nodeRunHistory?.length||0,processorOutput:processorOutput.text,agentOutput:agentOutput.text,selectedVersionIdAfterReopen:selected.selectedVersionId,taskIdAfterReopen:done.taskId,checks:['waiting task survives a new Electron process','v2 remains selected and visible in the asset version UI','original task resumes with the same identity','one processor execution receives and returns fixed v1 after v2 is selected','Agent public output remains the original v1 result']};
    return result;
  })()`)
  writeFileSync(join(directory, `ast01-${phase}.json`), JSON.stringify(report, null, 2))
  await window.webContents.capturePage().then((image) => {
    writeFileSync(join(directory, `ast01-${phase}.png`), image.toPNG())
  })
  if (phase === 'execute') writeFileSync(statePath, JSON.stringify(report))
  return report
}
