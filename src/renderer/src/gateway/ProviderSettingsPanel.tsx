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
import { isDreaminaModelSupported } from '@shared/dreamina-models'
import { useGatewayStore } from '../stores/gateway'
import { useConfirmStore } from '../stores/confirm'
import { toast } from '../stores/toast'
import { Icon } from '../components/Icon'
import { AppSelect } from '../components/AppSelect'

interface Draft extends Omit<SaveProviderInput, 'apiKey'> {
  apiKey: string
  createdAt?: number
  hasApiKey?: boolean
}

// Keep the paid protocol probe hidden until the complete provider support matrix is verified.
const isProviderProtocolProbeEnabled = (): boolean => false

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
  // 即梦一个实例同时提供图片模型（5.0 / 5.0Pro / 4.x）与视频模型（seedance*）。
  if (specId === 'dreamina') return ['image', 'video']
  if (specId === 'volc-speech') return ['audio']
  return ['text']
}

const normalizeModelsForSpec = (
  models: GatewayModelInfo[],
  specId: ProviderSpecId
): GatewayModelInfo[] => {
  const allowed = modalitiesForSpec(specId)
  // 即梦只保留白名单内的型号：切换规格或加载历史配置时直接剔除已禁用项。
  const scoped =
    specId === 'dreamina'
      ? models.filter((model) => isDreaminaModelSupported(model.id))
      : models
  return scoped.map((model) =>
    allowed.includes(model.modality) ? model : { ...model, modality: allowed[0] }
  )
}

const categoryLabel = (modality: GatewayModelInfo['modality'], specId: ProviderSpecId): string => {
  if (modality !== 'audio')
    return modality === 'text' ? '文本' : modality === 'image' ? '图片' : '视频'
  return specId === 'volc-speech' ? '语音合成' : '音频（合成/设计/克隆）'
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
  const openCatalog = useGatewayStore((s) => s.openCatalog)
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
  const [transferMode, setTransferMode] = useState<'import' | 'export' | null>(null)
  const [transferPassword, setTransferPassword] = useState('')
  const [transferPasswordConfirm, setTransferPasswordConfirm] = useState('')
  const [transferError, setTransferError] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  /** 即梦本机 CLI 的设备流登录：pending 时持有授权材料并轮询 checklogin。 */
  const [dreaminaLogin, setDreaminaLogin] = useState<{
    verificationUri?: string
    userCode?: string
    deviceCode: string
    expiresAt?: string
  } | null>(null)
  const [dreaminaLoginBusy, setDreaminaLoginBusy] = useState(false)
  const [dreaminaLoginMsg, setDreaminaLoginMsg] = useState('')

  const loadSettingsProviders = async (): Promise<void> => {
    const result = await window.api.gateway.listProviders()
    if (result.ok) setProviders(result.data)
  }

  useEffect(() => {
    if (!open) return
    let active = true
    void window.api.gateway.listProviders().then((result) => {
      if (active && result.ok) setProviders(result.data)
    })
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (transferMode) {
        setTransferMode(null)
        setTransferPassword('')
        setTransferPasswordConfirm('')
        setTransferError('')
        return
      }
      // 弹层打开时 Esc 只关弹层，不关整个面板
      if (modelPickerOpen) {
        setModelPickerOpen(false)
        return
      }
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, modelPickerOpen, transferMode])

  // 授权在浏览器里完成，面板按固定节奏查询；过期或失败即停止，避免无限轮询。
  useEffect(() => {
    const deviceCode = dreaminaLogin?.deviceCode
    if (!deviceCode) return
    let stopped = false
    const timer = window.setInterval(() => {
      void (async () => {
        const res = await window.api.gateway.dreaminaLoginCheck(deviceCode)
        if (stopped) return
        if (!res.ok) {
          setDreaminaLoginMsg(`检查登录失败：${res.error.message}`)
          return
        }
        if (res.data.status === 'success') {
          window.clearInterval(timer)
          setDreaminaLogin(null)
          setDreaminaLoginMsg('即梦登录成功，点「检测本机 CLI」刷新状态')
          toast('即梦登录成功')
          return
        }
        if (res.data.status === 'expired' || res.data.status === 'failed') {
          window.clearInterval(timer)
          setDreaminaLogin(null)
          setDreaminaLoginMsg(res.data.message)
          return
        }
        setDreaminaLoginMsg(res.data.message)
      })()
    }, 2500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [dreaminaLogin])

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
    // 本机 CLI 通道（即梦）没有 Base URL / API Key，凭据是机器上的登录态。
    const localCli = driverForSpec(draft.specId) === 'local-cli'
    if (!localCli && !draft.baseURL.trim()) return toast('Base URL 不能为空')
    if (!localCli && !draft.apiKey.trim() && !draft.hasApiKey) return toast('API Key 不能为空')
    if (!draft.models.length) return toast('至少添加一个模型')
    // 即梦只允许白名单模型：保存时清掉已禁用的历史行，避免"能选但一跑就卡/失败"。
    const modelsForSave =
      draft.specId === 'dreamina'
        ? draft.models.filter((model) => isDreaminaModelSupported(model.id))
        : draft.models
    if (!modelsForSave.length)
      return toast('即梦只支持 5.0 / 5.0Pro 与 2.5 / 2.0_vip / 2.0fast_vip / 2.0mini')
    const droppedModels = draft.models.length - modelsForSave.length
    setBusy('save')
    const res = await window.api.gateway.saveProvider({
      id: draft.id,
      name: draft.name.trim(),
      specId: draft.specId,
      baseURL: draft.baseURL.trim(),
      apiKey: draft.apiKey.trim() || undefined,
      models: modelsForSave
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
    toast(droppedModels > 0 ? `供应商已保存，已移除 ${droppedModels} 个不可用模型` : '供应商已保存')
  }

  const test = async (): Promise<void> => {
    if (!draft) return
    const localCli = driverForSpec(draft.specId) === 'local-cli'
    if (!localCli && (!draft.baseURL.trim() || (!draft.apiKey.trim() && !draft.hasApiKey))) {
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

  /**
   * 一键登录：主进程发起设备流并把浏览器打开，这里只负责展示材料与轮询结果。
   * 登录态由 CLI 自己持久化，应用不接触任何 token。
   */
  const startDreaminaLogin = async (): Promise<void> => {
    setDreaminaLoginBusy(true)
    setDreaminaLoginMsg('')
    const res = await window.api.gateway.dreaminaLoginStart()
    setDreaminaLoginBusy(false)
    if (!res.ok) {
      setDreaminaLoginMsg(`发起登录失败：${res.error.message}`)
      return
    }
    if (res.data.status === 'already') {
      setDreaminaLogin(null)
      setDreaminaLoginMsg(`${res.data.message}，无需重复授权`)
      toast('本机已有有效登录态')
      return
    }
    if (res.data.status !== 'pending' || !res.data.deviceCode) {
      setDreaminaLogin(null)
      setDreaminaLoginMsg(res.data.message)
      return
    }
    setDreaminaLogin({
      ...(res.data.verificationUri ? { verificationUri: res.data.verificationUri } : {}),
      ...(res.data.userCode ? { userCode: res.data.userCode } : {}),
      ...(res.data.expiresAt ? { expiresAt: res.data.expiresAt } : {}),
      deviceCode: res.data.deviceCode
    })
    setDreaminaLoginMsg('已打开浏览器，请在页面中完成授权（本面板会自动检测结果）')
  }

  const copyDreaminaLink = (value: string): void => {
    if (!navigator.clipboard) {
      toast('当前环境不支持剪贴板，请手动复制')
      return
    }
    void navigator.clipboard.writeText(value).then(
      () => toast('已复制'),
      () => toast('复制失败，请手动选择文本')
    )
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

  const beginProviderTransfer = (mode: 'import' | 'export'): void => {
    setTransferMode(mode)
    setTransferPassword('')
    setTransferPasswordConfirm('')
    setTransferError('')
  }

  const finishProviderTransfer = (): void => {
    setTransferMode(null)
    setTransferPassword('')
    setTransferPasswordConfirm('')
    setTransferError('')
  }

  const submitProviderTransfer = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!transferMode) return
    if (transferPassword.length < 8) {
      setTransferError('密码至少需要 8 个字符')
      return
    }
    if (transferMode === 'export' && transferPassword !== transferPasswordConfirm) {
      setTransferError('两次输入的密码不一致')
      return
    }
    setTransferBusy(true)
    setTransferError('')
    try {
      if (transferMode === 'export') {
        const result = await window.api.gateway.exportProviders({ password: transferPassword })
        if (!result.ok) {
          if (result.error.code === 'CANCELLED') return finishProviderTransfer()
          setTransferError(result.error.message)
          return
        }
        finishProviderTransfer()
        toast(`已加密导出 ${result.data.count} 个供应商`)
      } else {
        const result = await window.api.gateway.importProviders({ password: transferPassword })
        if (!result.ok) {
          if (result.error.code === 'CANCELLED') return finishProviderTransfer()
          setTransferError(result.error.message)
          return
        }
        finishProviderTransfer()
        await loadSettingsProviders()
        void useGatewayStore.getState().load()
        toast(`已导入 ${result.data.count} 个供应商（新增 ${result.data.added}，更新 ${result.data.updated}）`)
      }
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : String(error))
    } finally {
      setTransferBusy(false)
    }
  }

  return createPortal(
    <div
      className="gw-mask"
      onPointerDown={(event) => stopEventPropagation(event)}
      onClick={(event) => {
        stopEventPropagation(event)
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="gw-panel" onClick={(e) => e.stopPropagation()}>
        <div className="gw-head">
          <span className="gw-title">模型供应商</span>
          <div className="gw-head-actions">
            <button className="btn-ghost small" onClick={openCatalog}>
              模型管理与验证
            </button>
            <button className="icon-btn" onClick={close} aria-label="关闭供应商设置">
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
        <div className="gw-body">
          <div className="gw-side">
            {picking ? (
              <div className="gw-spec-picker gw-side-actions">
                {PROVIDER_SPECS.map((s) => (
                  <button
                    key={s.id}
                    className="gw-spec-btn"
                    aria-label={s.desc}
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
            {!picking && (
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
            )}
            {!picking && !selecting && (
              <div className="gw-provider-transfer-actions">
                <button className="btn-ghost small" onClick={() => beginProviderTransfer('import')}>
                  导入
                </button>
                <button className="btn-ghost small" onClick={() => beginProviderTransfer('export')}>
                  导出
                </button>
              </div>
            )}
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
                    <AppSelect
                      className="gw-input"
                      value={draft.specId}
                      onChange={(e) => changeSpec(e.target.value as ProviderSpecId)}
                    >
                      {PROVIDER_SPECS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </AppSelect>
                  </label>
                  {driverForSpec(draft.specId) === 'local-cli' ? (
                    <>
                      <div className="gw-row">
                        <span className="gw-label">本机通道</span>
                        <span className="gw-empty">
                          即梦 CLI 不需要 Base URL 与 API Key，直接使用本机登录态
                        </span>
                      </div>
                      <div className="gw-row">
                        <span className="gw-label">登录</span>
                        <button
                          className="btn-ghost small"
                          disabled={dreaminaLoginBusy}
                          onClick={() => void startDreaminaLogin()}
                        >
                          {dreaminaLoginBusy ? '发起中…' : '登录即梦'}
                        </button>
                      </div>
                      {dreaminaLogin && (
                        <div className="gw-empty">
                          已打开浏览器；若未自动跳转请手动打开
                          {dreaminaLogin.verificationUri ? (
                            <>
                              {' '}
                              <code>{dreaminaLogin.verificationUri}</code>{' '}
                              <button
                                className="btn-ghost small"
                                onClick={() => copyDreaminaLink(dreaminaLogin.verificationUri!)}
                              >
                                复制链接
                              </button>
                            </>
                          ) : null}
                          {dreaminaLogin.userCode ? (
                            <>
                              {' '}
                              并输入设备码 <code>{dreaminaLogin.userCode}</code>
                            </>
                          ) : null}
                        </div>
                      )}
                      {dreaminaLoginMsg && <div className="gw-empty">{dreaminaLoginMsg}</div>}
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
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
                      <AppSelect
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
                      </AppSelect>
                      <button
                        className="shot-op danger"
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

                {isProviderProtocolProbeEnabled() && driverForSpec(draft!.specId) !== 'openai-compatible' && (
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
                    {busy === 'test'
                      ? '测试中…'
                      : driverForSpec(draft.specId) === 'local-cli'
                        ? '检测本机 CLI'
                        : '测试并拉取模型'}
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
                  <div
                    className="gw-model-picker-mask"
                    role="presentation"
                    onPointerDown={(event) => stopEventPropagation(event)}
                    onClick={(event) => {
                      stopEventPropagation(event)
                      if (event.target === event.currentTarget) setModelPickerOpen(false)
                    }}
                  >
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
        {transferMode && (
          <div className="gw-transfer-mask">
            <section
              className="gw-transfer-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="gw-transfer-title"
            >
              <h2 id="gw-transfer-title">
                {transferMode === 'export' ? '导出供应商配置' : '导入供应商配置'}
              </h2>
              <p>
                {transferMode === 'export'
                  ? '配置文件包含 API Key，会用此密码加密。请在另一台设备上使用同一密码导入。'
                  : '选择加密配置文件并输入导出时设置的密码。已有同 ID 的供应商将更新，其余配置保留。'}
              </p>
              <form onSubmit={(event) => void submitProviderTransfer(event)}>
                <label className="gw-transfer-field">
                  <span>{transferMode === 'export' ? '设置加密密码' : '文件密码'}</span>
                  <input
                    className="gw-input"
                    type="password"
                    autoFocus
                    autoComplete="new-password"
                    minLength={8}
                    value={transferPassword}
                    onChange={(event) => setTransferPassword(event.target.value)}
                    placeholder="至少 8 个字符"
                  />
                </label>
                {transferMode === 'export' && (
                  <label className="gw-transfer-field">
                    <span>再次输入密码</span>
                    <input
                      className="gw-input"
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      value={transferPasswordConfirm}
                      onChange={(event) => setTransferPasswordConfirm(event.target.value)}
                      placeholder="确认加密密码"
                    />
                  </label>
                )}
                {transferError && <div className="gw-transfer-error" role="alert">{transferError}</div>}
                <div className="gw-transfer-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={transferBusy}
                    onClick={finishProviderTransfer}
                  >
                    取消
                  </button>
                  <button type="submit" className="btn-primary" disabled={transferBusy}>
                    {transferBusy
                      ? transferMode === 'export' ? '加密中…' : '导入中…'
                      : transferMode === 'export' ? '加密导出' : '选择文件并导入'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
