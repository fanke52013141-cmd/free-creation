// Isolated real-desktop acceptance helper, never imported by the application.
import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { importMedia } from '../store/media.repo'

export async function acceptVideoReview(input: {
  window: BrowserWindow
  directory: string
  projectId: string
  phase: string
  common: string
}): Promise<unknown> {
  const { window, directory, projectId, phase, common } = input
  const media =
    phase === 'execute'
      ? await importMedia(projectId, join(directory, 'review-blue.mp4'))
      : await importMedia(projectId, join(directory, 'review-red.mp4'))
  if (!media.ok) throw new Error('VISUAL_REVIEW_IMPORT_FAILED')
  const report = await window.webContents.executeJavaScript(`(async()=>{${common}
    const media=${JSON.stringify(media.asset)};
    const delay=()=>new Promise(done=>setTimeout(done,25));
    const blocked=async()=>{const r=await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:visual-target'});if(r.ok||r.error.code!=='FLOW_REVIEW_NOT_READY')throw new Error('VISUAL_REVIEW_GATE_BYPASSED');};
    const run=async(passed)=>{
      editor.centerOnPoint(editor.getShapePageBounds('shape:visual-review').center,{animation:{duration:0}});
      let button;for(let i=0;i<200;i++){button=[...document.querySelectorAll('[data-node-id="shape:visual-review"] .node-standard-primary')].find(b=>b.textContent.includes('审核')||b.textContent.includes('复审'));if(button&&!button.disabled)break;await delay();}
      if(!button||button.disabled)throw new Error('VISUAL_REVIEW_BUTTON_MISSING');const previousRun=editor.getShape('shape:visual-review').meta.nodeRun?.runId;button.click();
      for(let i=0;i<1000;i++){const shape=editor.getShape('shape:visual-review');if(shape.meta.nodeRun?.runId!==previousRun&&shape.props.exec==='failed')throw new Error('VISUAL_REVIEW_EXECUTION_FAILED');let decision;try{decision=JSON.parse(shape.meta.nodeResult)}catch{}if(shape.meta.nodeRun?.runId!==previousRun&&shape.props.exec==='success'&&!button.disabled&&decision?.passed===passed){await ensureCanvasSaved();if(decision.evidenceScope!=='sampled'||decision.videoEvidence?.frames.length!==4)throw new Error('VISUAL_REVIEW_SCOPE_LOST');return decision;}await delay();}throw new Error('VISUAL_REVIEW_TIMEOUT');
    };
    if(${phase === 'execute'}) {
      editor.createShape({id:'shape:visual-source',type:'node-card',x:100,y:100,props:{nodeType:'video-asset',title:'人工视频素材',mediaId:media.id,mediaPath:media.path,mediaMime:media.mime}});
      editor.createShape({id:'shape:visual-review',type:'node-card',x:530,y:100,props:{nodeType:'ai-review',title:'抽帧画面审核',text:'private-c3-video-rule：只有四张样本都为红色画面时通过，其他颜色拒绝；不能据此判断声音和完整时序。',config:JSON.stringify({schemaVersion:1,reviewMode:'sampled-video',modelDefinitionId:'agent-test-model',rulesVersion:'visual-1',rejectPolicy:'rework',maxReworks:1,responsibleNodeId:'shape:visual-source',subjectSources:[{nodeId:'shape:visual-source',portId:'out-video'}],gatedNodeIds:['shape:visual-target'],relations:[]})}});
      editor.createShape({id:'shape:visual-target',type:'node-card',x:1000,y:100,props:{nodeType:'video-frame',title:'审核后取帧'}});
      const {createEdge}=await import('/src/canvas/graph.ts');
      if(!createEdge(editor,{shapeId:'shape:visual-source',portId:'out-video'},{shapeId:'shape:visual-review',portId:'in-video'})||!createEdge(editor,{shapeId:'shape:visual-source',portId:'out-video'},{shapeId:'shape:visual-target',portId:'in-video'}))throw new Error('VISUAL_REVIEW_REAL_PORT_MISSING');
      await ensureCanvasSaved();await blocked();const decision=await run(false);await blocked();
      return {projectId,reviewId:decision.reviewId,versionId:decision.subjects[0].versionId,checks:['real video port and fixed MP4 input','real FFprobe timeline and four JPEGs reach SDK','negative sampled verdict blocks downstream','human correction remains explicit']};
    }
    await blocked();const old=JSON.parse(editor.getShape('shape:visual-review').meta.nodeResult);
    const replay=await run(false);if(replay.reviewId!==old.reviewId)throw new Error('VISUAL_REVIEW_REPLAYED_REQUEST');
    editor.updateShape({id:'shape:visual-source',type:'node-card',props:{mediaId:media.id,mediaPath:media.path,mediaMime:media.mime}});await ensureCanvasSaved();await blocked();
    const approved=await run(true);if(approved.subjects[0].versionId===old.subjects[0].versionId||approved.reviewRevision!==1)throw new Error('VISUAL_REVIEW_FIXED_VERSION_LOST');
    value(await window.api.checkFlowNodeAvailability({projectId,nodeId:'shape:visual-target'}));
    const result=await(await import('/src/engine/executor.ts')).runNodeManually(editor,projectId,[],'shape:visual-target');if(result.status!=='done')throw new Error('VISUAL_REVIEW_DOWNSTREAM_FAILED');await ensureCanvasSaved();
    const output=(await import('/src/nodes/nodeValues.ts')).projectNodeOutputs(editor.getShape('shape:visual-target'))['out-image'];if(output?.kind!=='image')throw new Error('VISUAL_REVIEW_OUTPUT_MISSING');
    editor.centerOnPoint(editor.getShapePageBounds('shape:visual-review').center);await delay();
    if(!document.querySelector('[data-node-id="shape:visual-review"]')?.textContent.includes('抽样画面'))throw new Error('VISUAL_REVIEW_BOUNDARY_HIDDEN');
    return {projectId,reviewId:approved.reviewId,videoSha256:approved.videoEvidence.contentSha256,frameCount:4,checks:['negative verdict survives process reopening','unchanged input reuses report without model replay','manual video replacement creates a distinct fixed version','sampled scope and timestamps remain visible','approved fixed video releases actual frame extraction']};
  })()`)
  // The fixture destroys its hidden renderer immediately; drain its normal 50ms diagnostic batch first.
  await window.webContents.executeJavaScript(`(async()=>{
    const diagnostics=await import('/src/engine/diagnosticsReporter.ts');
    while(diagnostics.pendingDiagnosticsEventCount())diagnostics.flushDiagnosticsEvents();
    await new Promise(done=>setTimeout(done,100));
    if(diagnostics.diagnosticsTransportDropCount())throw new Error('VISUAL_REVIEW_DIAGNOSTICS_DROPPED');
  })()`)
  if (phase === 'reopen') {
    await window.webContents.executeJavaScript(
      'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'
    )
    window.webContents.invalidate()
    await new Promise((done) => setTimeout(done, 300))
    writeFileSync(
      join(directory, 'video-review.png'),
      (await window.webContents.capturePage()).toPNG()
    )
  }
  return report
}
