import './assets/app.css'
import './assets/ui-foundation.css'
import './assets/ui-surfaces.css'
import './assets/scrollbars.css'
import './assets/window-chrome.css'

import { createRoot } from 'react-dom/client'
import App from './App'
import { installBrowserMock } from './dev/browserMock'

if (import.meta.env.DEV) {
  installBrowserMock()
}

// Native Windows controls are overlaid only by the desktop shell.
if (/Electron\//.test(navigator.userAgent) && /Windows/.test(navigator.userAgent)) {
  document.documentElement.classList.add('desktop-window-overlay')
}

// 不用 StrictMode：避免开发模式双挂载导致 tldraw onMount 触发两次
createRoot(document.getElementById('root')!).render(<App />)
