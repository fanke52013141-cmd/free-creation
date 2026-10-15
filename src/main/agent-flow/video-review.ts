import type Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, basename } from 'node:path'
import { getDataDir } from '../store/db'
import { fixedFlowMedia } from './image-assets'
import { FlowAssetError, type FlowAssetValue } from '../../shared/agent-flow/assets'
import type { ReviewDecision } from '../../shared/agent-flow/node-contracts'
import {
  VideoReviewEvidenceSchema,
  type VideoReviewSamples
} from '../../shared/agent-flow/video-review'
import {
  AudioReviewEvidenceSchema,
  AudioVideoTimelineEvidenceSchema,
  ImageReviewEvidenceSchema,
  type AudioReviewInput,
  type AudioVideoReviewInput,
  type ImageReviewInput
} from '../../shared/agent-flow/media-review'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const failure = (code = 'FLOW_VIDEO_REVIEW_DECODE_FAILED'): AgentRuntimeError =>
  new AgentRuntimeError(code, code.startsWith('FLOW_MEDIA_REVIEW_') ? 'media-review' : 'video-review-samples')

/** Bounded, cancellable local subprocess. Never surface filenames, stderr or decoder text. */
function decode(
  binary: string,
  args: string[],
  signal: AbortSignal,
  limit: number,
  fail: (code?: string) => AgentRuntimeError = failure,
  codePrefix = 'FLOW_VIDEO_REVIEW'
): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(fail('AGENT_CANCELLED_OR_TIMED_OUT'))
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0,
      code: string | undefined
    const stop = (reason: string): void => {
      code ??= reason
      child.kill()
    }
    const abort = (): void => stop('AGENT_CANCELLED_OR_TIMED_OUT')
    const timer = setTimeout(() => stop(`${codePrefix}_DECODE_FAILED`), 10000)
    signal.addEventListener('abort', abort, { once: true })
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) stop(`${codePrefix}_LIMIT`)
      else chunks.push(chunk)
    })
    child.once('error', () => {
      cleanup()
      reject(fail(`${codePrefix}_TOOL_UNAVAILABLE`))
    })
    child.once('close', (status) => {
      cleanup()
      if (code || status !== 0 || !size) reject(fail(code ?? `${codePrefix}_DECODE_FAILED`))
      else done(Buffer.concat(chunks))
    })
    if (signal.aborted) abort()
  })
}

/** Legacy generated versions are reviewable only with their retained committed download receipt. */
export function reviewVideoValue(
  db: Database.Database,
  projectId: string,
  value: FlowAssetValue,
  sourceNodeId: string
): FlowAssetValue {
  if (value.kind !== 'video' || value.contentSha256) return value
  const rows = db
    .prepare(
      "SELECT output FROM tasks WHERE project_id=? AND node_id=? AND kind='video' AND status='success' AND json_extract(output,'$.mediaId')=?"
    )
    .all(projectId, sourceNodeId, value.mediaId) as { output: string }[]
  if (rows.length !== 1) throw failure('FLOW_VIDEO_REVIEW_NOT_FIXED')
  const receipt = JSON.parse(rows[0].output).videoMaterialization
  if (receipt?.phase !== 'committed' || !/^[a-f0-9]{64}$/.test(receipt.digest ?? ''))
    throw failure('FLOW_VIDEO_REVIEW_NOT_FIXED')
  return { ...value, contentSha256: receipt.digest }
}

async function reviewBytes(path: string, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw failure('AGENT_CANCELLED_OR_TIMED_OUT')
  try {
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024)
        throw failure('FLOW_VIDEO_REVIEW_LIMIT')
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        if (signal.aborted) throw failure('AGENT_CANCELLED_OR_TIMED_OUT')
        const read = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) throw failure('ASSET_VIDEO_CHANGED')
        offset += read.bytesRead
      }
      return bytes
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error
    throw failure('ASSET_VIDEO_CHANGED')
  }
}

async function reviewMediaBytes(
  path: string,
  signal: AbortSignal,
  expectedKind: 'image' | 'audio',
  limit = 20 * 1024 * 1024
): Promise<Buffer> {
  if (signal.aborted) throw failure('AGENT_CANCELLED_OR_TIMED_OUT')
  const changedCode = expectedKind === 'image' ? 'ASSET_IMAGE_CHANGED' : 'ASSET_AUDIO_CHANGED'
  try {
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size <= 0 || stat.size > limit)
        throw failure('FLOW_MEDIA_REVIEW_LIMIT')
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        if (signal.aborted) throw failure('AGENT_CANCELLED_OR_TIMED_OUT')
        const read = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) throw failure(changedCode)
        offset += read.bytesRead
      }
      return bytes
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error
    throw failure(changedCode)
  }
}

const mediaTools = (): { ffmpeg: string; ffprobe: string } => {
  const ffmpeg = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg'
  return {
    ffmpeg,
    ffprobe: process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim()
      ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
      : 'ffprobe'
  }
}

async function decodeAudioTrack(
  input: string,
  signal: AbortSignal,
  ffmpeg: string
): Promise<Buffer> {
  const audio = await decode(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-threads',
      '1',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1'
    ],
    signal,
    2_000_044,
    failure,
    'FLOW_MEDIA_REVIEW'
  )
  if (audio.length < 46 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE')
    throw failure('FLOW_MEDIA_REVIEW_DECODE_FAILED')
  return audio
}

async function audioMetadata(
  input: string,
  signal: AbortSignal,
  ffprobe: string
): Promise<{ durationMs: number; sampleRate: number; channels: number; startMs: number }> {
  const raw = await decode(
    ffprobe,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_entries',
      'format=duration:stream=codec_type,start_time,duration,sample_rate,channels',
      '-select_streams',
      'a:0',
      '-of',
      'json',
      input
    ],
    signal,
    8192,
    failure,
    'FLOW_MEDIA_REVIEW'
  )
  const payload = JSON.parse(raw.toString()) as {
    format?: { duration?: string }
    streams?: Array<{
      codec_type?: string
      start_time?: string
      duration?: string
      sample_rate?: string
      channels?: number
    }>
  }
  const stream = payload.streams?.[0]
  const duration = Number(stream?.duration ?? payload.format?.duration)
  const start = Number(stream?.start_time ?? 0)
  const sampleRate = Number(stream?.sample_rate)
  const channels = Number(stream?.channels)
  const durationMs = Math.round(duration * 1000)
  if (
    payload.streams?.length !== 1 ||
    stream?.codec_type !== 'audio' ||
    !Number.isFinite(durationMs) ||
    durationMs < 1 ||
    durationMs > 60000 ||
    !Number.isFinite(start) ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 1 ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 8
  )
    throw failure('FLOW_MEDIA_REVIEW_LIMIT')
  return { durationMs, sampleRate, channels, startMs: Math.round(start * 1000) }
}

/** Reads one immutable image version and submits its actual bytes as a full-image review input. */
export async function prepareImageReview(
  db: Database.Database,
  projectId: string,
  value: FlowAssetValue,
  signal: AbortSignal
): Promise<ImageReviewInput> {
  if (
    value.kind !== 'image' ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)
  )
    throw failure('FLOW_MEDIA_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
  const bytes = await reviewMediaBytes(resolve(getDataDir(), value.mediaPath), signal, 'image')
  const digest = hash(bytes)
  if (digest !== value.contentSha256) throw failure('ASSET_IMAGE_CHANGED')
  const matchesMagic =
    (value.mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (value.mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (value.mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
  if (!matchesMagic) throw failure('FLOW_MEDIA_REVIEW_DECODE_FAILED')
  return {
    bytes,
    evidence: ImageReviewEvidenceSchema.parse({
      method: 'full-image-v1',
      contentSha256: digest,
      mime: value.mime,
      byteLength: bytes.length
    })
  }
}

/** Normalizes the complete fixed audio to bounded 16 kHz mono WAV for the model file part. */
export async function prepareAudioReview(
  db: Database.Database,
  projectId: string,
  value: FlowAssetValue,
  signal: AbortSignal
): Promise<AudioReviewInput> {
  if (value.kind !== 'audio' || !value.contentSha256) throw failure('FLOW_MEDIA_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
  const source = await reviewMediaBytes(resolve(getDataDir(), value.mediaPath), signal, 'audio')
  const sourceSha256 = hash(source)
  if (sourceSha256 !== value.contentSha256) throw failure('ASSET_AUDIO_CHANGED')
  const directory = await mkdtemp(join(tmpdir(), 'canvas-review-video-'))
  let primary: unknown
  let result: AudioReviewInput | undefined
  let cleanupFailure: unknown
  try {
    const input = join(directory, 'input')
    await writeFile(input, source)
    const { ffmpeg, ffprobe } = mediaTools()
    const metadata = await audioMetadata(input, signal, ffprobe)
    const bytes = await decodeAudioTrack(input, signal, ffmpeg)
    fixedFlowMedia(db, projectId, value)
    if (hash(await reviewMediaBytes(resolve(getDataDir(), value.mediaPath), signal, 'audio')) !== sourceSha256)
      throw failure('ASSET_AUDIO_CHANGED')
    result = {
      bytes,
      mediaType: 'audio/wav',
      evidence: AudioReviewEvidenceSchema.parse({
        method: 'full-audio-v1',
        sourceSha256,
        contentSha256: hash(bytes),
        sourceMime: value.mime,
        durationMs: metadata.durationMs,
        sampleRate: 16000,
        channels: 1,
        byteLength: bytes.length
      })
    }
  } catch (error) {
    primary =
      error instanceof AgentRuntimeError || error instanceof FlowAssetError
        ? error
        : failure('FLOW_MEDIA_REVIEW_DECODE_FAILED')
  } finally {
    cleanupFailure = await cleanupReviewDirectory(directory, 'FLOW_MEDIA_REVIEW_CLEANUP_FAILED').then(
      undefined,
      (error: unknown) => error
    )
  }
  if (primary) throw primary
  if (cleanupFailure) throw cleanupFailure
  if (!result) throw failure('FLOW_MEDIA_REVIEW_DECODE_FAILED')
  return result
}

async function cleanupReviewDirectory(
  directory: string,
  code = 'FLOW_VIDEO_REVIEW_CLEANUP_FAILED'
): Promise<void> {
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-review-video-')
  )
    throw failure(code)
  await rm(directory, { recursive: true, force: true }).catch(() => {
    throw failure(code)
  })
}

/** Decode an immutable byte copy, not a mutable file after its admission check. */
export async function sampleReviewVideo(
  db: Database.Database,
  projectId: string,
  value: FlowAssetValue,
  signal: AbortSignal
): Promise<VideoReviewSamples> {
  if (value.kind !== 'video' || value.mime !== 'video/mp4' || !value.contentSha256)
    throw failure('FLOW_VIDEO_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
  const bytes = await reviewBytes(resolve(getDataDir(), value.mediaPath), signal)
  if (hash(bytes) !== value.contentSha256) throw failure('ASSET_VIDEO_CHANGED')
  const directory = await mkdtemp(join(tmpdir(), 'canvas-review-video-'))
  let primary: unknown
  let samples: VideoReviewSamples | undefined
  let cleanupFailure: unknown
  try {
    const input = join(directory, 'input.mp4')
    await writeFile(input, bytes)
    const ffmpeg = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim() || 'ffmpeg'
    const ffprobe = process.env.CANVAS_STUDIO_FFMPEG_PATH?.trim()
      ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
      : 'ffprobe'
    const probe = await decode(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'mov',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        input
      ],
      signal,
      4096
    )
    const durationMs = Math.round(Number(JSON.parse(probe.toString()).format?.duration) * 1000)
    if (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > 60000)
      throw failure('FLOW_VIDEO_REVIEW_LIMIT')
    const timeline = await decode(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'mov',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        input
      ],
      signal,
      512 * 1024
    )
    const entries = JSON.parse(timeline.toString()).frames as {
      best_effort_timestamp_time?: string
    }[]
    if (!Array.isArray(entries) || entries.length < 4 || entries.length > 6000)
      throw failure('FLOW_VIDEO_REVIEW_LIMIT')
    const indices = [0.1, 0.35, 0.6, 0.85].map((fraction) => Math.floor(entries.length * fraction))
    const times = indices.map((index) =>
      Math.round(Number(entries[index].best_effort_timestamp_time) * 1000)
    )
    if (
      times.some(
        (time, index) =>
          !Number.isFinite(time) ||
          time < 0 ||
          time >= durationMs ||
          (index > 0 && time <= times[index - 1])
      )
    )
      throw failure('FLOW_VIDEO_REVIEW_LIMIT')
    const images: Buffer[] = []
    for (const index of indices)
      images.push(
        await decode(
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
            '-f',
            'mov',
            '-i',
            input,
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-vf',
            `select=eq(n\\,${index}),scale=640:640:force_original_aspect_ratio=decrease,format=yuvj420p`,
            '-an',
            '-c:v',
            'mjpeg',
            '-threads:v',
            '1',
            '-q:v',
            '3',
            '-f',
            'image2pipe',
            'pipe:1'
          ],
          signal,
          1024 * 1024
        )
      )
    fixedFlowMedia(db, projectId, value)
    samples = {
      images,
      evidence: VideoReviewEvidenceSchema.parse({
        method: 'four-frames-v1',
        contentSha256: value.contentSha256,
        durationMs,
        frames: times.map((timeMs, index) => ({ timeMs, contentSha256: hash(images[index]) }))
      })
    }
  } catch (error) {
    primary =
      error instanceof AgentRuntimeError || error instanceof FlowAssetError ? error : failure()
  } finally {
    // Capture instead of throwing: the sampling phase above must stay diagnosable.
    cleanupFailure = await cleanupReviewDirectory(directory).then(
      undefined,
      (error: unknown) => error
    )
  }
  if (primary) throw primary
  if (cleanupFailure) throw cleanupFailure
  if (!samples) throw failure()
  return samples
}

/** Reviews a bounded full audio track with four visual anchors and an exact full-frame timestamp digest. */
export async function sampleReviewAudioVideo(
  db: Database.Database,
  projectId: string,
  value: FlowAssetValue,
  signal: AbortSignal
): Promise<AudioVideoReviewInput> {
  if (value.kind !== 'video' || value.mime !== 'video/mp4' || !value.contentSha256)
    throw failure('FLOW_VIDEO_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
  const bytes = await reviewBytes(resolve(getDataDir(), value.mediaPath), signal)
  if (hash(bytes) !== value.contentSha256) throw failure('ASSET_VIDEO_CHANGED')
  const directory = await mkdtemp(join(tmpdir(), 'canvas-review-video-'))
  let primary: unknown
  let result: AudioVideoReviewInput | undefined
  let cleanupFailure: unknown
  try {
    const input = join(directory, 'input.mp4')
    await writeFile(input, bytes)
    const { ffmpeg, ffprobe } = mediaTools()
    const probe = await decode(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'mov',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-show_streams',
        '-of',
        'json',
        input
      ],
      signal,
      8192,
      failure,
      'FLOW_MEDIA_REVIEW'
    )
    const format = JSON.parse(probe.toString()) as {
      format?: { duration?: string }
      streams?: Array<{ codec_type?: string }>
    }
    const durationMs = Math.round(Number(format.format?.duration) * 1000)
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 100 ||
      durationMs > 60000 ||
      format.streams?.length !== 2 ||
      format.streams.filter((stream) => stream.codec_type === 'video').length !== 1 ||
      format.streams.filter((stream) => stream.codec_type === 'audio').length !== 1
    )
      throw failure('FLOW_MEDIA_REVIEW_LIMIT')
    const timeline = await decode(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'mov',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        input
      ],
      signal,
      512 * 1024,
      failure,
      'FLOW_MEDIA_REVIEW'
    )
    const entries = (JSON.parse(timeline.toString()) as {
      frames?: Array<{ best_effort_timestamp_time?: string }>
    }).frames
    if (!Array.isArray(entries) || entries.length < 4 || entries.length > 6000)
      throw failure('FLOW_MEDIA_REVIEW_LIMIT')
    const allTimes = entries.map((entry) => Math.round(Number(entry.best_effort_timestamp_time) * 1000))
    if (
      allTimes.some(
        (time, index) =>
          !Number.isFinite(time) ||
          time < 0 ||
          time >= durationMs ||
          (index > 0 && time <= allTimes[index - 1])
      )
    )
      throw failure('FLOW_MEDIA_REVIEW_LIMIT')
    const indices = [0.1, 0.35, 0.6, 0.85].map((fraction) => Math.floor(entries.length * fraction))
    const frameTimes = indices.map((index) => allTimes[index])
    const images: Buffer[] = []
    for (const index of indices)
      images.push(
        await decode(
          ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
            '-f',
            'mov',
            '-i',
            input,
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-vf',
            `select=eq(n\\,${index}),scale=640:640:force_original_aspect_ratio=decrease,format=yuvj420p`,
            '-an',
            '-c:v',
            'mjpeg',
            '-threads:v',
            '1',
            '-q:v',
            '3',
            '-f',
            'image2pipe',
            'pipe:1'
          ],
          signal,
          1024 * 1024,
          failure,
          'FLOW_MEDIA_REVIEW'
        )
      )
    const audio = await audioMetadata(input, signal, ffprobe)
    const audioBytes = await decodeAudioTrack(input, signal, ffmpeg)
    fixedFlowMedia(db, projectId, value)
    const audioEndMs = audio.startMs + audio.durationMs
    const videoStartMs = allTimes[0]
    result = {
      frames: images,
      audioBytes,
      evidence: AudioVideoTimelineEvidenceSchema.parse({
        method: 'audio-video-timeline-v1',
        videoSha256: value.contentSha256,
        videoDurationMs: durationMs,
        videoFrameCount: entries.length,
        frameTimelineSha256: hash(Buffer.from(JSON.stringify(allTimes))),
        videoStartMs,
        audioStartMs: audio.startMs,
        audioDurationMs: audio.durationMs,
        audioEndMs,
        audioOffsetMs: audio.startMs - videoStartMs,
        audioEndDeltaMs: audioEndMs - (videoStartMs + durationMs),
        audioContentSha256: hash(audioBytes),
        audioByteLength: audioBytes.length,
        frames: frameTimes.map((timeMs, index) => ({ timeMs, contentSha256: hash(images[index]) }))
      })
    }
  } catch (error) {
    primary =
      error instanceof AgentRuntimeError || error instanceof FlowAssetError
        ? error
        : failure('FLOW_MEDIA_REVIEW_DECODE_FAILED')
  } finally {
    cleanupFailure = await cleanupReviewDirectory(directory, 'FLOW_MEDIA_REVIEW_CLEANUP_FAILED').then(
      undefined,
      (error: unknown) => error
    )
  }
  if (primary) throw primary
  if (cleanupFailure) throw cleanupFailure
  if (!result) throw failure('FLOW_MEDIA_REVIEW_DECODE_FAILED')
  return result
}

function fixedReviewSubject(
  db: Database.Database,
  projectId: string,
  report: ReviewDecision
): FlowAssetValue {
  if (report.subjects.length !== 1) throw failure('FLOW_MEDIA_REVIEW_NOT_FIXED')
  const ref = report.subjects[0]
  const row = db
    .prepare(
      'SELECT asset_id,node_id,port_id,value_json,digest FROM flow_asset_versions WHERE project_id=? AND version_id=?'
    )
    .get(projectId, ref.versionId) as
    | { asset_id: string; node_id: string; port_id: string; value_json: string; digest: string }
    | undefined
  if (
    !row ||
    row.asset_id !== ref.assetId ||
    row.node_id !== ref.sourceNodeId ||
    row.port_id !== ref.sourcePortId ||
    hash(Buffer.from(row.value_json)) !== row.digest
  )
    throw failure('FLOW_MEDIA_REVIEW_NOT_FIXED')
  return JSON.parse(row.value_json) as FlowAssetValue
}

export function assertImageReviewEvidence(db: Database.Database, projectId: string, report: ReviewDecision): void {
  const evidence = ImageReviewEvidenceSchema.parse(report.imageEvidence)
  const value = fixedReviewSubject(db, projectId, report)
  if (value.kind !== 'image' || value.contentSha256 !== evidence.contentSha256 || value.mime !== evidence.mime)
    throw failure('FLOW_MEDIA_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
}

export function assertAudioReviewEvidence(db: Database.Database, projectId: string, report: ReviewDecision): void {
  const evidence = AudioReviewEvidenceSchema.parse(report.audioEvidence)
  const value = fixedReviewSubject(db, projectId, report)
  if (value.kind !== 'audio' || value.contentSha256 !== evidence.sourceSha256 || value.mime !== evidence.sourceMime)
    throw failure('FLOW_MEDIA_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
}

export function assertAudioVideoReviewEvidence(
  db: Database.Database,
  projectId: string,
  report: ReviewDecision
): void {
  const evidence = AudioVideoTimelineEvidenceSchema.parse(report.audioVideoEvidence)
  const value = fixedReviewSubject(db, projectId, report)
  if (value.kind !== 'video' || value.contentSha256 !== evidence.videoSha256)
    throw failure('FLOW_MEDIA_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
}

/** Approvals and cached reports must still match the original, available video bytes. */
export function assertVideoReviewEvidence(
  db: Database.Database,
  projectId: string,
  report: ReviewDecision
): void {
  const evidence = VideoReviewEvidenceSchema.parse(report.videoEvidence)
  if (report.evidenceScope !== 'sampled' || report.subjects.length !== 1) throw failure()
  const ref = report.subjects[0]
  const row = db
    .prepare(
      'SELECT asset_id,node_id,port_id,value_json,digest FROM flow_asset_versions WHERE project_id=? AND version_id=?'
    )
    .get(projectId, ref.versionId) as
    | { asset_id: string; node_id: string; port_id: string; value_json: string; digest: string }
    | undefined
  if (
    !row ||
    row.asset_id !== ref.assetId ||
    row.node_id !== ref.sourceNodeId ||
    row.port_id !== ref.sourcePortId ||
    hash(Buffer.from(row.value_json)) !== row.digest
  )
    throw failure('FLOW_VIDEO_REVIEW_NOT_FIXED')
  const value = reviewVideoValue(db, projectId, JSON.parse(row.value_json), ref.sourceNodeId)
  if (
    value.kind !== 'video' ||
    value.mime !== 'video/mp4' ||
    value.contentSha256 !== evidence.contentSha256
  )
    throw failure('FLOW_VIDEO_REVIEW_NOT_FIXED')
  fixedFlowMedia(db, projectId, value)
}
