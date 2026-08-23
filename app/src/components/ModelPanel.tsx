import { useState } from 'react'
import { useAppData, store } from '../store'
import { MODEL_TYPE_LABELS } from '../types'
import { getGatewayModels } from '../services/gateway'

export function ModelPanel({ onClose }: { onClose: () => void }) {
  const data = useAppData()
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'error'>('idle')
  const [syncError, setSyncError] = useState('')

  const sync = async () => {
    setSyncState('syncing')
    setSyncError('')
    try {
      store.replaceModels(await getGatewayModels())
      setSyncState('idle')
    } catch (error) {
      setSyncState('error')
      setSyncError(error instanceof Error ? error.message : String(error))
    }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-sm" onClick={onClose}>
    <div className="flex max-h-[80vh] w-[520px] flex-col rounded-2xl border border-slate-600/50 bg-[#121a2a] shadow-2xl shadow-black/50" onClick={(event) => event.stopPropagation()}>
      <header className="flex items-center justify-between border-b border-slate-700/70 px-5 py-4">
        <div><h2 className="font-semibold text-slate-100">本地模型</h2><p className="mt-0.5 text-xs text-slate-400">配置来自本机后端，应用启动时自动读取</p></div>
        <button onClick={onClose} className="text-xl leading-none text-slate-500 hover:text-white">×</button>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {data.models.length ? <ul className="space-y-2">{data.models.map((model) => <li key={model.id} className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/45 px-3 py-2.5">
          <span className="rounded-md bg-violet-500/15 px-2 py-0.5 text-xs text-violet-200">{MODEL_TYPE_LABELS[model.type]}</span>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-100">{model.name}</p><p className="truncate text-xs text-slate-400">{model.provider} · {model.modelId}</p></div>
          <span className="h-2 w-2 rounded-full bg-emerald-500" title="已从本地服务读取" />
        </li>)}</ul> : <p className="py-10 text-center text-sm text-neutral-400">本地后端没有可用模型</p>}
        {syncError && <p className="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-300">{syncError}</p>}
      </div>
      <footer className="flex justify-end border-t border-slate-700/70 px-5 py-3">
        <button onClick={() => void sync()} disabled={syncState === 'syncing'} className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 disabled:text-slate-600">{syncState === 'syncing' ? '刷新中…' : '刷新状态'}</button>
      </footer>
    </div>
  </div>
}
