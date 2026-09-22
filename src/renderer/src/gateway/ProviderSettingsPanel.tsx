// 模型供应商设置面板：配置 BaseURL / API Key / 模型列表（M4 网关）
// 配置存主进程 SQLite（providers 表），渲染端只经 IPC 读写，密钥不落渲染层存储
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { stopEventPropagation } from 'tldraw'
import {
  PROVIDER_SPECS,
  type GatewayModelInfo,
  type ProviderSummary,
  type ProviderSpecId
} from '@shared/types'
import type {
  ProbeProviderInput,
  ProbeProviderResult,
  ProviderProbeItem,
  SaveProviderInput
} from '@shared/contracts'
import { driverForSpec, guessModelModality } from '@shared/provider-driver'
import { useGatewayStore } from '../stores/gateway'
import { useConfirmStore } from '../stores/confirm'
import { toast } from '../stores/toast'
import { Icon } from '../components/Icon'

interface Draft extends Omit<SaveProviderInput, 'apiKey'> {
  apiKey: string
  createdAt?: number
  hasApiKey?: boolean
}

const newDraft = (specId: ProviderSpecId): Draft => {
  const spec = PROVIDER_SPECS.find((s) => s.id === specId)
  return {
    name: spec?.label ?? '未命名供应商',
    specId,
    baseURL: spec?.baseURL ?? '',
    apiKey: '',
    models: normalizeModelsForSpec(
      (spec?.suggestions ?? []).map((id) => ({
        id,
        modality: guessModelModality(id, specId)
      })),
      specId
    )
  }
}

const specLabel = (id: string): string => PROVIDER_SPECS.find((s) => s.id === id)?.label ?? id

/** Product-level compatibility boundary. A model row cannot be classified into a node family
 * that its selected provider adapter cannot execute. */
const modalitiesForSpec = (specId: ProviderSpecId): GatewayModelInfo['modality'][] => {
  if (specId === 'toapis') return ['image']
  // OpenRouter 的 chat/completions 适配器可执行文本，也可保留图片模型；旧版错误地
  // 限制为图片，导致用户已添加的文本模型被改类，聊天和 AI 处理节点始终提示未配置。
  if (specId === 'openrouter') return ['text', 'image']
  if (specId === 'seedance') return ['video']
  if (specId === 'minimax') return ['video', 'audio']
  if (specId === 'doubao-speech') return ['audio']
  return ['text']
}

const normalizeModelsForSpec = (
  models: GatewayModelInfo[],
  specId: ProviderSpecId
): GatewayModelInfo[] => {
  const allowed = modalitiesForSpec(specId)
  return models.map((model) =>
    allowed.includes(model.modality) ? model : { ...model, modality: allowed[0] }
  )
}

const categoryLabel = (modality: GatewayModelInfo['modality'], specId: ProviderSpecId): string => {
  if (modality !== 'audio')
    return modality === 'text' ? '文本' : modality === 'image' ? '图片' : '视频'
  return specId === 'doubao-speech' ? '语音合成' : '音频（合成/设计/克隆）'
}

function draftFromConfig(p: ProviderSummary): Draft {
  return {
    id: p.id,
    name: p.name,
    specId: p.specId,
    baseURL: p.baseURL,
    apiKey: '',
    models: p.models.map((m) => ({ ...m })),
    createdAt: p.createdAt,
    hasApiKey: p.hasApiKey
  }
}

export function ProviderSettingsPanel(): React.JSX.Element | null {
  const open = useGatewayStore((s) => s.settingsOpen)
  const close = useGatewayStore((s) => s.closeSettings)
  const [providers, setProviders] = useState<ProviderSummary[]>([])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [picking, setPicking] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selectedProviderIds, setSelectedProviderIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'test' | 'save' | 'delete' | null>(null)
  const [testMsg, setTestMsg] = useState('')
  const [probe, setProbe] = useState<ProbeProviderResult | null>(null)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [pickedModelIds, setPickedModelIds] = useState<Set<string>>(new Set())
  /** 'free' 表示整表自检，其余为某个计费项正在真实调用。 */
  const [probing, setProbing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const loadSettingsProviders = async (): Promise<void> => {
    const result = await window.api.gateway.listProviders()
    if (result.ok) setProviders(result.data)
  }

  useEffect(() => {
    if (open) void loadSettingsProviders()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 弹层打开时 Esc 只关弹层，不关整个面板
      if (modelPickerOpen) {
        setModelPickerOpen(false)
        return
      }
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, modelPickerOpen])

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
              ? normalizeModelsForSpec(d.models, specId)
              : (spec?.suggestions ?? []).map((id) => ({
                  id,
                  modality: guessModelModality(id, specId)
                }))
          }
        : d
    )
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) return toast('供应商名称不能为空')
    if (!draft.baseURL.trim()) return toast('Base URL 不能为空')
    if (!draft.apiKey.trim() && !draft.hasApiKey) return toast('API Key 不能为空')
    if (!draft.models.length) return toast('至少添加一个模型')
    setBusy('save')
    const res = await window.api.gateway.saveProvider({
      id: draft.id,
      name: draft.name.trim(),
      specId: draft.specId,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim() || undefined,
      models: draft.models
    })
    setBusy(null)
    if (!res.ok) return toast(`保存失败：${res.error.message}`)
    setDraft(draftFromConfig(res.data))
    setProviders((current) => {
      const next = current.filter((provider) => provider.id !== res.data.id)
      return [...next, res.data]
    })
    void loadSettingsProviders()
    void useGatewayStore.getState().load()
    toast('供应商已保存')
  }

  const test = async (): Promise<void> => {
    if (!draft) return
    if (!draft.baseURL.trim() || (!draft.apiKey.trim() && !draft.hasApiKey)) {
      return toast('请先填写 Base URL 与 API Key')
    }
    setBusy('test')
    setTestMsg('')
    const res = await window.api.gateway.testProvider({
      id: draft.id,
      name: draft.name,
      specId: draft.specId,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim() || undefined,
      models: draft.models
    })
    setBusy(null)
    if (!res.ok) {
      setTestMsg(`测试失败：${res.error.message}`)
      return
    }
    // Never add a remote list implicitly: users choose a searchable subset first.
    const known = new Set(draft.models.map((m) => m.id))
    const fresh = res.data.models.filter((id) => !known.has(id))
    setTestMsg(`测试成功：${res.data.message}`)
    if (!fresh.length) return
    setFetchedModels(fresh)
    setPickedModelIds(new Set())
    setModelSearch('')
    setModelPickerOpen(true)
  }

  const addPickedModels = (): void => {
    if (!draft || !pickedModelIds.size) return
    patch({
      models: [
        ...draft.models,
        ...[...pickedModelIds].map((id) => ({ id, modality: modalitiesForSpec(draft.specId)[0] }))
      ]
    })
    setModelPickerOpen(false)
    setPickedModelIds(new Set())
  }

  const probeInput = (runItemId?: string, allowCost?: true): ProbeProviderInput => {
    if (!draft) throw new Error('没有选中的供应商')
    return {
      id: draft.id,
      name: draft.name,
      specId: draft.specId,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim() || undefined,
      models: draft.models,
      runItemId,
      allowCost
    }
  }

  const readyToProbe = (): boolean => {
    if (!draft) return false
    if (!draft.baseURL.trim()) {
      toast('请先填写 Base URL')
      return false
    }
    if (!draft.apiKey.trim() && !draft.hasApiKey) {
      toast('请先填写 API Key')
      return false
    }
    return true
  }

  // 免费自检：构造真实请求体 + 只读探测，不向任何生成端点提交。
  const runProbe = async (): Promise<void> => {
    if (!readyToProbe()) return
    setProbing('free')
    const res = await window.api.gateway.probeProvider(probeInput())
    setProbing(null)
    if (!res.ok) {
      setProbe(null)
      toast(`自检失败：${res.error.message}`)
      return
    }
    setProbe(res.data)
  }

  // 计费自检：必须逐条二次确认，且明确说明取的是该模型的最低消费参数。
  const runPaidProbe = async (item: ProviderProbeItem): Promise<void> => {
    if (!readyToProbe()) return
    if (
      !(await useConfirmStore.getState().confirm({
        title: `真实调用一次：${item.label}`,
        message:
          `这会向服务商真实提交一次请求并产生费用。参数已按最低成本取值：` +
          '视频用该模型允许的最短时长，文本只有一句自检用语；产物不会落盘到本项目。',
        confirmText: '确认计费调用',
        danger: true
      }))
    )
      return
    setProbing(item.id)
    const res = await window.api.gateway.probeProvider(probeInput(item.id, true))
    setProbing(null)
    if (!res.ok) {
      toast(`计费调用失败：${res.error.message}`)
      return
    }
    setProbe(res.data)
  }

  const remove = async (): Promise<void> => {
    if (!draft?.id) return
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除供应商「${draft.name}」`,
        message: '删除后需重新配置才能使用该供应商。',
        confirmText: '删除',
        danger: true
      }))
    )
      return
    setBusy('delete')
    const res = await window.api.gateway.deleteProvider(draft.id)
    setBusy(null)
    if (res.ok) {
      setDraft(null)
      setProviders((current) => current.filter((provider) => provider.id !== draft.id))
      void loadSettingsProviders()
      void useGatewayStore.getState().load()
      toast('供应商已删除')
    }
  }

  const toggleProviderSelection = (providerId: string): void => {
    setSelectedProviderIds((current) => {
      const next = new Set(current)
      if (next.has(providerId)) next.delete(providerId)
      else next.add(providerId)
      return next
    })
  }

  const cancelSelection = (): void => {
    setSelecting(false)
    setSelectedProviderIds(new Set())
  }

  const deleteSelectedProviders = async (): Promise<void> => {
    if (!selectedProviderIds.size) return
    if (
      !(await useConfirmStore.getState().confirm({
        title: `删除 ${selectedProviderIds.size} 个供应商`,
        message: '会同时删除这些供应商的 API Key 与模型配置；删除后需重新配置才能使用。',
        confirmText: '删除所选供应商',
        danger: true
      }))
    )
      return
    setBusy('delete')
    const results = await Promise.all(
      [...selectedProviderIds].map((providerId) => window.api.gateway.deleteProvider(providerId))
    )
    setBusy(null)
    if (results.some((result) => !result.ok || !result.data)) {
      toast('部分供应商删除失败，请重试')
      void loadSettingsProviders()
      return
    }
    setProviders((current) => current.filter((provider) => !selectedProviderIds.has(provider.id)))
    setDraft(null)
    cancelSelection()
    toast(`已删除 ${results.length} 个供应商`)
  }

  return createPortal(
    <div className="gw-mask" onPointerDown={(e) => stopEventPropagation(e)} onClick={close}>
      <div className="gw-panel" onClick={(e) => e.stopPropagation()}>
        <div className="gw-head">
          <span className="gw-title">模型供应商</span>
          <button
            className="icon-btn"
            onClick={close}
            title="关闭 (Esc)"
            aria-label="关闭供应商设置"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="gw-body">
          <div className="gw-side">
            {picking ? (
              <div className="gw-spec-picker gw-side-actions">
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
                <button
                  className="gw-add"
                  onClick={() => {
                    setPicking(false)
                    setDraft(null)
                    setTestMsg('')
                  }}
                >
                  返回
                </button>
              </div>
            ) : !selecting ? (
              <div className="gw-side-toolbar gw-side-actions">
                <button className="gw-add" onClick={() => setPicking(true)}>
                  <Icon name="add" size={14} />
                  新建
                </button>
                <button
                  className="gw-select-toggle"
                  onClick={() => {
                    setSelecting(true)
                    setSelectedProviderIds(new Set())
                    setDraft(null)
                    setTestMsg('')
                  }}
                >
                  多选
                </button>
              </div>
            ) : null}
            <div className="gw-provider-list" aria-label="模型供应商列表">
              {providers.map((p) =>
                selecting ? (
                  <label className="gw-item gw-item-selectable" key={p.id}>
                    <input
                      type="checkbox"
                      checked={selectedProviderIds.has(p.id)}
                      onChange={() => toggleProviderSelection(p.id)}
                    />
                    <span>
                      <span className="gw-item-name">{p.name}</span>
                      <span className="gw-item-sub">
                        {specLabel(p.specId)} · {p.models.length} 模型
                      </span>
                    </span>
                  </label>
                ) : (
                  <button
                    key={p.id}
                    className={`gw-item ${draft?.id === p.id ? 'active' : ''}`}
                    onClick={() => {
                      setDraft(draftFromConfig(p))
                      setPicking(false)
                      setTestMsg('')
                      setProbe(null)
                      setExpanded(null)
                    }}
                  >
                    <span className="gw-item-name">{p.name}</span>
                    <span className="gw-item-sub">
                      {specLabel(p.specId)} · {p.models.length} 模型
                    </span>
                  </button>
                )
              )}
            </div>
            {selecting && (
              <div className="gw-selection-actions">
                <button
                  className="btn-ghost small"
                  disabled={busy !== null}
                  onClick={cancelSelection}
                >
                  取消
                </button>
                <button
                  className="btn-ghost small danger-text"
                  disabled={busy !== null || !selectedProviderIds.size}
                  onClick={() => void deleteSelectedProviders()}
                >
                  {busy === 'delete' ? '删除中…' : '删除'}
                </button>
              </div>
            )}
          </div>
          <div className="gw-main">
            {selecting ? (
              <div className="gw-empty big">
                <p>勾选要管理的供应商</p>
                <p className="dim">删除会同时清除 API Key 与模型配置。</p>
              </div>
            ) : draft ? (
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
                      placeholder={draft.hasApiKey ? '已保存；留空则保持不变' : 'sk-…'}
                      onChange={(e) => patch({ apiKey: e.target.value })}
                    />
                  </label>
                </div>

                <div className="gw-models-head">
                  <span className="gw-label gw-model-count">模型列表 · {draft.models.length}</span>
                  <button
                    className="btn-ghost small"
                    onClick={() =>
                      patch({
                        models: [
                          ...draft.models,
                          { id: '', modality: modalitiesForSpec(draft.specId)[0] }
                        ]
                      })
                    }
                  >
                    <>
                      <Icon name="add" size={14} />
                      添加
                    </>
                  </button>
                </div>
                <div className="gw-model-column-head">
                  <span>模型名称</span>
                  <span>显示名称</span>
                  <span>类别</span>
                </div>
                <div className="gw-models">
                  {draft.models.map((m, i) => (
                    <div className="gw-model-row" key={i}>
                      <input
                        className="gw-input grow"
                        value={m.id}
                        spellCheck={false}
                        aria-label={`模型 ID（第 ${i + 1} 行）`}
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
                        aria-label={`模型显示名（第 ${i + 1} 行）`}
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
                        aria-label={`模型类别（第 ${i + 1} 行）`}
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
                        {modalitiesForSpec(draft.specId).map((modality) => (
                          <option key={modality} value={modality}>
                            {categoryLabel(modality, draft.specId)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="shot-op danger"
                        title="删除模型"
                        aria-label={`删除模型 ${m.id || `第 ${i + 1} 行`}`}
                        onClick={() => patch({ models: draft.models.filter((_, j) => j !== i) })}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ))}
                  {!draft.models.length && (
                    <div className="gw-empty">还没有模型，点击“添加”或使用下方“测试并拉取”</div>
                  )}
                </div>

                {testMsg && <div className="gw-test-msg">{testMsg}</div>}

                {false && driverForSpec(draft!.specId) !== 'openai-compatible' && (
                  <div className="gw-probe">
                    <div className="gw-probe-head">
                      <span className="gw-label">协议自检</span>
                      <button
                        className="btn-ghost small"
                        disabled={probing !== null}
                        onClick={() => void runProbe()}
                      >
                        {probing === 'free' ? '自检中…' : '免费自检（不提交生成）'}
                      </button>
                    </div>
                    <p className="gw-probe-hint">
                      该协议没有模型列表可拉取。自检会用与真实生成完全相同的请求构造器拼出将要发送的
                      地址与字段，并对只读查询端点做一次零计费探测，用来区分「密钥被拒绝」与「端点可达」。
                    </p>
                    {probe && (
                      <>
                        <div
                          className={`gw-probe-summary ${
                            probe!.items.some((item) => item.probe?.status === 'fail')
                              ? 'danger'
                              : ''
                          }`}
                        >
                          {probe!.summary}
                        </div>
                        {probe!.items.map((item) => (
                          <div className="gw-probe-item" key={item.id}>
                            <button
                              className="gw-probe-title"
                              onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                            >
                              <span className={`gw-probe-dot ${item.probe?.status ?? 'idle'}`} />
                              <span className="gw-probe-name">{item.label}</span>
                              <span className="gw-probe-method">{item.method}</span>
                              <span className="gw-probe-tag">
                                {item.cost === 'free' ? '只读' : '计费'}
                              </span>
                            </button>
                            {item.probe && (
                              <div className={`gw-probe-outcome ${item.probe.status}`}>
                                {item.probe.detail}
                              </div>
                            )}
                            {item.missing.map((reason) => (
                              <div className="gw-probe-missing" key={reason}>
                                还缺：{reason}
                              </div>
                            ))}
                            {expanded === item.id && (
                              <>
                                <div className="gw-probe-url">{item.url}</div>
                                {item.body && <pre className="gw-probe-body">{item.body}</pre>}
                              </>
                            )}
                            {item.cost === 'paid' && !item.missing.length && (
                              <button
                                className="btn-ghost small danger-text"
                                disabled={probing !== null}
                                onClick={() => void runPaidProbe(item)}
                              >
                                {probing === item.id ? '调用中…' : '真实调用一次（会计费）'}
                              </button>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                <div className="gw-foot">
                  <button
                    className="btn-ghost"
                    disabled={busy !== null}
                    onClick={() => void test()}
                  >
                    {busy === 'test' ? '测试中…' : '测试并拉取模型'}
                  </button>
                  <div className="gw-foot-right">
                    {!draft.id && (
                      <button
                        className="btn-ghost"
                        disabled={busy !== null}
                        onClick={() => {
                          setDraft(null)
                          setPicking(false)
                          setTestMsg('')
                        }}
                      >
                        取消新增
                      </button>
                    )}
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
                {modelPickerOpen && (
                  <div className="gw-model-picker-mask" role="presentation">
                    <section
                      className="gw-model-picker"
                      role="dialog"
                      aria-modal="true"
                      aria-label="选择要添加的模型"
                    >
                      <div className="gw-models-head">
                        <span className="gw-label">选择要添加的模型</span>
                        <button
                          className="icon-btn"
                          onClick={() => setModelPickerOpen(false)}
                          aria-label="关闭"
                        >
                          ×
                        </button>
                      </div>
                      <input
                        className="gw-input"
                        autoFocus
                        aria-label="搜索模型 ID"
                        value={modelSearch}
                        placeholder="搜索模型 ID"
                        onChange={(e) => setModelSearch(e.target.value)}
                      />
                      <div className="gw-model-picker-list">
                        {fetchedModels
                          .filter((id) =>
                            id.toLowerCase().includes(modelSearch.trim().toLowerCase())
                          )
                          .map((id) => (
                            <label key={id} className="gw-model-picker-item">
                              <input
                                type="checkbox"
                                checked={pickedModelIds.has(id)}
                                onChange={() =>
                                  setPickedModelIds((current) => {
                                    const next = new Set(current)
                                    next.has(id) ? next.delete(id) : next.add(id)
                                    return next
                                  })
                                }
                              />
                              <span>{id}</span>
                            </label>
                          ))}
                      </div>
                      <div className="gw-foot">
                        <button className="btn-ghost" onClick={() => setModelPickerOpen(false)}>
                          取消
                        </button>
                        <button
                          className="btn-primary"
                          disabled={!pickedModelIds.size}
                          onClick={addPickedModels}
                        >
                          添加所选（{pickedModelIds.size}）
                        </button>
                      </div>
                    </section>
                  </div>
                )}
              </>
            ) : (
              <div className="gw-empty big">
                <p>从左侧选择或新增一个供应商</p>
                <p className="dim">
                  文本/图片走 OpenAI 兼容端点（中转站直接填 Base URL）；视频支持 MiniMax H3 与
                  Seedance
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
