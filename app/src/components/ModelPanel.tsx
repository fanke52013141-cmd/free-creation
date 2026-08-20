import { useState, type ReactNode } from 'react'
import { useAppData, store } from '../store'
import { MODEL_TYPE_LABELS, type ModelConfig, type ModelType } from '../types'

interface Props {
  onClose: () => void
}

export function ModelPanel({ onClose }: Props) {
  const data = useAppData()
  const [editing, setEditing] = useState<ModelConfig | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-200">
          <h2 className="font-semibold text-neutral-800">Model 配置</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {creating || editing ? (
            <ModelForm
              model={editing}
              onCancel={() => {
                setCreating(false)
                setEditing(null)
              }}
              onSave={() => {
                setCreating(false)
                setEditing(null)
              }}
            />
          ) : (
            <>
              {data.models.length === 0 ? (
                <p className="text-sm text-neutral-400 text-center py-8">
                  还没有配置模型，点击下方按钮添加第一个
                </p>
              ) : (
                <ul className="space-y-2 mb-4">
                  {data.models.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center gap-3 px-3 py-2 rounded border border-neutral-200 hover:border-neutral-300"
                    >
                      <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-500">
                        {MODEL_TYPE_LABELS[m.type]}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-neutral-800 truncate">{m.name}</p>
                        <p className="text-xs text-neutral-400 truncate">{m.modelId || '未填模型 ID'}</p>
                      </div>
                      {m.isDefault && (
                        <span className="text-xs text-blue-500">默认</span>
                      )}
                      <button
                        onClick={() => setEditing(m)}
                        className="text-xs text-neutral-400 hover:text-neutral-700 px-2 py-1"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`删除模型「${m.name}」？`)) store.deleteModel(m.id)
                        }}
                        className="text-xs text-red-400 hover:text-red-600 px-2 py-1"
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                onClick={() => setCreating(true)}
                className="w-full py-2 text-sm text-blue-600 border border-dashed border-blue-300 rounded hover:bg-blue-50"
              >
                + 添加模型
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ModelForm({
  model,
  onSave,
  onCancel,
}: {
  model: ModelConfig | null
  onSave: () => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<Partial<ModelConfig>>(
    model ?? { name: '', provider: 'openai', type: 'chat', baseUrl: '', apiKey: '', modelId: '' }
  )
  const set = (patch: Partial<ModelConfig>) => setForm((f) => ({ ...f, ...patch }))

  const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-neutral-300 rounded focus:outline-none focus:border-blue-400'

  return (
    <div className="space-y-3">
      <Field label="名称">
        <input className={inputCls} value={form.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="如：默认对话模型" />
      </Field>
      <Field label="类型">
        <select className={inputCls} value={form.type} onChange={(e) => set({ type: e.target.value as ModelType })}>
          {Object.entries(MODEL_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </Field>
      <Field label="Provider">
        <input className={inputCls} value={form.provider || ''} onChange={(e) => set({ provider: e.target.value })} placeholder="openai / 中转站 等" />
      </Field>
      <Field label="Base URL">
        <input className={inputCls} value={form.baseUrl || ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
      </Field>
      <Field label="模型 ID">
        <input className={inputCls} value={form.modelId || ''} onChange={(e) => set({ modelId: e.target.value })} placeholder="gpt-4o / Image-2 / ..." />
      </Field>
      <Field label="API Key">
        <input className={inputCls} type="password" value={form.apiKey || ''} onChange={(e) => set({ apiKey: e.target.value })} placeholder="sk-..." />
      </Field>
      <div className="flex gap-4">
        <Field label="温度">
          <input className={inputCls} type="number" step="0.1" value={form.temperature ?? ''} onChange={(e) => set({ temperature: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
        <Field label="最大输出长度">
          <input className={inputCls} type="number" value={form.maxTokens ?? ''} onChange={(e) => set({ maxTokens: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-neutral-600">
        <input type="checkbox" checked={form.isDefault ?? false} onChange={(e) => set({ isDefault: e.target.checked })} />
        设为默认模型
      </label>

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 rounded">
          取消
        </button>
        <button
          onClick={() => {
            if (model) store.updateModel(model.id, form)
            else store.createModel(form)
            onSave()
          }}
          className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded"
        >
          保存
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-neutral-500 mb-1">{label}</label>
      {children}
    </div>
  )
}
