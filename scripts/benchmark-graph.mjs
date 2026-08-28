/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { performance } from 'node:perf_hooks'

function buildGraph(size) {
  const nodes = Array.from({ length: size }, (_, index) => ({ id: `node-${index}` }))
  const edges = []
  for (let index = 1; index < size; index += 1) {
    edges.push({ from: `node-${index - 1}`, to: `node-${index}` })
    if (index > 1 && index % 3 === 0) edges.push({ from: `node-${index - 2}`, to: `node-${index}` })
  }
  return { nodes, edges }
}

function topoSort(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const adjacency = new Map()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    indegree.set(edge.to, indegree.get(edge.to) + 1)
    const next = adjacency.get(edge.from) ?? []
    next.push(edge.to)
    adjacency.set(edge.from, next)
  }
  const queue = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const ordered = []
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    ordered.push(id)
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return ordered.length === graph.nodes.length ? ordered : null
}

const sizes = [100, 500, 1000]
console.log('Canvas Studio P1 graph baseline')
console.log('size\tedges\ttopo ms\tjson ms')
for (const size of sizes) {
  const graph = buildGraph(size)
  const topoStart = performance.now()
  const result = topoSort(graph)
  const topoMs = performance.now() - topoStart
  const jsonStart = performance.now()
  JSON.stringify(graph)
  const jsonMs = performance.now() - jsonStart
  if (!result) throw new Error(`benchmark graph ${size} unexpectedly contains a cycle`)
  console.log(`${size}\t${graph.edges.length}\t${topoMs.toFixed(3)}\t${jsonMs.toFixed(3)}`)
}
