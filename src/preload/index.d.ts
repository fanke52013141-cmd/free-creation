import { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from './index'

declare global {
  interface Window {
    // electronAPI 仅在开发构建暴露（见 preload/index.ts），生产构建为 undefined。
    electron?: ElectronAPI
    api: Api
  }
}
