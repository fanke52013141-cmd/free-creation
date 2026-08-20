import { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { CanvasView } from './components/CanvasView'
import { ModelPanel } from './components/ModelPanel'

export default function App() {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [showModelPanel, setShowModelPanel] = useState(false)

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-50">
      <Sidebar
        currentProjectId={currentProjectId}
        onSelectProject={setCurrentProjectId}
        onOpenModels={() => setShowModelPanel(true)}
      />
      <main className="flex-1 flex flex-col min-w-0">
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
    <div className="flex-1 flex items-center justify-center text-neutral-400 select-none">
      <div className="text-center">
        <div className="text-5xl mb-4 opacity-40">◈</div>
        <p className="text-lg font-medium text-neutral-500 mb-1">无限画布</p>
        <p className="text-sm">从左侧选择项目，或新建项目开始创作</p>
      </div>
    </div>
  )
}
