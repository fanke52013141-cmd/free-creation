// Isolated real-desktop acceptance helper, never imported by the application.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { importMedia } from '../store/media.repo'

type ReviewMedia = { id: string; path: string; mime: string }

export async function acceptMediaReview(input: {
  window: BrowserWindow
  directory: string
  projectId: string
  phase: string
  common: string
}): Promise<unknown> {
  const { window, directory, projectId, phase, common } = input
  const statePath = join(directory, 'media-review-assets.json')
  let media: { image: ReviewMedia; audio: ReviewMedia; video: ReviewMedia }
  if (phase === 'execute') {
    const imagePath = join(directory, 'media-review-image.png')
    const audioPath = join(directory, 'media-review-audio.wav')
    const videoPath = join(directory, 'media-review-av.mp4')
    writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYawAAAAASUVORK5CYII=',
        'base64'
      )
    )
    const { copyFileSync } = await import('node:fs')
    copyFileSync(join('test/fixtures', 'agent-audio.wav'), audioPath)
    execFileSync(
      process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-i',
        join('test/fixtures', 'agent-review-red.mp4'),
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        videoPath
      ],
      { windowsHide: true, stdio: 'ignore' }
    )
    const [image, audio, video] = await Promise.all([
      importMedia(projectId, imagePath),
      importMedia(projectId, audioPath),
      importMedia(projectId, videoPath)
    ])
    if (!image.ok || !audio.ok || !video.ok) throw new Error('MEDIA_REVIEW_IMPORT_FAILED')
    media = {
      image: { id: image.asset.id, path: image.asset.path, mime: image.asset.mime },
      audio: { id: audio.asset.id, path: audio.asset.path, mime: audio.asset.mime },
      video: { id: video.asset.id, path: video.asset.path, mime: video.asset.mime }
    }
    writeFileSync(statePath, JSON.stringify(media))
  } else media = JSON.parse(readFileSync(statePath, 'utf8'))

  const report = await window.webContents.executeJavaScript(`(async()=>{${common}
    const media=${JSON.stringify(media)};
    const specs=[
      {key:'image',source:'shape:media-review-image',review:'shape:media-review-image-check',nodeType:'image',port:'out-image',input:'in-image',mode:'image'},
      {key:'audio',source:'shape:media-review-audio',review:'shape:media-review-audio-check',nodeType:'audio',port:'out-audio',input:'in-audio',mode:'audio'},
      {key:'video',source:'shape:media-review-av',review:'shape:media-review-av-check',nodeType:'video-asset',port:'out-video',input:'in-video',mode:'audio-video'}
    ];
    const delays=()=>new Promise(done=>setTimeout(done,50));
    const readDecision=(id)=>{try{return JSON.parse(editor.getShape(id).meta.nodeResult)}catch{return null}};
    const run=async(spec)=>{
      const shape=editor.getShape(spec.review);if(!shape)throw new Error('MEDIA_REVIEW_NODE_MISSING');
      const previous=shape.meta.nodeRun?.runId;
      editor.centerOnPoint(editor.getShapePageBounds(spec.review).center,{animation:{duration:0}});
      let button;for(let i=0;i<200;i++){button=[...document.querySelectorAll('[data-node-id="'+spec.review+'"] .node-standard-primary')].find(b=>b.textContent.includes('审核')||b.textContent.includes('复审'));if(button&&!button.disabled)break;await delays();}
      if(!button||button.disabled)throw new Error('MEDIA_REVIEW_BUTTON_UNAVAILABLE');button.click();
      for(let i=0;i<1000;i++){
        const current=editor.getShape(spec.review),decision=readDecision(spec.review);
        if(current.meta.nodeRun?.runId!==previous&&current.props.exec==='failed')throw new Error('MEDIA_REVIEW_EXECUTION_FAILED');
        if(current.meta.nodeRun?.runId!==previous&&current.props.exec==='success'&&decision?.evidenceScope){await ensureCanvasSaved();return decision;}
        await delays();
      }
      throw new Error('MEDIA_REVIEW_TIMEOUT');
    };
    if(${phase === 'execute'}){
      for(const spec of specs){
        const asset=media[spec.key];
        editor.createShape({id:spec.source,type:'node-card',x:100,y:100+specs.indexOf(spec)*420,props:{nodeType:spec.nodeType,title:'固定'+spec.mode+'素材',mediaId:asset.id,mediaPath:asset.path,mediaMime:asset.mime}});
        editor.createShape({id:spec.review,type:'node-card',x:600,y:100+specs.indexOf(spec)*420,props:{nodeType:'ai-review',title:spec.mode+'完整素材审核',text:'按当前标准评估固定素材；仅根据实际发送的媒体证据出具结论。',config:JSON.stringify({schemaVersion:1,reviewMode:spec.mode,modelDefinitionId:'agent-test-model',rulesVersion:'media-review-1',rejectPolicy:'stop',maxReworks:0,responsibleNodeId:spec.source,subjectSources:[{nodeId:spec.source,portId:spec.port}],gatedNodeIds:[],relations:[]})}});
      }
      const {createEdge}=await import('/src/canvas/graph.ts');
      for(const spec of specs)if(!createEdge(editor,{shapeId:spec.source,portId:spec.port},{shapeId:spec.review,portId:spec.input}))throw new Error('MEDIA_REVIEW_PORT_MISSING');
      await ensureCanvasSaved();
      const decisions=[];for(const spec of specs)decisions.push(await run(spec));
      const [image,audio,av]=decisions;
      if(image.evidenceScope!=='complete-image'||image.imageEvidence?.method!=='full-image-v1'||image.imageEvidence.byteLength<50)throw new Error('MEDIA_REVIEW_IMAGE_EVIDENCE_MISSING');
      if(audio.evidenceScope!=='complete-audio'||audio.audioEvidence?.method!=='full-audio-v1'||audio.audioEvidence.byteLength<1000||audio.audioEvidence.sampleRate!==16000||audio.audioEvidence.channels!==1)throw new Error('MEDIA_REVIEW_AUDIO_EVIDENCE_MISSING');
      if(av.evidenceScope!=='audio-video-timeline'||av.audioVideoEvidence?.method!=='audio-video-timeline-v1'||av.audioVideoEvidence.videoFrameCount<4||av.audioVideoEvidence.frames.length!==4||!av.audioVideoEvidence.frameTimelineSha256||av.audioVideoEvidence.audioByteLength<1000)throw new Error('MEDIA_REVIEW_AV_EVIDENCE_MISSING');
      return {projectId,reviewIds:decisions.map(item=>item.reviewId),checks:['public desktop review button covers complete fixed PNG bytes','public desktop review button sends complete normalized WAV evidence','public desktop review button sends synchronized audio and timestamped frame sample evidence','sample-only visual limit remains explicit']};
    }
    const decisions=[];for(const spec of specs)decisions.push(await run(spec));
    const [image,audio,av]=decisions;
    if(image.evidenceScope!=='complete-image'||audio.evidenceScope!=='complete-audio'||av.evidenceScope!=='audio-video-timeline')throw new Error('MEDIA_REVIEW_REOPEN_EVIDENCE_MISSING');
    for(const [index,spec] of specs.entries())if(decisions[index].reviewId!==readDecision(spec.review)?.reviewId)throw new Error('MEDIA_REVIEW_REPLAY_CHANGED');
    editor.centerOnPoint(editor.getShapePageBounds('shape:media-review-av-check').center,{animation:{duration:0}});await delays();
    return {projectId,reviewIds:decisions.map(item=>item.reviewId),checks:['three fixed-media review receipts survive process restart','reopened image, audio and A/V evidence scopes remain distinct']};
  })()`)
  if (phase === 'reopen') {
    await window.webContents.executeJavaScript(
      'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'
    )
    window.webContents.invalidate()
    await new Promise((done) => setTimeout(done, 300))
    writeFileSync(join(directory, 'media-review.png'), (await window.webContents.capturePage()).toPNG())
  }
  return report
}
