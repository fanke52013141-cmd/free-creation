import { z } from 'zod'

export const ACCESS_DESKTOP_REQUEST = 'local-agent:desktop-request'
export const ACCESS_DESKTOP_REPLY = 'local-agent:desktop-reply'
export const ACCESS_DESKTOP_COMMIT = 'local-agent:desktop-commit'
export const DesktopRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    action: z.enum(['open', 'flush', 'rename']),
    name: z.string().trim().min(1).max(200).optional()
  })
  .strict()
export type DesktopRequest = z.infer<typeof DesktopRequestSchema>
export const DesktopReplySchema = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string(),
    ok: z.boolean(),
    graphVersion: z.number().int().nonnegative().optional()
  })
  .strict()
export const DesktopCommitSchema = z
  .object({
    requestId: z.string().uuid(),
    projectId: z.string(),
    graphVersion: z.number().int().nonnegative()
  })
  .strict()
