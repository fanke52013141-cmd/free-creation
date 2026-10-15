import { z } from 'zod'
import { AgentFlowAssetRefSchema } from './node-contracts'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
export const AssetSubmitSchema = z
  .object({
    projectId: id,
    nodeId: id,
    portId: id,
    submissionId: id,
    expectedGraphVersion: z.number().int().nonnegative(),
    traceId: id,
    spanId: id
  })
  .strict()
export type AssetSubmit = z.infer<typeof AssetSubmitSchema>
export const AssetQuerySchema = z.object({ projectId: id, nodeId: id, portId: id }).strict()
export const AssetReadSchema = z.object({ projectId: id, versionId: id }).strict()
export type FlowAssetValue =
  | { kind: 'text' | 'markdown'; text: string }
  | { kind: 'json'; data: unknown }
  | { kind: 'image'; mediaId: string; mediaPath: string; mime: string; contentSha256: string }
  | { kind: 'video'; mediaId: string; mediaPath: string; mime: string; contentSha256?: string }
export interface FlowAssetVersion {
  ref: z.infer<typeof AgentFlowAssetRefSchema>
  projectId: string
  ordinal: number
  graphVersion: number
  createdAt: number
  digest: string
  value: FlowAssetValue
}
export type FlowAssetSummary = Omit<FlowAssetVersion, 'value'>
export class FlowAssetError extends Error {
  constructor(
    public readonly code: string,
    public readonly phase?: string
  ) {
    super(code)
  }
}
