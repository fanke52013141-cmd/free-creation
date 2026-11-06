export interface PromptMediaReference {
  kind: 'image' | 'video'
  title: string
  name?: string
  mediaPath: string
  token: string
}

export function resolvedMentions(
  value: string,
  references: readonly PromptMediaReference[]
): { index: number; text: string; reference: PromptMediaReference }[] {
  const aliases = new Map<string, PromptMediaReference | null>()
  for (const item of references) {
    for (const name of new Set([item.title.trim(), item.name?.trim()])) {
      if (name) aliases.set(name, aliases.has(name) ? null : item)
    }
  }
  const names = [...aliases.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const named = names.length
    ? `|(?:${names.join('|')})(?![\\p{L}\\p{N}_]|[.-][\\p{L}\\p{N}_])`
    : ''
  const pattern = new RegExp(`@(?:(图片|图|视频)[^\\S\\r\\n]*(\\d+)(?!\\d)${named})`, 'gu')
  const images = references.filter((item) => item.kind === 'image')
  const videos = references.filter((item) => item.kind === 'video')
  const result: { index: number; text: string; reference: PromptMediaReference }[] = []
  for (const match of value.matchAll(pattern)) {
    const text = match[0]
    const indexed = match[1] !== undefined
    const indexedReferences = match[1] === '视频' ? videos : images
    const ordinal = Number(match[2])
    const reference = indexed ? indexedReferences[ordinal - 1] : aliases.get(text.slice(1))
    if (reference) result.push({ index: match.index, text, reference })
  }
  return result
}

export function canonicalizeMediaMentions(
  value: string,
  references: readonly PromptMediaReference[]
): string {
  let end = 0
  let output = ''
  for (const { index, text, reference } of resolvedMentions(value, references)) {
    output += value.slice(end, index) + reference.token
    end = index + text.length
  }
  return output + value.slice(end)
}
