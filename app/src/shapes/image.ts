import { createImageTask, type GenerationTask } from '../services/gateway'
import { waitForGenerationTask } from './video'

export async function runImageGeneration(input: {
  projectId: string; profileId: string; prompts: string[]; referenceUrls: string[]
  size: string; quality: string; onUpdate: (task: GenerationTask) => void
}): Promise<GenerationTask> {
  const task = await createImageTask(input)
  input.onUpdate(task)
  return waitForGenerationTask(task.id, input.onUpdate)
}
