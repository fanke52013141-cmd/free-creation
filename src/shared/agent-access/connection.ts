import { z } from 'zod'

export const ConnectionDescriptorSchema = z
  .object({
    apiVersion: z.literal(1),
    instanceId: z.string().uuid(),
    dataStoreId: z.string().uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    endpoint: z.string().min(1).max(250),
    appVersion: z.string().max(80),
    pid: z.number().int().positive()
  })
  .strict()
export type ConnectionDescriptor = z.infer<typeof ConnectionDescriptorSchema>
