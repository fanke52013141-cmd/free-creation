/**
 * P2 密钥包三步流对话框（方案 §4.1）。
 *
 * - credential：导出接收设备凭证——任何已激活设备可用；
 * - export：发放员导出密钥包——仅 credentials.export 能力可见入口；
 *   密码 + 确认 + 连接多选（显示模型数，默认全不选，至少选一项）；
 * - import：导入密钥包——密码解封 → 预览 → 确认落库（覆盖/重导需显式确认）。
 *
 * 明文 Key 永不经过 renderer：预览只显示连接名/端点/模型数。
 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from '../stores/toast'
import { ModalShell } from '../components/ModalShell'
import { modalBtn } from '../components/modal-btn'

export type KeyPackageDialogMode = 'credential' | 'export' | 'import' | null

interface ConnectionPreview {
  id: string
  name: string
  protocol: string
  baseUrl: string
  modelCount: number
  hasKey: boolean
}

interface PackagePreview {
  packageId: string
  expiresAt: number
  issuerDeviceSummary: string
  connections: ConnectionPreview[]
  alreadyImported: boolean
  existingConnections: string[]
}

function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt * 1000).toLocaleString()
}

export function KeyPackageDialogs(props: { mode: KeyPackageDialogMode; onClose: () => void }): React.ReactElement | null {
  const { mode, onClose } = props
  if (!mode) return null
  if (mode === 'credential') return <CredentialDialog onClose={onClose} />
  if (mode === 'export') return <ExportDialog onClose={onClose} />
  return <ImportDialog onClose={onClose} />
}

// ── 导出接收设备凭证 ──────────────────────────────────────────────

function CredentialDialog(props: { onClose: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.gateway.exportReceiveCredential()
      if (result.ok) {
        toast(`接收设备凭证已导出（设备摘要 ${result.data.deviceSummary}）`)
        props.onClose()
      } else if (result.error.code !== 'CANCELLED') {
        setError(`${result.error.code}：${result.error.message}`)
      } else {
        props.onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      title="导出设备凭证"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={modalBtn('secondary')} onClick={props.onClose}>
            取消
          </button>
          <button type="button" className={modalBtn('primary')} onClick={submit} disabled={busy}>
            {busy ? '导出中…' : '导出凭证'}
          </button>
        </>
      }
    >
      <p className="gw-keys-hint">
        这份文件代表你这台电脑的授权身份，发给对方后就能接收密钥包。文件里没有任何 API 密钥，可以放心发送。
      </p>
      {error && <div className="gw-transfer-error">{error}</div>}
    </DialogShell>
  )
}

// ── 发放（导出密钥包）─────────────────────────────────────────────

function ExportDialog(props: { onClose: () => void }): React.ReactElement {
  const [connections, setConnections] = useState<ConnectionPreview[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void (async () => {
      const result = await window.api.gateway.listKeyConnections()
      if (result.ok) {
        setConnections(result.data)
      } else {
        setError(`${result.error.code}：${result.error.message}`)
      }
      setLoaded(true)
    })()
  }, [])

  const usable = useMemo(() => connections.filter((c) => c.hasKey), [connections])
  const passwordBytes = useMemo(() => new TextEncoder().encode(password).length, [password])

  const toggle = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canSubmit =
    !busy && selected.size > 0 && passwordBytes >= 20 && passwordBytes <= 256 && password === passwordConfirm

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.gateway.sealKeyPackage({
        password,
        connectionIds: [...selected]
      })
      if (result.ok) {
        toast(
          `密钥包已导出（${result.data.connectionCount} 个连接，${formatExpiry(result.data.expiresAt)} 前有效）`
        )
        props.onClose()
      } else if (result.error.code !== 'CANCELLED') {
        setError(`${result.error.code}：${result.error.message}`)
      } else {
        props.onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      title="发放密钥包"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={modalBtn('secondary')} onClick={props.onClose}>
            取消
          </button>
          <button type="button" className={modalBtn('primary')} onClick={submit} disabled={!canSubmit}>
            {busy ? '发放中…' : `发放所选（${selected.size}）`}
          </button>
        </>
      }
    >
      <ol className="gw-keys-steps">
        <li>设置发放密码（至少 20 个英文字符或 7 个汉字，请用微信、邮件等其他方式单独发给对方）</li>
        <li>选择接收设备凭证文件（接收方在「导出接收设备凭证」生成）</li>
        <li>勾选要发放的连接（默认全不选），密钥包 7 天内有效</li>
      </ol>
      <label className="gw-transfer-field">
        <span>发放密码</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="至少 20 个字符"
          autoComplete="new-password"
        />
      </label>
      <label className="gw-transfer-field">
        <span>再次输入密码</span>
        <input
          type="password"
          value={passwordConfirm}
          onChange={(event) => setPasswordConfirm(event.target.value)}
          autoComplete="new-password"
        />
      </label>
      {password.length > 0 && (passwordBytes < 20 || passwordBytes > 256) && (
        <div className="gw-transfer-error">密码长度不符：至少需要 20 个英文字符（或 7 个汉字）</div>
      )}
      <fieldset className="gw-transfer-selection">
        <legend>选择要发放的连接（默认全不选）</legend>
        {!loaded && <p className="gw-keys-hint">加载连接列表中…</p>}
        {loaded && usable.length === 0 && <p className="gw-keys-hint">暂无可发放的连接（连接需已保存密钥）</p>}
        {usable.map((connection) => (
          <label key={connection.id} className="gw-transfer-option">
            <input
              type="checkbox"
              checked={selected.has(connection.id)}
              onChange={() => toggle(connection.id)}
            />
            <span>
              {connection.name}
              <span className="gw-keys-meta">
                {' '}
                · {connection.protocol} · {connection.modelCount} 个模型 · {connection.baseUrl}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && <div className="gw-transfer-error">{error}</div>}
    </DialogShell>
  )
}

// ── 导入密钥包 ────────────────────────────────────────────────────

function ImportDialog(props: { onClose: () => void }): React.ReactElement {
  const [password, setPassword] = useState('')
  const [preview, setPreview] = useState<PackagePreview | null>(null)
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const decode = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.gateway.previewKeyPackage({ password })
      if (result.ok) {
        setPreview(result.data)
      } else if (result.error.code !== 'CANCELLED') {
        setError(`${result.error.code}：${result.error.message}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.gateway.importKeyPackage({ password, overwriteConfirmed })
      if (result.ok) {
        toast(
          `密钥包导入完成：新增 ${result.data.added}、更新 ${result.data.updated}、模型 ${result.data.modelCount} 个`
        )
        props.onClose()
      } else {
        setError(`${result.error.code}：${result.error.message}`)
      }
    } finally {
      setBusy(false)
    }
  }

  if (!preview) {
    return (
      <DialogShell
        title="导入设备密钥包"
        onClose={props.onClose}
        footer={
          <>
            <button type="button" className={modalBtn('secondary')} onClick={props.onClose}>
              取消
            </button>
            <button
              type="button"
              className={modalBtn('primary')}
              onClick={decode}
              disabled={busy || password.length === 0}
            >
              {busy ? '正在验证…' : '验证密码并查看内容'}
            </button>
          </>
        }
      >
        <p className="gw-keys-hint">
          这是对方专门发给你这台电脑的密钥包文件。只有在这台电脑上、并且输入正确密码才能打开；就算文件被别人拿到也无法使用。
        </p>
        <label className="gw-transfer-field">
          <span>发放密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
          />
        </label>
        {error && <div className="gw-transfer-error">{error}</div>}
      </DialogShell>
    )
  }

  const needsOverwriteConfirm = preview.alreadyImported || preview.existingConnections.length > 0

  return (
    <DialogShell
      title="确认导入密钥包"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={modalBtn('secondary')} onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className={modalBtn('primary')}
            onClick={apply}
            disabled={busy || (needsOverwriteConfirm && !overwriteConfirmed)}
          >
            {busy ? '导入中…' : '确认导入'}
          </button>
        </>
      }
    >
      <p className="gw-keys-hint">
        来自设备 {preview.issuerDeviceSummary} · {formatExpiry(preview.expiresAt)} 前有效
      </p>
      <fieldset className="gw-transfer-selection">
        <legend>包内连接（导入后密钥会加密保存在这台电脑上）</legend>
        {preview.connections.map((connection) => (
          <div key={connection.id} className="gw-transfer-option">
            <span>
              {connection.name}
              <span className="gw-keys-meta">
                {' '}
                · {connection.protocol} · {connection.modelCount} 个模型 · {connection.baseUrl}
              </span>
            </span>
          </div>
        ))}
      </fieldset>
      {preview.alreadyImported && (
        <div className="gw-transfer-error">该密钥包此前已导入过；重新导入将覆盖以下现有连接。</div>
      )}
      {preview.existingConnections.length > 0 && (
        <div className="gw-transfer-error">以下连接已存在，导入将覆盖其配置与密钥：{preview.existingConnections.join('、')}</div>
      )}
      {needsOverwriteConfirm && (
        <label className="gw-transfer-option">
          <input
            type="checkbox"
            checked={overwriteConfirmed}
            onChange={(event) => setOverwriteConfirmed(event.target.checked)}
          />
          <span>我确认覆盖上述现有连接</span>
        </label>
      )}
      {error && <div className="gw-transfer-error">{error}</div>}
    </DialogShell>
  )
}

// ── 外壳 ──────────────────────────────────────────────────────────

function DialogShell(props: {
  title: string
  onClose: () => void
  footer?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  // 2026-11-21 弹窗统一：三步流共用壳并入 ModalShell（标题保持原名，
  // main 进程侧按标题子串「密钥包/接收设备凭证」匹配的 E2E 依赖不受影响）。
  return (
    <ModalShell
      size="m"
      title={props.title}
      ariaLabel={props.title}
      onClose={props.onClose}
      footer={props.footer}
    >
      {props.children}
    </ModalShell>
  )
}
