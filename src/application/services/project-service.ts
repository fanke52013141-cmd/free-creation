/**
 * ProjectService — 项目管理
 *
 * 项目 CRUD 操作，委托给 ProjectStore 实现。
 */

import type { ProjectMeta, ProjectFile } from '@shared/types'
import type { Result, ServiceContext } from '../types'
import { ok, fail } from '../types'
import { requireWrite } from './authorization'

export class ProjectService {
  constructor(private ctx: ServiceContext) {}

  async listProjects(): Promise<Result<ProjectMeta[]>> {
    const projects = await this.ctx.store.listProjects()
    return ok(projects)
  }

  async getProject(id: string): Promise<Result<ProjectFile>> {
    const project = await this.ctx.store.getProject(id)
    if (!project) {
      return fail('PROJECT_NOT_FOUND', `项目不存在: ${id}`, { entityId: id })
    }
    return ok(project)
  }

  async createProject(name: string): Promise<Result<ProjectMeta>> {
    const permissionError = requireWrite(this.ctx)
    if (permissionError) return fail('WRITE_DISABLED', permissionError)
    if (!name?.trim()) {
      return fail('INVALID_NAME', '项目名不能为空')
    }
    const meta = await this.ctx.store.createProject(name.trim())

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'create-project',
      entityId: meta.id,
      after: meta
    })

    return ok(meta)
  }

  async deleteProject(id: string): Promise<Result<boolean>> {
    const permissionError = requireWrite(this.ctx)
    if (permissionError) return fail('WRITE_DISABLED', permissionError)
    const success = await this.ctx.store.deleteProject(id)
    if (!success) {
      return fail('PROJECT_NOT_FOUND', `项目不存在: ${id}`, { entityId: id })
    }

    this.ctx.audit.log({
      actor: this.ctx.actor,
      action: 'delete-project',
      entityId: id
    })

    return ok(true)
  }
}
