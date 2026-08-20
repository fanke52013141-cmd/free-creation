// ===== 核心 数据模型（遵循《开发规范-铁律v1.0》第二部分）=====

/** 课程：顶层容器 */
export interface Course {
  id: string
  name: string
  description: string
  coverColor: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** 章节：课程内分组 */
export interface Chapter {
  id: string
  courseId: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** 项目 = 一张无限画布 */
export interface Project {
  id: string
  name: string
  description: string
  /** null = 独立项目 */
  courseId: string | null
  /** null = 课程下的"未归类"区 */
  chapterId: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** 模型类型用途 */
export type ModelType = 'chat' | 'image' | 'video' | 'audio' | 'embedding'

/** 模型配置（Model 设定模块）*/
export interface ModelConfig {
  id: string
  name: string
  provider: string
  apiKey: string
  baseUrl: string
  modelId: string
  type: ModelType
  temperature?: number
  maxTokens?: number
  isDefault?: boolean
}

/** 整个应用的持久化数据（localStorage）*/
export interface AppData {
  courses: Course[]
  chapters: Chapter[]
  projects: Project[]
  models: ModelConfig[]
}

/** 主题色池（沿用 PPT 项目）*/
export const COVER_COLORS = [
  '#5B7893', '#3D5A80', '#1B998B', '#4C956C',
  '#F6AE2D', '#E84A5F', '#7B2CBF', '#2F80ED',
]

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: '对话',
  image: '图片生成',
  video: '视频生成',
  audio: '音频生成',
  embedding: '向量',
}
