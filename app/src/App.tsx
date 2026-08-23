import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { CanvasView } from './components/CanvasView'
import { ModelPanel } from './components/ModelPanel'
import { BrandMark } from './components/BrandMark'
import { getGatewayModels } from './services/gateway'
import { store } from './store'

export default function App() {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [showModelPanel, setShowModelPanel] = useState(false)

  useEffect(() => {
    void getGatewayModels().then((models) => store.replaceModels(models)).catch(() => undefined)
  }, [])

  return (
    <div className="app-shell">
      <Sidebar
        currentProjectId={currentProjectId}
        onSelectProject={setCurrentProjectId}
        onOpenModels={() => setShowModelPanel(true)}
      />
      <main className="app-main">
        {currentProjectId ? (
          <CanvasView
            projectId={currentProjectId}
            onBack={() => setCurrentProjectId(null)}
          />
        ) : (
          <EmptyState />
        )}
      </main>
      {showModelPanel && <ModelPanel onClose={() => setShowModelPanel(false)} />}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty-state select-none">
      <div className="empty-state-card">
        <BrandMark />
        <div className="empty-orbit" />
        <p className="empty-title">把想法接成可执行的创作流</p>
        <p className="empty-copy">从左侧建立项目，再把文本、图片与生成节点放到画布。</p>
        <img src="/brand/flow-line.svg" alt="数据流" className="empty-flow" />
      </div>
    </div>
  )
}
