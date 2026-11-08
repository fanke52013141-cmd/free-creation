/**
 * 授权窗页面逻辑：只通过隔离 preload 的 licenseApi 与主进程通信。
 * 不引入 React / tldraw / 业务模块，保持攻击面最小。
 */
import './license.css'

interface LicenseSnapshotView {
  state: string
  reasonCode: string | null
  message: string
  deviceSummary: string | null
  term: 'days' | 'permanent' | null
  expiresAt: number | null
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface LicenseWindowApi {
  getStatus(): Promise<Envelope<LicenseSnapshotView>>
  probeDevice(): Promise<Envelope<{ available: boolean; detail: string; keySource: string }>>
  exportRequest(): Promise<Envelope<{ saved: boolean; deviceSummary: string | null; requestId: string | null }>>
  importChallenge(): Promise<Envelope<{ imported: boolean; deviceSummary: string | null }>>
  exportProof(): Promise<Envelope<{ saved: boolean; deviceSummary: string | null }>>
  importLicense(): Promise<Envelope<{ imported: boolean; snapshot: LicenseSnapshotView | null }>>
  importPolicy(): Promise<Envelope<{ imported: boolean; applied?: boolean; sequence?: number }>>
  getDiagnostic(): Promise<Envelope<Record<string, unknown>>>
  exitApp(): Promise<Envelope<{ quitting: boolean }>>
}

declare global {
  interface Window {
    licenseApi: LicenseWindowApi
  }
}

const stateEl = document.getElementById('state') as HTMLSpanElement
const reasonEl = document.getElementById('reason') as HTMLSpanElement
const deviceSummaryEl = document.getElementById('device-summary') as HTMLSpanElement
const termEl = document.getElementById('term') as HTMLSpanElement
const diagnosticEl = document.getElementById('diagnostic') as HTMLPreElement
const exportProofButton = document.getElementById('btn-export-proof') as HTMLButtonElement

function setText(el: HTMLElement, text: string): void {
  el.textContent = text
}

function stateBadge(state: string): string {
  switch (state) {
    case 'active':
      return '已激活'
    case 'locked':
      return '已锁定'
    case 'checking':
      return '检查中'
    default:
      return '未授权'
  }
}

function termText(snapshot: LicenseSnapshotView): string {
  if (snapshot.state !== 'active' || snapshot.term === null) return '—'
  if (snapshot.term === 'permanent') return '永久有效'
  if (snapshot.expiresAt !== null) {
    return `按天授权，至 ${new Date(snapshot.expiresAt * 1000).toLocaleString()}`
  }
  return '按天授权'
}

async function refreshStatus(): Promise<void> {
  const result = await window.licenseApi.getStatus()
  if (!result.ok) {
    setText(stateEl, '服务异常')
    setText(reasonEl, result.error.code)
    return
  }
  const snapshot = result.data
  setText(stateEl, stateBadge(snapshot.state))
  stateEl.dataset.state = snapshot.state
  setText(reasonEl, snapshot.reasonCode ?? '—')
  setText(deviceSummaryEl, snapshot.deviceSummary ?? '—')
  setText(termEl, termText(snapshot))
}

function formatResult(action: string, result: Envelope<unknown>): string {
  if (result.ok) return `${action}完成`
  return `${action}失败：${result.error.code}（${result.error.message}）`
}

function wire(buttonId: string, action: string, task: () => Promise<Envelope<unknown>>): void {
  const button = document.getElementById(buttonId) as HTMLButtonElement | null
  button?.addEventListener('click', async () => {
    button.disabled = true
    try {
      const result = await task()
      showDiagnostic(formatResult(action, result))
    } finally {
      button.disabled = button === exportProofButton && !exportProofButton.dataset.ready
      await refreshStatus()
    }
  })
}

function showDiagnostic(text: string): void {
  diagnosticEl.hidden = false
  const previous = diagnosticEl.textContent ?? ''
  diagnosticEl.textContent = `${new Date().toLocaleTimeString()} ${text}\n${previous}`.slice(0, 4000)
}

wire('btn-export-request', '导出申请', () => window.licenseApi.exportRequest())
wire('btn-import-challenge', '导入挑战', async () => {
  const result = await window.licenseApi.importChallenge()
  if (result.ok && result.data.imported) {
    exportProofButton.disabled = false
    exportProofButton.dataset.ready = '1'
  }
  return result
})
wire('btn-export-proof', '导出证明', () => window.licenseApi.exportProof())
wire('btn-import-license', '导入授权', () => window.licenseApi.importLicense())
wire('btn-import-policy', '导入策略', () => window.licenseApi.importPolicy())

document.getElementById('btn-diagnostic')?.addEventListener('click', async () => {
  const result = await window.licenseApi.getDiagnostic()
  showDiagnostic(result.ok ? JSON.stringify(result.data, null, 2) : formatResult('诊断', result))
})

document.getElementById('btn-exit')?.addEventListener('click', async () => {
  await window.licenseApi.exitApp()
})

async function bootstrap(): Promise<void> {
  await refreshStatus()
  const probe = await window.licenseApi.probeDevice()
  if (probe.ok) {
    showDiagnostic(`设备探测：${probe.data.detail}`)
  }
}

void bootstrap()
