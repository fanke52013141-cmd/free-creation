import { useSyncExternalStore } from 'react'
import type { AppData, Course, Chapter, Project, ModelConfig } from '../types'
import { COVER_COLORS } from '../types'

const STORAGE_KEY = 'infinite-canvas-data-v1'

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function now(): string {
  return new Date().toISOString()
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      return {
        courses: p.courses ?? [],
        chapters: p.chapters ?? [],
        projects: p.projects ?? [],
        models: p.models ?? [],
      }
    }
  } catch (e) {
    console.error('载入数据失败', e)
  }
  return { courses: [], chapters: [], projects: [], models: [] }
}

let state: AppData = loadData()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function setState(updater: (prev: AppData) => AppData) {
  state = updater(state)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    console.error('保存数据失败', e)
  }
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅全局数据，组件内调用即响应式更新 */
export function useAppData(): AppData {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

// ===== CRUD 操作（遵循《开发规范-铁律v1.0》第二条）=====

/** 拖拽传递载体（模块级，dragover 时 dataTransfer 读不到，用此中转）*/
export type DragItem = { kind: 'project' | 'chapter' | 'course'; id: string }
let _dragItem: DragItem | null = null
export function setDragItem(item: DragItem | null) {
  _dragItem = item
}
export function getDragItem(): DragItem | null {
  return _dragItem
}

export const store = {
  // ---------- Course ----------
  createCourse(partial?: Partial<Pick<Course, 'name' | 'description'>>): Course {
    const course: Course = {
      id: genId('course'),
      name: partial?.name?.trim() || '新建课程',
      description: partial?.description ?? '',
      coverColor: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
      sortOrder: state.courses.length,
      createdAt: now(),
      updatedAt: now(),
    }
    setState((s) => ({ ...s, courses: [...s.courses, course] }))
    return course
  },

  updateCourse(id: string, patch: Partial<Course>) {
    setState((s) => ({
      ...s,
      courses: s.courses.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: now() } : c
      ),
    }))
  },

  /** 铁律：删除课程 → 删除其章节；项目解绑变为独立项目（不删除项目）*/
  deleteCourse(id: string) {
    setState((s) => ({
      ...s,
      courses: s.courses.filter((c) => c.id !== id),
      chapters: s.chapters.filter((ch) => ch.courseId !== id),
      projects: s.projects.map((p) =>
        p.courseId === id
          ? { ...p, courseId: null, chapterId: null, updatedAt: now() }
          : p
      ),
    }))
  },

  // ---------- Chapter ----------
  createChapter(courseId: string, name?: string): Chapter {
    const chapter: Chapter = {
      id: genId('chapter'),
      courseId,
      name: name?.trim() || '新建章节',
      sortOrder: state.chapters.filter((c) => c.courseId === courseId).length,
      createdAt: now(),
      updatedAt: now(),
    }
    setState((s) => ({ ...s, chapters: [...s.chapters, chapter] }))
    return chapter
  },

  updateChapter(id: string, patch: Partial<Chapter>) {
    setState((s) => ({
      ...s,
      chapters: s.chapters.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: now() } : c
      ),
    }))
  },

  /** 铁律：删除章节 → 项目解绑，归到课程的"未归类"区（不删除项目）*/
  deleteChapter(id: string) {
    setState((s) => ({
      ...s,
      chapters: s.chapters.filter((c) => c.id !== id),
      projects: s.projects.map((p) =>
        p.chapterId === id ? { ...p, chapterId: null, updatedAt: now() } : p
      ),
    }))
  },

  /** 移动章节到目标课程；目标若有同名章节自动追加 (1)(2) 后缀 */
  moveChapter(chapterId: string, targetCourseId: string) {
    setState((s) => {
      const chapter = s.chapters.find((c) => c.id === chapterId)
      if (!chapter || chapter.courseId === targetCourseId) return s
      const existing = s.chapters.filter((c) => c.courseId === targetCourseId)
      let name = chapter.name
      if (existing.some((c) => c.name === name)) {
        let suffix = 1
        while (existing.some((c) => c.name === `${name}(${suffix})`)) suffix++
        name = `${name}(${suffix})`
      }
      return {
        ...s,
        chapters: s.chapters.map((c) =>
          c.id === chapterId
            ? { ...c, courseId: targetCourseId, name, sortOrder: existing.length, updatedAt: now() }
            : c
        ),
        projects: s.projects.map((p) =>
          p.chapterId === chapterId
            ? { ...p, courseId: targetCourseId, updatedAt: now() }
            : p
        ),
      }
    })
  },

  // ---------- Project（= 画布）----------
  createProject(
    partial?: { name?: string; courseId?: string | null; chapterId?: string | null }
  ): Project {
    let cid = partial?.courseId ?? null
    const chid = partial?.chapterId ?? null
    if (chid) {
      const ch = state.chapters.find((c) => c.id === chid)
      if (ch) cid = ch.courseId
    }
    const project: Project = {
      id: genId('project'),
      name: partial?.name?.trim() || '新建项目',
      description: '',
      courseId: cid,
      chapterId: chid,
      sortOrder: state.projects.length,
      createdAt: now(),
      updatedAt: now(),
    }
    setState((s) => ({ ...s, projects: [...s.projects, project] }))
    return project
  },

  updateProject(id: string, patch: Partial<Project>) {
    setState((s) => ({
      ...s,
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, ...patch, updatedAt: now() } : p
      ),
    }))
  },

  deleteProject(id: string) {
    setState((s) => ({ ...s, projects: s.projects.filter((p) => p.id !== id) }))
  },

  /** 移动项目到目标课程/章节（核心拖拽灵活性）*/
  moveProject(projectId: string, courseId: string | null, chapterId: string | null) {
    setState((s) => {
      let cid = courseId
      let chid = chapterId
      if (chid) {
        const ch = s.chapters.find((c) => c.id === chid)
        if (ch) cid = ch.courseId
      } else {
        chid = null
      }
      return {
        ...s,
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, courseId: cid, chapterId: chid, updatedAt: now() } : p
        ),
      }
    })
  },

  /** 铁律：项目复制（默认浅复制；tldraw 画布用新 persistenceKey → 新空画布 = 运行结果清空）*/
  copyProject(id: string): Project | null {
    const src = state.projects.find((p) => p.id === id)
    if (!src) return null
    const copy: Project = {
      ...src,
      id: genId('project'),
      name: `${src.name} 副本`,
      createdAt: now(),
      updatedAt: now(),
    }
    setState((s) => ({ ...s, projects: [...s.projects, copy] }))
    return copy
  },

  // ---------- Model ----------
  createModel(partial: Partial<ModelConfig>): ModelConfig {
    const model: ModelConfig = {
      id: genId('model'),
      name: partial.name || '新建模型',
      provider: partial.provider || 'openai',
      apiKey: partial.apiKey || '',
      baseUrl: partial.baseUrl || '',
      modelId: partial.modelId || '',
      type: partial.type || 'chat',
      temperature: partial.temperature,
      maxTokens: partial.maxTokens,
      isDefault: partial.isDefault ?? state.models.length === 0,
    }
    setState((s) => ({ ...s, models: [...s.models, model] }))
    return model
  },

  updateModel(id: string, patch: Partial<ModelConfig>) {
    setState((s) => ({
      ...s,
      models: s.models.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }))
  },

  deleteModel(id: string) {
    setState((s) => ({ ...s, models: s.models.filter((m) => m.id !== id) }))
  },
}
