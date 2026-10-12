// C0 laboratory contracts only; no canvas node is registered by this experiment.
import { z } from 'zod'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
export const C0InputSchema = z.object({ text: z.string().max(16_384) }).strict()
export const C0OutputSchema = z.object({ text: z.string().max(16_384) }).strict()
export const C0CommandSchema = z
  .object({
    commandId: id,
    projectId: id,
    agentNodeId: id,
    taskId: id,
    targetNodeId: id,
    expectedRevision: z.number().int().nonnegative(),
    input: C0InputSchema
  })
  .strict()
export type C0Command = z.infer<typeof C0CommandSchema>
export type C0Output = z.infer<typeof C0OutputSchema>

export interface C0Scope {
  projectId: string
  agentNodeId: string
  taskId: string
  revision: number
  allowedNodeIds: readonly string[]
}

export const C0DecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), targetNodeId: id, input: C0InputSchema }).strict(),
  z.object({ kind: z.literal('wait') }).strict(),
  z.object({ kind: z.literal('finish'), output: C0OutputSchema }).strict()
])
export type C0Decision = z.infer<typeof C0DecisionSchema>
export const C0ResumeSchema = z
  .object({
    taskId: id,
    expectedRevision: z.number().int().nonnegative(),
    accepted: z.boolean()
  })
  .strict()

export class C0Error extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'C0Error'
  }
}

export interface C0ModelInput {
  text: string
  outputs: C0Output[]
  mode: 'autonomous' | 'collaborative'
  humanAccepted: boolean | null
}
export interface C0ModelPort {
  decide(input: C0ModelInput, signal?: AbortSignal): Promise<C0Decision>
}

export interface C0Transport {
  execute(command: C0Command, signal: AbortSignal): Promise<unknown>
}
