import { z } from 'zod'

// F6 对话外部协议：会话与消息的结构编辑经 graph.patch（typed chat.* 操作）承载，
// 发送/重新生成经 node.execute（与 GUI 同一 chatExecutor 路径）。
// 外部调用不能伪造助手回复或运行事实；消息内容是节点 props.text 的权威数据。

export const CHAT_MAX_CONVERSATIONS = 50
export const CHAT_MAX_MESSAGE_CHARS = 100_000
export const CHAT_MAX_ATTACHMENTS = 8

const chatAttachment = z
  .object({
    mediaId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    name: z.string().max(200).optional()
  })
  .strict()

const chatMessageIn = z
  .object({
    role: z.enum(['user']),
    content: z.string().min(1).max(CHAT_MAX_MESSAGE_CHARS),
    /** 显式生图意图：与 GUI 的生图入口同语义（重生成走同一能力）。 */
    intent: z.literal('image').optional(),
    /** 图片附件：mediaId 必须已登记到同一项目，main 预检解析路径/MIME。 */
    images: z.array(chatAttachment).max(CHAT_MAX_ATTACHMENTS).optional()
  })
  .strict()

export const ChatPatchOpSchema = z.discriminatedUnion('action', [
  // 新建会话；title 缺省为「对话 N」。
  z
    .object({
      action: z.literal('chat.session.create'),
      title: z.string().max(120).optional()
    })
    .strict(),
  // 切换活动会话。
  z
    .object({ action: z.literal('chat.session.select'), sessionId: z.string().min(1).max(80) })
    .strict(),
  // 重命名会话。
  z
    .object({
      action: z.literal('chat.session.rename'),
      sessionId: z.string().min(1).max(80),
      title: z.string().min(1).max(120)
    })
    .strict(),
  // 删除会话（活动会话删除后回落到剩余最近会话；空会话集自动重建一个）。
  z
    .object({ action: z.literal('chat.session.delete'), sessionId: z.string().min(1).max(80) })
    .strict(),
  // 在活动会话末尾追加一条用户消息（含可选生图意图与图片附件）。
  z.object({ action: z.literal('chat.message.append'), message: chatMessageIn }).strict(),
  // 编辑活动会话中指定下标的用户消息（仅 user 消息可编辑，与 GUI 规则一致）。
  z
    .object({
      action: z.literal('chat.message.edit'),
      index: z.number().int().min(0).max(999),
      content: z.string().min(1).max(CHAT_MAX_MESSAGE_CHARS)
    })
    .strict(),
  // 截断活动会话：删除 index 及其后全部消息（重新生成的准备步骤，与 GUI 一致）。
  z
    .object({ action: z.literal('chat.message.truncate'), index: z.number().int().min(0).max(999) })
    .strict()
])

export type ChatPatchOp = z.infer<typeof ChatPatchOpSchema>
export const ChatPatchOpsSchema = z.array(ChatPatchOpSchema).min(1).max(50)

/** 对话目录视图：消息正文默认不返回（显式经 chat.messages 读取）。 */
export const chatConversationDto = z
  .object({
    id: z.string().max(80),
    title: z.string().max(120),
    messageCount: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean()
  })
  .strict()
