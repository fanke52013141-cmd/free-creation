import { useEffect, useState } from 'react'
import type { ModelOperation } from '@free-creation/model-contracts'
import { AppSelect } from '../components/AppSelect'

export function FeatureProfileSelect({ value, operation, fallback, onChange }: { value?: string; operation: ModelOperation; fallback: string; onChange: (featureKey: string) => void }): React.JSX.Element {
  const [keys, setKeys] = useState<string[]>([])
  useEffect(() => { void window.api.models.listBindings().then((result) => { if (result.ok) setKeys(result.data.filter((item) => item.target.operation === operation).map((item) => item.featureKey)) }) }, [operation])
  const selected = value || fallback
  return <AppSelect className="gen-select" value={selected} onChange={(event) => onChange(event.target.value)} title="仅列出已验证并已绑定的模型档案">
    {!keys.includes(selected) && <option value={selected}>{selected}（未验证或未绑定）</option>}
    {keys.map((key) => <option key={key} value={key}>{key}</option>)}
  </AppSelect>
}
