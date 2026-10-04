// T02（F04）：节点搜索的人工别名表。让"裁一下""配音"这类自然说法能命中
// 对应节点；命中走统一创建入口。刻意不用大模型猜意图（审查报告 §3 决策）。
import type { NodeTypeId } from '@shared/types'

/** 每个节点可挂多条别名；匹配按包含关系（小写化后 includes），不要求全等。 */
export const nodeCreateAliases: ReadonlyArray<{ type: NodeTypeId; aliases: string[] }> = [
  { type: 'image-crop', aliases: ['裁剪', '裁一下', '裁切', '截图'] },
  { type: 'image-split', aliases: ['拆分', '切图', '九宫格'] },
  { type: 'image-gen', aliases: ['生成图片', '文生图', '画图'] },
  { type: 'image-edit', aliases: ['修改图片', 'p图', 'P图', '改图'] },
  { type: 'speech', aliases: ['配音', '合成语音', '朗读'] },
  { type: 'tts', aliases: ['克隆音色', '音色克隆', '复刻声音'] },
  { type: 'voice-design', aliases: ['设计音色', '音色设计'] },
  { type: 'video-clip', aliases: ['截取视频', '视频截取', '剪视频'] },
  { type: 'video-frame', aliases: ['抽帧', '取帧'] },
  { type: 'iterate', aliases: ['批量', '循环生成', '逐个处理'] },
  { type: 'json', aliases: ['结构化', '格式化 JSON'] },
  { type: 'processor', aliases: ['取字段', '数据处理'] }
]

/** query 是否命中某节点的别名（小写包含匹配）。 */
export function aliasMatches(query: string, type: NodeTypeId): boolean {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return false
  const entry = nodeCreateAliases.find((a) => a.type === type)
  return entry
    ? entry.aliases.some(
        (alias) => alias.toLocaleLowerCase().includes(q) || q.includes(alias.toLocaleLowerCase())
      )
    : false
}
