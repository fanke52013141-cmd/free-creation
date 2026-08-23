import { useState, type Dispatch, type SetStateAction, type ReactNode } from 'react'
import { useAppData, store, setDragItem, getDragItem } from '../store'
import type { Chapter, Project } from '../types'
import { BrandMark } from './BrandMark'

interface SidebarProps {
  currentProjectId: string | null
  onSelectProject: (id: string) => void
  onOpenModels: () => void
  mobileOpen: boolean
  onMobileClose: () => void
}

export function Sidebar({ currentProjectId, onSelectProject, onOpenModels, mobileOpen, onMobileClose }: SidebarProps) {
  const data = useAppData()
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const courses = [...data.courses].sort((a, b) => a.sortOrder - b.sortOrder)
  const standaloneProjects = [...data.projects]
    .filter((p) => p.courseId === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const clearDrop = () => {
    setDragOver(null)
    setDragItem(null)
  }
  const createAndOpenProject = (placement: { courseId: string | null; chapterId: string | null }) => {
    const project = store.createProject(placement)
    onSelectProject(project.id)
  }

  return (
    <aside className={`project-sidebar ${mobileOpen ? 'is-mobile-open' : ''}`}>
      {/* 标题 */}
      <div className="brand-bar">
        <BrandMark />
        <button aria-label="关闭项目栏" className="mobile-sidebar-close" onClick={onMobileClose}>×</button>
      </div>

      {/* 新建课程 */}
      <div className="sidebar-action-wrap">
        <button
          onClick={() => store.createCourse()}
          className="sidebar-primary-action"
        >
          <span>＋</span> 新建创作集
        </button>
      </div>

      {/* 树 */}
      <div className="sidebar-tree">
        {/* 独立项目区（drop zone：项目拖到此变独立）*/}
        <div
          onDragOver={(e) => {
            if (getDragItem()?.kind === 'project') {
              e.preventDefault()
              setDragOver('__standalone__')
            }
          }}
          onDragLeave={() => setDragOver((v) => (v === '__standalone__' ? null : v))}
          onDrop={() => {
            const item = getDragItem()
            if (item?.kind === 'project') store.moveProject(item.id, null, null)
            clearDrop()
          }}
          className={`mb-2 ${dragOver === '__standalone__' ? 'bg-blue-50 ring-1 ring-blue-300 mx-1 rounded' : ''}`}
        >
          {standaloneProjects.length > 0 && (
            <div className="px-3">
              <p className="sidebar-section-label">独立项目</p>
              {standaloneProjects.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={p.id === currentProjectId}
                  onSelect={onSelectProject}
                />
              ))}
            </div>
          )}
        </div>

        {/* 课程列表 */}
        {courses.map((course) => {
          const chapters = data.chapters
            .filter((c) => c.courseId === course.id)
            .sort((a, b) => a.sortOrder - b.sortOrder)
          const unchaptered = data.projects.filter(
            (p) => p.courseId === course.id && p.chapterId === null
          )
          const isCollapsed = collapsed.has(course.id)
          const isOver = dragOver === course.id

          return (
            <div key={course.id} className="select-none">
              {/* 课程行（drop zone：项目拖到课程→未归类区；章节拖到课程→移动章节）*/}
              <div
                draggable
                onDragStart={() => setDragItem({ kind: 'course', id: course.id })}
                onDragEnd={clearDrop}
                onDragOver={(e) => {
                  // 只接受章节和项目的拖入（课程拖入此处不处理，避免误判）
                  const item = getDragItem()
                  if (item && (item.kind === 'chapter' || item.kind === 'project')) {
                    e.preventDefault()
                    setDragOver(course.id)
                  }
                }}
                onDragLeave={() => setDragOver((v) => (v === course.id ? null : v))}
                onDrop={() => {
                  const item = getDragItem()
                  if (item?.kind === 'chapter' && item.id !== course.id) {
                    store.moveChapter(item.id, course.id)
                  } else if (item?.kind === 'project') {
                    store.moveProject(item.id, course.id, null)
                  }
                  clearDrop()
                }}
                className={`group sidebar-course-row ${
                  isOver ? 'is-drop-target' : ''
                }`}
                style={{ borderLeft: `3px solid ${course.coverColor}` }}
              >
                <button
                  onClick={() => toggle(course.id)}
                  className="text-neutral-400 w-4 text-[10px] flex-none"
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
                <EditableLabel
                  text={course.name}
                  className="flex-1 truncate text-neutral-700 font-medium"
                  onRename={(name) => store.updateCourse(course.id, { name })}
                />
                <span className="hidden group-hover:flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                  <IconBtn title="新建章节" onClick={() => store.createChapter(course.id)}>
                    ＋章节
                  </IconBtn>
                  <IconBtn
                    title="新建项目"
                    onClick={() => createAndOpenProject({ courseId: course.id, chapterId: null })}
                  >
                    ＋项目
                  </IconBtn>
                  <IconBtn
                    title="删除课程"
                    danger
                    onClick={() => {
                      if (
                        confirm(
                          `删除课程「${course.name}」？其下章节会删除，项目会变为独立项目（不会被删除）。`
                        )
                      )
                        store.deleteCourse(course.id)
                    }}
                  >
                    ×
                  </IconBtn>
                </span>
              </div>

              {/* 子项 */}
              {!isCollapsed && (
                <div className="ml-4">
                  {chapters.map((ch) => {
                    const chProjects = data.projects
                      .filter((p) => p.chapterId === ch.id)
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    return (
                      <ChapterBlock
                        key={ch.id}
                        chapter={ch}
                        projects={chProjects}
                        currentProjectId={currentProjectId}
                        onSelectProject={onSelectProject}
                        onCreateProject={createAndOpenProject}
                        dragOver={dragOver}
                        setDragOver={setDragOver}
                      />
                    )
                  })}
                  {unchaptered.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      active={p.id === currentProjectId}
                      onSelect={onSelectProject}
                    />
                  ))}
                  {chapters.length === 0 && unchaptered.length === 0 && (
                    <button
                      onClick={() => store.createChapter(course.id)}
                      className="block text-xs text-neutral-400 hover:text-neutral-600 px-2 py-1 ml-3"
                    >
                      ＋ 新建章节
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {courses.length === 0 && standaloneProjects.length === 0 && (
          <p className="text-center text-slate-500 py-8 text-xs">建立第一个创作集开始</p>
        )}
      </div>

      {/* 底部 Model 入口 */}
      <div className="sidebar-footer">
        <button
          onClick={onOpenModels}
          className="sidebar-model-action"
        >
          <span className="sidebar-model-icon">◌</span> 本地模型
          <span className="text-xs text-slate-500 ml-auto">{data.models.length}</span>
        </button>
      </div>
    </aside>
  )
}

// ===== 章节块（drop zone：项目拖到章节→归入该章节）=====
function ChapterBlock({
  chapter,
  projects,
  currentProjectId,
  onSelectProject,
  onCreateProject,
  dragOver,
  setDragOver,
}: {
  chapter: Chapter
  projects: Project[]
  currentProjectId: string | null
  onSelectProject: (id: string) => void
  onCreateProject: (placement: { courseId: string | null; chapterId: string | null }) => void
  dragOver: string | null
  setDragOver: Dispatch<SetStateAction<string | null>>
}) {
  const isOver = dragOver === chapter.id
  return (
    <div>
      <div
        onDragOver={(e) => {
          if (getDragItem()?.kind === 'project') {
            e.preventDefault()
            setDragOver(chapter.id)
          }
        }}
        onDragLeave={() => setDragOver((v) => (v === chapter.id ? null : v))}
        onDrop={() => {
          const item = getDragItem()
          if (item?.kind === 'project')
            store.moveProject(item.id, chapter.courseId, chapter.id)
          setDragItem(null)
          setDragOver(null)
        }}
        className={`group sidebar-chapter-row ${
          isOver ? 'is-drop-target' : ''
        }`}
      >
        <span className="text-neutral-400 text-[10px] w-4 flex-none">▹</span>
        <EditableLabel
          text={chapter.name}
          className="flex-1 truncate text-neutral-600"
          onRename={(name) => store.updateChapter(chapter.id, { name })}
        />
        <span className="hidden group-hover:flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <IconBtn
            title="新建项目"
            onClick={() => onCreateProject({ courseId: chapter.courseId, chapterId: chapter.id })}
          >
            ＋项目
          </IconBtn>
          <IconBtn
            title="删除章节"
            danger
            onClick={() => {
              if (
                confirm(
                  `删除章节「${chapter.name}」？其下项目会归到课程的未归类区（不会被删除）。`
                )
              )
                store.deleteChapter(chapter.id)
            }}
          >
            ×
          </IconBtn>
        </span>
      </div>
      <div className="ml-4">
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            active={p.id === currentProjectId}
            onSelect={onSelectProject}
          />
        ))}
        {projects.length === 0 && (
          <button
            onClick={() => onCreateProject({ courseId: chapter.courseId, chapterId: chapter.id })}
            className="block text-xs text-neutral-400 hover:text-neutral-600 px-2 py-1 ml-3"
          >
            ＋ 新建项目
          </button>
        )}
      </div>
    </div>
  )
}

// ===== 项目行（可拖拽）=====
function ProjectRow({
  project,
  active,
  onSelect,
}: {
  project: Project
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div
      draggable
      onDragStart={() => setDragItem({ kind: 'project', id: project.id })}
      onDragEnd={() => setDragItem(null)}
      onClick={() => onSelect(project.id)}
      className={`group sidebar-project-row ${
        active ? 'is-active' : ''
      }`}
    >
      <span className="text-xs opacity-50 flex-none w-4">▣</span>
      <EditableLabel
        text={project.name}
        className="flex-1 truncate"
        onRename={(name) => store.updateProject(project.id, { name })}
      />
      <span className="hidden group-hover:flex items-center" onClick={(e) => e.stopPropagation()}>
        <IconBtn
          title="删除项目"
          danger
          onClick={() => {
            if (confirm(`删除项目「${project.name}」？该画布的所有节点和数据将丢失。`))
              store.deleteProject(project.id)
          }}
        >
          ×
        </IconBtn>
      </span>
    </div>
  )
}

// ===== 双击重命名的标签 =====
function EditableLabel({
  text,
  className,
  onRename,
}: {
  text: string
  className?: string
  onRename: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(text)
  const commit = () => {
    const name = val.trim()
    if (name && name !== text) onRename(name)
    setEditing(false)
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        onClick={(e) => e.stopPropagation()}
        className="sidebar-label-input"
      />
    )
  }
  return (
    <span
      className={className}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setVal(text)
        setEditing(true)
      }}
    >
      {text}
    </span>
  )
}

// ===== 小图标按钮 =====
function IconBtn({
  children,
  title,
  onClick,
  danger,
}: {
  children: ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`text-xs px-1 py-0.5 rounded ${
        danger
          ? 'text-red-400 hover:text-red-600 hover:bg-red-50'
          : 'text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200'
      }`}
    >
      {children}
    </button>
  )
}
