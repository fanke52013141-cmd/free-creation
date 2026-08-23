import { getNodeDefinition } from './nodeDefinitions'

/** Visual counterparts of the canonical ports; their positions match data-edge anchors. */
export function NodePortMarkers({ type }: { type: string }) {
  const definition = getNodeDefinition(type)
  if (!definition) return null
  const portPosition = (index: number, total: number) => `${((index + 1) / (total + 1)) * 100}%`
  return (
    <>
      {definition.inputs.length > 0 && (
        <div className="node-port-rail node-port-rail-input" aria-hidden="true">
          {definition.inputs.map((port, index) => <span key={port.name} className="node-port-marker" style={{ top: portPosition(index, definition.inputs.length) }} title={`${port.name} 输入`} />)}
        </div>
      )}
      {definition.outputs.length > 0 && (
        <div className="node-port-rail node-port-rail-output" aria-hidden="true">
          {definition.outputs.map((port, index) => <span key={port.name} className="node-port-marker" style={{ top: portPosition(index, definition.outputs.length) }} title={`${port.name} 输出`} />)}
        </div>
      )}
    </>
  )
}
