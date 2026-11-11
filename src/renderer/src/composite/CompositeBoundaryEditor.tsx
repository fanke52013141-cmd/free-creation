import type { CompositeInput, CompositeManifest, CompositeOutput } from '@shared/composite/manifest'

interface Props {
  manifest: CompositeManifest
  disabled?: boolean
  onChange: (manifest: CompositeManifest) => void
}

function targetValue(target: { nodeId: string; portId: string }): string {
  return `${target.nodeId}:${target.portId}`
}

function parseTarget(value: string): { nodeId: string; portId: string } | null {
  const [nodeId, portId] = value.split(':')
  return nodeId && portId ? { nodeId, portId } : null
}

export function CompositeBoundaryEditor({ manifest, disabled, onChange }: Props): React.JSX.Element {
  const inputTargets = manifest.graph.nodes.flatMap((node) =>
    (node.ports ?? [])
      .filter((port) => port.dir === 'in')
      .map((port) => ({ nodeId: node.id, portId: port.id, label: `${node.title} · ${port.name}`, type: port.type }))
  )
  const outputSources = manifest.graph.nodes.flatMap((node) =>
    (node.ports ?? [])
      .filter((port) => port.dir === 'out')
      .map((port) => ({ nodeId: node.id, portId: port.id, label: `${node.title} · ${port.name}`, type: port.type }))
  )
  const usedTargets = new Set(manifest.inputs.flatMap((input) => input.targets.map(targetValue)))
  const usedSources = new Set(manifest.outputs.map((output) => targetValue(output.source)))

  const updateInput = (index: number, patch: Partial<CompositeInput>): void => {
    onChange({
      ...manifest,
      inputs: manifest.inputs.map((input, current) => (current === index ? { ...input, ...patch } : input))
    })
  }
  const updateOutput = (index: number, patch: Partial<CompositeOutput>): void => {
    onChange({
      ...manifest,
      outputs: manifest.outputs.map((output, current) => (current === index ? { ...output, ...patch } : output))
    })
  }
  const addInput = (): void => {
    const available = inputTargets.find((item) => !usedTargets.has(targetValue(item)))
    if (!available) return
    onChange({
      ...manifest,
      inputs: [
        ...manifest.inputs,
        {
          id: `input-${manifest.inputs.length + 1}`,
          label: available.label,
          type: available.type as CompositeInput['type'],
          required: true,
          cardinality: 'one',
          targets: [{ nodeId: available.nodeId, portId: available.portId }]
        }
      ]
    })
  }
  const addOutput = (): void => {
    const available = outputSources.find((item) => !usedSources.has(targetValue(item)))
    if (!available) return
    onChange({
      ...manifest,
      outputs: [
        ...manifest.outputs,
        {
          id: `output-${manifest.outputs.length + 1}`,
          label: available.label,
          type: available.type as CompositeOutput['type'],
          required: true,
          cardinality: 'one',
          source: { nodeId: available.nodeId, portId: available.portId }
        }
      ]
    })
  }

  return (
    <div className="composite-boundary">
      <section className="composite-boundary-section">
        <header>
          <strong>公开输入</strong>
          <button type="button" className="btn-ghost small" disabled={disabled} onClick={addInput}>
            添加输入
          </button>
        </header>
        {manifest.inputs.length === 0 && <p className="composite-boundary-empty">暂无公开输入</p>}
        {manifest.inputs.map((input, index) => (
          <div className="composite-boundary-row composite-boundary-input" key={input.id}>
            <input
              aria-label={`输入 ${index + 1} 名称`}
              value={input.label}
              disabled={disabled}
              onChange={(event) => updateInput(index, { label: event.target.value })}
            />
            <span className="composite-boundary-type">{input.type}</span>
            <label className="composite-boundary-check">
              <input
                type="checkbox"
                checked={input.required}
                disabled={disabled}
                onChange={(event) => updateInput(index, { required: event.target.checked })}
              />
              必填
            </label>
            <select
              aria-label={`输入 ${index + 1} 映射`}
              value={input.targets[0] ? targetValue(input.targets[0]) : ''}
              disabled={disabled}
              onChange={(event) => {
                const target = parseTarget(event.target.value)
                if (!target) return
                const source = inputTargets.find((item) => targetValue(item) === event.target.value)
                updateInput(index, {
                  targets: [target],
                  ...(source ? { type: source.type as CompositeInput['type'] } : {})
                })
              }}
            >
              {inputTargets.map((item) => {
                const value = targetValue(item)
                const usedByOther = manifest.inputs.some(
                  (candidate, current) => current !== index && candidate.targets.some((target) => targetValue(target) === value)
                )
                return (
                  <option key={value} value={value} disabled={usedByOther}>
                    {item.label}
                  </option>
                )
              })}
            </select>
            <input
              aria-label={`输入 ${index + 1} 默认值`}
              placeholder="默认值（可选）"
              value={typeof input.defaultValue === 'string' ? input.defaultValue : ''}
              disabled={disabled}
              onChange={(event) =>
                updateInput(index, {
                  defaultValue: event.target.value ? event.target.value : undefined
                })
              }
            />
            <button
              type="button"
              className="btn-ghost small"
              disabled={disabled}
              onClick={() => onChange({ ...manifest, inputs: manifest.inputs.filter((_, current) => current !== index) })}
            >
              删除
            </button>
          </div>
        ))}
      </section>

      <section className="composite-boundary-section">
        <header>
          <strong>公开输出</strong>
          <button type="button" className="btn-ghost small" disabled={disabled} onClick={addOutput}>
            添加输出
          </button>
        </header>
        {manifest.outputs.length === 0 && <p className="composite-boundary-empty">至少保留一个业务输出</p>}
        {manifest.outputs.map((output, index) => (
          <div className="composite-boundary-row" key={output.id}>
            <input
              aria-label={`输出 ${index + 1} 名称`}
              value={output.label}
              disabled={disabled}
              onChange={(event) => updateOutput(index, { label: event.target.value })}
            />
            <span className="composite-boundary-type">{output.type}</span>
            <label className="composite-boundary-check">
              <input
                type="checkbox"
                checked={output.required}
                disabled={disabled}
                onChange={(event) => updateOutput(index, { required: event.target.checked })}
              />
              必填
            </label>
            <select
              aria-label={`输出 ${index + 1} 来源`}
              value={targetValue(output.source)}
              disabled={disabled}
              onChange={(event) => {
                const target = parseTarget(event.target.value)
                if (!target) return
                const source = outputSources.find((item) => targetValue(item) === event.target.value)
                updateOutput(index, {
                  source: target,
                  ...(source ? { type: source.type as CompositeOutput['type'] } : {})
                })
              }}
            >
              {outputSources.map((item) => {
                const value = targetValue(item)
                const usedByOther = manifest.outputs.some(
                  (candidate, current) => current !== index && targetValue(candidate.source) === value
                )
                return (
                  <option key={value} value={value} disabled={usedByOther}>
                    {item.label}
                  </option>
                )
              })}
            </select>
            <button
              type="button"
              className="btn-ghost small"
              disabled={disabled}
              onClick={() => onChange({ ...manifest, outputs: manifest.outputs.filter((_, current) => current !== index) })}
            >
              删除
            </button>
          </div>
        ))}
      </section>
    </div>
  )
}
