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
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const failure = (code = 'FLOW_VIDEO_REVIEW_DECODE_FAILED'): AgentRuntimeError =>
  new AgentRuntimeError(code, 'video-review-samples')

/** Bounded, cancellable local subprocess. Never surface filenames, stderr or decoder text. */
function decode(
  binary: string,
  args: string[],
  signal: AbortSignal,
  limit: number
): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(failure('AGENT_CANCELLED_OR_TIMED_OUT'))
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
    const timer = setTimeout(() => stop('FLOW_VIDEO_REVIEW_DECODE_FAILED'), 10000)
    signal.addEventListener('abort', abort, { once: true })
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) stop('FLOW_VIDEO_REVIEW_LIMIT')
      else chunks.push(chunk)
    })
    child.once('error', () => {
      cleanup()
      reject(failure('FLOW_VIDEO_REVIEW_TOOL_UNAVAILABLE'))
    })
    child.once('close', (status) => {
      cleanup()
      if (code || status !== 0 || !size) reject(failure(code))
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

async function cleanupReviewDirectory(directory: string): Promise<void> {
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-review-video-')
  )
    throw failure('FLOW_VIDEO_REVIEW_CLEANUP_FAILED')
  await rm(directory, { recursive: true, force: true }).catch(() => {
    throw failure('FLOW_VIDEO_REVIEW_CLEANUP_FAILED')
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
