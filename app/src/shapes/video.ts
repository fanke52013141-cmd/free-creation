import { createVideoTask, getVideoTask, type VideoTask } from '../services/gateway'

const activePolls = new Map<string, Promise<VideoTask>>()

export function toNodeRunState(status: VideoTask['status']): 'queued' | 'running' | 'done' | 'error' | 'canceled' {
  if (status === 'pending') return 'queued'
  if (status === 'failed') return 'error'
  return status
}

export function waitForGenerationTask(taskId: string, onUpdate: (task: VideoTask) => void): Promise<VideoTask> {
  const current = activePolls.get(taskId)
  if (current) return current
  const polling = (async () => {
    let task = await getVideoTask(taskId)
    onUpdate(task)
    while (task.status === 'pending' || task.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
      task = await getVideoTask(taskId)
      onUpdate(task)
    }
    return task
  })().finally(() => activePolls.delete(taskId))
  activePolls.set(taskId, polling)
  return polling
}

export async function runVideoGeneration(input: {
  projectId: string; profileId: string; prompts: string[]; referenceUrls: string[]
  resolution: string; duration: number; onUpdate: (task: VideoTask) => void
}): Promise<VideoTask> {
  const task = await createVideoTask(input)
  input.onUpdate(task)
  return waitForGenerationTask(task.id, input.onUpdate)
}
