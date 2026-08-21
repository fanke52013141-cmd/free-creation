// 模型供应商设置面板：配置 BaseURL / API Key / 模型列表（M4 网关）
// 配置存主进程 SQLite（providers 表），渲染端只经 IPC 读写，密钥不落渲染层存储
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { stopEventPropagation } from 'tldraw'
import {
  PROVIDER_SPECS,
  type GatewayModelInfo,
  type ProviderConfig,
  type ProviderSpecId
} from '@shared/types'
import type { SaveProviderInput } from '@shared/contracts'
import { useGatewayStore } from '../stores/gateway'
import { toast } from '../stores/toast'

interface Draft extends SaveProviderInput {
  createdAt?: number
}

const newDraft = (specId: ProviderSpecId): Draft => {
  const spec = PROVIDER_SPECS.find((s) => s.id === specId)
  return {
    name: spec?.label ?? '未命名供应商',
    specId,
    baseURL: spec?.baseURL ?? '',
    apiKey: '',
    models: (spec?.suggestions ?? []).map((id) => ({
      id,
      modality: guessModality(id, specId)
    }))
  }
}

// 从模板/服务端带出的模型 ID 猜模态（用户可在面板里改）
function guessModality(id: string, specId: ProviderSpecId): GatewayModelInfo['modality'] {
  if (specId === 'minimax' || specId === 'seedance') return 'video'
  if (/(image|dall|flux|seedream|mj|midjourney|banana)/i.test(id)) return 'image'
  return 'text'
}

const specLabel = (id: string): string =>
  PROVIDER_SPECS.find((s) => s.id === id)?.label ?? id

function draftFromConfig(p: ProviderConfig): Draft {
  return {
    id: p.id,
    name: p.name,
    specId: p.specId,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    models: p.models.map((m) => ({ ...m })),
    createdAt: p.createdAt
  }
}

export function ProviderSettingsPanel(): React.JSX.Element | null {
  const open = useGatewayStore((s) => s.settingsOpen)
  const close = useGatewayStore((s) => s.closeSettings)
  const providers = useGatewayStore((s) => s.providers)
  const load = useGatewayStore((s) => s.load)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [testMsg, setTestMsg] = useState('')

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  const patch = (p: Partial<Draft>): void => setDraft((d) => (d ? { ...d, ...p } : d))

  const changeSpec = (specId: ProviderSpecId): void => {
    const spec = PROVIDER_SPECS.find((s) => s.id === specId)
    setDraft((d) =>
      d
        ? {
            ...d,
            specId,
            baseURL: spec?.baseURL ?? '',
            models: d.models.length
              ? d.models
              : (spec?.suggestions ?? []).map((id) => ({ id, modality: guessModality(id, specId) }))
          }
        : d
    )
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) return toast('供应商名称不能为空')
    if (!draft.baseURL.trim()) return toast('Base URL 不能为空')
    if (!draft.apiKey.trim()) return toast('API Key 不能为空')
    if (!draft.models.length) return toast('至少添加一个模型')
    setBusy('save')
    const res = await window.api.gateway.saveProvider({
      id: draft.id,
      name: draft.name.trim(),
      specId: draft.specId,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim(),
      models: draft.models
    })
    setBusy(null)
    if (!res.ok) return toast(`保存失败：${res.error.message}`)
    setDraft(draftFromConfig(res.data))
    await load()
    toast('供应商已保存')
  }

  const test = async (): Promise<void> => {
    if (!draft) return
    if (!draft.baseURL.trim() || !draft.apiKey.trim()) {
      return toast('请先填写 Base URL 与 API Key')
    }
    setBusy('test')
    setTestMsg('')
    const res = await window.api.gateway.testProvider({
      id: draft.id,
      name: draft.name,
      specId: draft.specId,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim(),
      models: draft.models
    })
    setBusy(null)
    if (!res.ok) {
      setTestMsg(`✕ ${res.error.message}`)
      return
    }
    // 合并服务端新发现的模型（已有 id 跳过，模态按 ID 猜测，可手改）
    const known = new Set(draft.models.map((m) => m.id))
    const fresh = res.data.models
      .filter((id) => !known.has(id))
      .map((id) => ({ id, modality: guessModality(id, draft.specId) }))
    if (fresh.length) patch({ models: [...draft.models, ...fresh] })
    setTestMsg(`✓ ${res.data.message}${fresh.length ? `，已并入 ${fresh.length} 个新模型` : ''}`)
  }

  const remove = async (): Promise<void> => {
    if (!draft?.id) return
    if (!window.confirm(`确定删除供应商「${draft.name}」吗？`)) return
    const res = await window.api.gateway.deleteProvider(draft.id)
    if (res.ok) {
      setDraft(null)
      await load()
      toast('供应商已删除')
    }
  }

  return createPortal(
    <div className="gw-mask" onPointerDown={(e) => stopEventPropagation(e)} onClick={close}>
      <div className="gw-panel" onClick={(e) => e.stopPropagation()}>
        <div className="gw-head">
          <span className="gw-title">模型供应商</span>
          <button className="icon-btn" onClick={close} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="gw-body">
          <div className="gw-side">
            {providers.map((p) => (
              <button
                key={p.id}
                className={`gw-item ${draft?.id === p.id ? 'active' : ''}`}
                onClick={() => {
                  setDraft(draftFromConfig(p))
                  setPicking(false)
                  setTestMsg('')
                }}
              >
                <span className="gw-item-name">{p.name}</span>
                <span className="gw-item-sub">
                  {specLabel(p.specId)} · {p.models.length} 模型
                </span>
              </button>
            ))}
            {picking ? (
              <div className="gw-spec-picker">
                {PROVIDER_SPECS.map((s) => (
                  <button
                    key={s.id}
                    className="gw-spec-btn"
                    title={s.desc}
                    onClick={() => {
                      setDraft(newDraft(s.id))
                      setPicking(false)
                      setTestMsg('')
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : (
              <button className="gw-add" onClick={() => setPicking(true)}>
                ＋ 新增供应商
              </button>
            )}
          </div>
          <div className="gw-main">
            {draft ? (
              <>
                <div className="gw-form">
                  <label className="gw-row">
                    <span className="gw-label">名称</span>
                    <input
                      className="gw-input"
                      value={draft.name}
                      spellCheck={false}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </label>
                  <label className="gw-row">
                    <span className="gw-label">厂商模板</span>
                    <select
                      className="gw-input"
                      value={draft.specId}
                      onChange={(e) => changeSpec(e.target.value as ProviderSpecId)}
                    >
                      {PROVIDER_SPECS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="gw-row">
                    <span className="gw-label">Base URL</span>
                    <input
                      className="gw-input"
                      value={draft.baseURL}
                      spellCheck={false}
                      placeholder="https://…（以 /v1 结尾）"
                      onChange={(e) => patch({ baseURL: e.target.value })}
                    />
                  </label>
                  <label className="gw-row">
                    <span className="gw-label">API Key</span>
                    <input
                      className="gw-input"
                      type="password"
                      value={draft.apiKey}
                      spellCheck={false}
                      placeholder="sk-…"
                      onChange={(e) => patch({ apiKey: e.target.value })}
                    />
                  </label>
                </div>

                <div className="gw-models-head">
                  <span className="gw-label">模型列表（{draft.models.length}）</span>
                  <button
                    className="btn-ghost small"
                    onClick={() =>
                      patch({
                        models: [
                          ...draft.models,
                          { id: '', modality: guessModality('', draft.specId) }
                        ]
                      })
                    }
                  >
                    ＋ 添加
                  </button>
                </div>
                <div className="gw-models">
                  {draft.models.map((m, i) => (
                    <div className="gw-model-row" key={i}>
                      <input
                        className="gw-input grow"
                        value={m.id}
                        spellCheck={false}
                        placeholder="模型 ID（发给 API 的名字）"
                        onChange={(e) =>
                          patch({
                            models: draft.models.map((x, j) =>
                              j === i ? { ...x, id: e.target.value } : x
                            )
                          })
                        }
                      />
                      <input
                        className="gw-input w110"
                        value={m.name ?? ''}
                        spellCheck={false}
                        placeholder="显示名"
                        onChange={(e) =>
                          patch({
                            models: draft.models.map((x, j) =>
                              j === i ? { ...x, name: e.target.value } : x
                            )
                          })
                        }
                      />
                      <select
                        className="gw-input w86"
                        value={m.modality}
                        onChange={(e) =>
                          patch({
                            models: draft.models.map((x, j) =>
                              j === i
                                ? { ...x, modality: e.target.value as GatewayModelInfo['modality'] }
                                : x
                            )
                          })
                        }
                      >
                        <option value="text">文本</option>
                        <option value="image">图片</option>
                        <option value="video">视频</option>
                      </select>
                      <button
                        className="shot-op danger"
                        title="删除模型"
                        onClick={() =>
                          patch({ models: draft.models.filter((_, j) => j !== i) })
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {!draft.models.length && (
                    <div className="gw-empty">还没有模型，点「＋ 添加」或用下方「测试并拉取」</div>
                  )}
                </div>

                {testMsg && <div className="gw-test-msg">{testMsg}</div>}

                <div className="gw-foot">
                  <button className="btn-ghost" disabled={busy !== null} onClick={() => void test()}>
                    {busy === 'test' ? '测试中…' : '测试并拉取模型'}
                  </button>
                  <div className="gw-foot-right">
                    {draft.id && (
                      <button
                        className="btn-ghost danger-text"
                        disabled={busy !== null}
                        onClick={() => void remove()}
                      >
                        删除供应商
                      </button>
                    )}
                    <button
                      className="btn-primary"
                      disabled={busy !== null}
                      onClick={() => void save()}
                    >
                      {busy === 'save' ? '保存中…' : '保存'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="gw-empty big">
                <p>从左侧选择或新增一个供应商</p>
                <p className="dim">
                  文本/图片走 OpenAI 兼容端点（中转站直接填 Base URL）；视频支持 MiniMax H3 与 Seedance
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
