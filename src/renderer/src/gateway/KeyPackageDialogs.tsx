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
    <DialogShell title="导出设备凭证" onClose={props.onClose}>
      <p className="gw-keys-hint">
        凭证包含本机有效授权与设备公钥，发给发放员后即可接收密钥包。凭证不包含任何 API Key。
      </p>
      {error && <div className="gw-transfer-error">{error}</div>}
      <div className="gw-transfer-actions">
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? '导出中…' : '导出凭证'}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          取消
        </button>
      </div>
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
    <DialogShell title="发放密钥包" onClose={props.onClose}>
      <ol className="gw-keys-steps">
        <li>设置发放密码（20–256 字节，通过独立渠道交给接收者）</li>
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
        <div className="gw-transfer-error">密码长度 {passwordBytes} 字节，需 20–256 字节</div>
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
      <div className="gw-transfer-actions">
        <button type="button" className="btn-primary" onClick={submit} disabled={!canSubmit}>
          {busy ? '发放中…' : `发放所选（${selected.size}）`}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          取消
        </button>
      </div>
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
      <DialogShell title="导入设备密钥包" onClose={props.onClose}>
        <p className="gw-keys-hint">
          发放员用你的设备凭证签发的密钥包。只有本机且密码正确才能解封；文件被别人拿走也导不进去。
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
        <div className="gw-transfer-actions">
          <button type="button" className="btn-primary" onClick={decode} disabled={busy || password.length === 0}>
            {busy ? '解封中…' : '解封并预览'}
          </button>
          <button type="button" className="btn-ghost" onClick={props.onClose}>
            取消
          </button>
        </div>
      </DialogShell>
    )
  }

  const needsOverwriteConfirm = preview.alreadyImported || preview.existingConnections.length > 0

  return (
    <DialogShell title="确认导入密钥包" onClose={props.onClose}>
      <p className="gw-keys-hint">
        包 ID {preview.packageId.slice(0, 8)}… · 发放设备摘要 {preview.issuerDeviceSummary} ·{' '}
        {formatExpiry(preview.expiresAt)} 前有效
      </p>
      <fieldset className="gw-transfer-selection">
        <legend>包内连接（密钥将加密存入本机设备密钥库）</legend>
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
      <div className="gw-transfer-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={apply}
          disabled={busy || (needsOverwriteConfirm && !overwriteConfirmed)}
        >
          {busy ? '导入中…' : '确认导入'}
        </button>
        <button type="button" className="btn-ghost" onClick={props.onClose}>
          取消
        </button>
      </div>
    </DialogShell>
  )
}

// ── 外壳 ──────────────────────────────────────────────────────────

function DialogShell(props: { title: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="gw-transfer-mask" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section role="dialog" aria-modal="true" aria-label={props.title} className="gw-transfer-dialog gw-keys-dialog">
        <h3>{props.title}</h3>
        {props.children}
      </section>
    </div>
  )
}
