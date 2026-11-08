/**
 * 授权窗隔离 preload（方案 §3.3）。
 *
 * 与业务 preload 完全分离：只暴露 9 个授权通道，无文件系统、无网络、
 * 无业务 API。发送方由主进程 handler 侧二次校验（event.senderFrame）。
 *
 * 注意：授权窗启用 sandbox: true，沙箱 preload 不支持相对 require ——
 * 本文件必须自包含（内联通道常量），channel 名与 shared/contracts 的
 * IPC.license 一致性由 test/license-preload-contracts.test.ts 保证。
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 与 src/shared/contracts/index.ts 的 IPC.license 保持一致（测试强制同步）。 */
const LICENSE_IPC = {
  getStatus: 'license:get-status',
  probeDevice: 'license:probe-device',
  exportRequest: 'license:export-request',
  importChallenge: 'license:import-challenge',
  exportProof: 'license:export-proof',
  importLicense: 'license:import-license',
  importPolicy: 'license:import-policy',
  getDiagnostic: 'license:get-diagnostic',
  exitApp: 'license:exit-app'
} as const

const licenseApi = {
  getStatus: () => ipcRenderer.invoke(LICENSE_IPC.getStatus),
  probeDevice: () => ipcRenderer.invoke(LICENSE_IPC.probeDevice),
  exportRequest: () => ipcRenderer.invoke(LICENSE_IPC.exportRequest),
  importChallenge: () => ipcRenderer.invoke(LICENSE_IPC.importChallenge),
  exportProof: () => ipcRenderer.invoke(LICENSE_IPC.exportProof),
  importLicense: () => ipcRenderer.invoke(LICENSE_IPC.importLicense),
  importPolicy: () => ipcRenderer.invoke(LICENSE_IPC.importPolicy),
  getDiagnostic: () => ipcRenderer.invoke(LICENSE_IPC.getDiagnostic),
  exitApp: () => ipcRenderer.invoke(LICENSE_IPC.exitApp)
}

contextBridge.exposeInMainWorld('licenseApi', licenseApi)

export type LicenseApi = typeof licenseApi
