import type { PortDecl } from '../types'
export function exclusiveInputErrors(
  ports: PortDecl[],
  counts: ReadonlyMap<string, number>
): string[] {
  const groups = new Map<string, PortDecl[]>()
  for (const port of ports) {
    if (!port.exclusiveGroup) continue
    groups.set(port.exclusiveGroup, [...(groups.get(port.exclusiveGroup) ?? []), port])
  }
  return [...groups.values()]
    .filter((group) => group.reduce((sum, port) => sum + (counts.get(port.id) ?? 0), 0) !== 1)
    .map((group) => `请恰好连接一种输入：${group.map((port) => port.name).join(' / ')}`)
}
