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
    models: (spec?.suggestions ?? []).map((id) => ({
      id,
      modality: guessModelModality(id, specId)
    }))
  }
}

const specLabel = (id: string): string => PROVIDER_SPECS.find((s) => s.id === id)?.label ?? id

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
  const providers = useGatewayStore((s) => s.providers)
  const load = useGatewayStore((s) => s.load)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [testMsg, setTestMsg] = useState('')
  const [probe, setProbe] = useState<ProbeProviderResult | null>(null)
  /** 'free' 表示整表自检，其余为某个计费项正在真实调用。 */
  const [probing, setProbing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

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
    await load()
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
    // 合并服务端新发现的模型（已有 id 跳过，模态按 ID 猜测，可手改）
    const known = new Set(draft.models.map((m) => m.id))
    const fresh = res.data.models
      .filter((id) => !known.has(id))
      .map((id) => ({ id, modality: guessModelModality(id, draft.specId) }))
    if (fresh.length) patch({ models: [...draft.models, ...fresh] })
    setTestMsg(
      `测试成功：${res.data.message}${fresh.length ? `，已并入 ${fresh.length} 个新模型` : ''}`
    )
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
            <Icon name="close" size={16} />
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
                  setProbe(null)
                  setExpanded(null)
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
                <Icon name="add" size={14} />
                新增供应商
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
                      placeholder={draft.hasApiKey ? '已保存；留空则保持不变' : 'sk-…'}
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
                          { id: '', modality: guessModelModality('', draft.specId) }
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
                        <option value="audio">音频</option>
                      </select>
                      <button
                        className="shot-op danger"
                        title="删除模型"
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

                {driverForSpec(draft.specId) !== 'openai-compatible' && (
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
                            probe.items.some((item) => item.probe?.status === 'fail')
                              ? 'danger'
                              : ''
                          }`}
                        >
                          {probe.summary}
                        </div>
                        {probe.items.map((item) => (
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
