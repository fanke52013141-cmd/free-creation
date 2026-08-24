import { useEffect, useState } from 'react'
import { useAppStore } from './stores/app'
import { ProjectListPage } from './pages/ProjectListPage'
import { CanvasPage } from './pages/CanvasPage'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ProviderSettingsPanel } from './gateway/ProviderSettingsPanel'

function Content(): React.JSX.Element {
  const view = useAppStore((s) => s.view)
  const currentProject = useAppStore((s) => s.currentProject)
  const openProject = useAppStore((s) => s.openProject)
  const [booted, setBooted] = useState(false)

  // 启动恢复：上次打开的项目直接进画布（M0 出口标准）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.api.bootstrap()
      if (cancelled) return
      if (res.ok && res.data.lastProjectId) {
        const openRes = await window.api.openProject(res.data.lastProjectId)
        if (openRes.ok && openRes.data) {
          openProject(openRes.data.meta)
        }
      }
      setBooted(true)
    })()
    return () => {
      cancelled = true
    }
  }, [openProject])

  if (!booted) {
    return <div className="boot-screen">加载中…</div>
  }

  if (view === 'canvas' && currentProject) {
    return <CanvasPage projectId={currentProject.id} />
  }
  return <ProjectListPage />
}

export default function App(): React.JSX.Element {
  return (
    <>
      <Content />
      <Toast />
      <ConfirmDialog />
      <ProviderSettingsPanel />
    </>
  )
}
