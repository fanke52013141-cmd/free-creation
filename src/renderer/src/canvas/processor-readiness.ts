import type { Editor } from 'tldraw'
import {
  parseProcessor,
  processorInputIssue,
  resolveProcessorInput
} from '@shared/engine/executors/processor'
import type { NodeCardShape } from './NodeCardShape'
import { readConnectedNodeInputs } from './graph'
import { readNodeConfig } from './node-persistence'

export function processorConfigurationIssue(editor: Editor, shape: NodeCardShape): string | null {
  const data = parseProcessor(readNodeConfig(shape))
  const connected = readConnectedNodeInputs(editor, shape.id).find(
    (entry) => entry.targetPortId === 'in-value'
  )
  return processorInputIssue(data, resolveProcessorInput(data, connected?.value ?? null))
}
