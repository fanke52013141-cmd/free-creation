// Slash 快捷指令：/九宫格、/25宫格、/三视图 —— 一键批量生成多视角图片节点
// 在文本节点中输入指令+主题，检测后点击生成即可在画布上创建对应的宫格图片节点
export interface SlashCommand {
  pattern: string
  label: string
  icon: 'target' | 'workflow' | 'grid'
  count: number
  cols: number
  desc: string
  /** 根据主题生成 N 条视角各异的提示词 */
  prompts: (subject: string) => string[]
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    pattern: '/三视图',
    label: '三视图',
    icon: 'target',
    count: 3,
    cols: 3,
    desc: '正面 / 侧面 / 背面 三视角',
    prompts: (s) => [
      `${s}，正面视图，character sheet，正面全身照，清晰五官`,
      `${s}，侧面视图，character sheet，纯侧面全身照，轮廓清晰`,
      `${s}，背面视图，character sheet，背面全身照，展现后脑和背部细节`
    ]
  },
  {
    pattern: '/九宫格',
    label: '九宫格',
    icon: 'workflow',
    count: 9,
    cols: 3,
    desc: '9 种视角组合（正面/侧面/背面 × 平视/俯视/仰视）',
    prompts: (s) => {
      const angles = ['正面', '侧面', '背面']
      const views = ['平视', '俯视', '仰视']
      const result: string[] = []
      for (const angle of angles) {
        for (const view of views) {
          result.push(`${s}，${angle}${view}视角，全身照，高清细节`)
        }
      }
      return result
    }
  },
  {
    pattern: '/25宫格',
    label: '25宫格',
    icon: 'grid',
    count: 25,
    cols: 5,
    desc: '25 种视角 × 光照 × 表情组合',
    prompts: (s) => {
      const angles = ['正面', '左侧', '右侧', '背面', '斜45度']
      const moods = ['自然光', '暖色调', '冷色调', '逆光剪影', '梦幻光影']
      const result: string[] = []
      for (const angle of angles) {
        for (const mood of moods) {
          result.push(`${s}，${angle}视角，${mood}，全身照，高清`)
        }
      }
      return result
    }
  }
]

export interface ParsedSlashCommand {
  command: SlashCommand
  subject: string
}

/** 解析文本内容，检测是否以 slash 指令开头 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  // 匹配 /指令 + 空格 + 主题
  const match = trimmed.match(/^(\/[^\s]+)\s+(.+)/)
  if (!match) {
    // 只有指令没有主题：也匹配（主题为空字符串，UI 提示输入主题）
    for (const cmd of SLASH_COMMANDS) {
      if (trimmed === cmd.pattern) {
        return { command: cmd, subject: '' }
      }
    }
    return null
  }
  const [, pattern, subject] = match
  for (const cmd of SLASH_COMMANDS) {
    if (pattern === cmd.pattern) {
      return { command: cmd, subject: subject.trim() }
    }
  }
  return null
}

/** 从 slash 指令生成图片提示词数组 */
export function generateSlashPrompts(cmd: SlashCommand, subject: string): string[] {
  return cmd.prompts(subject.trim() || '一个角色')
}
