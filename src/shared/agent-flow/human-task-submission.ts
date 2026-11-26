import { canonicalFlowJson } from './semantic-revision'
import { readStoredNodeRunStatus } from '../engine/run-status'
import {
  HumanTaskInstanceSchema,
  HumanTaskNodeConfigSchema,
  HumanTaskPendingSchema,
  type HumanTaskPending
} from './node-contracts'

type SubmissionAdmission =
  | { ok: true; pending: HumanTaskPending; replay: boolean }
  | { ok: false; code: 'INVALID_INPUT' | 'HUMAN_TASK_REVISION_CONFLICT' | 'HUMAN_TASK_SUBMISSION_CONFLICT' }

function parse(raw: unknown): unknown {
  try {
    return typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Synchronous read/validate step for the authoritative renderer, immediately before writing. */
export function admitHumanTaskSubmission(
  shape: { props: { nodeType: string; config: string }; meta?: Record<string, unknown> },
  input: HumanTaskPending
): SubmissionAdmission {
  const submission = HumanTaskPendingSchema.safeParse(input)
  const config = HumanTaskNodeConfigSchema.safeParse(parse(shape.props.config || '{}'))
  if (shape.props.nodeType !== 'human-task' || !submission.success || !config.success ||
      config.data.outputType !== submission.data.value.kind)
    return { ok: false, code: 'INVALID_INPUT' }
  const instance = HumanTaskInstanceSchema.safeParse(parse(shape.meta?.humanTask))
  const revision = instance.success ? instance.data.revision : 1
  if (submission.data.expectedRevision !== revision)
    return { ok: false, code: 'HUMAN_TASK_REVISION_CONFLICT' }
  if (instance.success && instance.data.lastSubmissionId === submission.data.submissionId)
    return { ok: false, code: 'HUMAN_TASK_SUBMISSION_CONFLICT' }

  const current = HumanTaskPendingSchema.safeParse(parse(shape.meta?.humanTaskPending))
  if (current.success && current.data.expectedRevision === revision) {
    if (canonicalFlowJson(current.data.value) === canonicalFlowJson(submission.data.value) &&
        current.data.handoffNote === submission.data.handoffNote)
      return { ok: true, pending: current.data, replay: true }
    // A failed attempt is a settled fact and may be replaced. Running/unknown
    // outcomes remain write-locked so a late retry cannot hide a possible effect.
    if (readStoredNodeRunStatus(shape.meta?.nodeRun) === 'failed')
      return { ok: true, pending: submission.data, replay: false }
    return { ok: false, code: 'HUMAN_TASK_SUBMISSION_CONFLICT' }
  }
  return { ok: true, pending: submission.data, replay: false }
}
