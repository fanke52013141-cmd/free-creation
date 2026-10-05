import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireNodeResource,
  hasNodeTask,
  setResourceLimit,
  useResourceQueue
} from '@renderer/engine/resource-queue'

const releases: Array<() => void> = []
const acquire = (
  nodeId: string,
  resource = 'provider',
  cancel = () => {}
): ReturnType<typeof acquireNodeResource> =>
  acquireNodeResource({ projectId: 'queue-test', nodeId, label: nodeId, resource, cancel })

afterEach(() => {
  for (const task of useResourceQueue.getState().tasks) if (task.status === 'queued') task.cancel()
  for (const release of releases.splice(0)) release()
  setResourceLimit('provider', 2)
})

describe('resource queue', () => {
  it('different nodes run up to quota; duplicate node is rejected even while queued', async () => {
    setResourceLimit('provider', 1)
    const first = await acquire('a')!
    releases.push(first!)
    const second = acquire('b')!
    expect(hasNodeTask('queue-test', 'b')).toBe(true)
    expect(acquire('b')).toBeNull()
    expect(useResourceQueue.getState().tasks.map((task) => task.status)).toEqual([
      'running',
      'queued'
    ])
    first!()
    const next = await second
    releases.push(next!)
    expect(useResourceQueue.getState().tasks.map((task) => task.status)).toEqual(['running'])
  })

  it('queued cancellation never executes and running cancellation retains quota until terminal', async () => {
    setResourceLimit('provider', 1)
    let cancelled = 0
    const first = await acquire('a', 'provider', () => cancelled++)!
    releases.push(first!)
    const waiting = acquire('b')!
    useResourceQueue
      .getState()
      .tasks.find((task) => task.label === 'b')!
      .cancel()
    expect(await waiting).toBeNull()
    useResourceQueue.getState().tasks[0].cancel()
    expect(cancelled).toBe(1)
    expect(hasNodeTask('queue-test', 'a')).toBe(true)
    const next = acquire('c')!
    expect(useResourceQueue.getState().tasks[1].status).toBe('queued')
    first!()
    releases.push((await next)!)
  })

  it('GPU saturation does not block model tasks; changing quota drains queue', async () => {
    releases.push((await acquire('gpu', 'gpu'))!)
    const gpuWaiting = acquire('gpu-next', 'gpu')!
    releases.push((await acquire('image'))!)
    expect(useResourceQueue.getState().tasks.find((task) => task.label === 'image')!.status).toBe(
      'running'
    )
    setResourceLimit('gpu', 2)
    releases.push((await gpuWaiting)!)
    setResourceLimit('gpu', 1)
    expect(
      useResourceQueue.getState().tasks.filter((task) => task.resource === 'gpu')
    ).toHaveLength(2)
  })
})
