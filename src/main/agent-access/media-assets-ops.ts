// F7 收尾 media 族：产物生成来源读取（只读）+ 素材批量导出（受控目录、逐项回执）。
//
// 边界：
// - 生成来源是**运行事实**，只有执行器能写（media.saveRecipe 不对外开放，否则可伪造谱系）；
//   这里只读，且**绝不返回提示词正文**（fullPrompt）。
// - 批量导出只写受控导出目录下的新子目录，同名文件加序号后缀、绝不覆盖，逐项回执。
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { AccessOperationId } from '../../shared/agent-access/registry'
import { getArtifactRecipe } from '../store/artifact-recipes.repo'
import { getMediaAbsPath, listMedia } from '../store/media.repo'
import { getProject } from '../store/projects.repo'
import { recipeParams } from '../../shared/artifact-recipe'
import { DesktopAccessError } from './desktop'

export const MEDIA_ASSET_OPERATION_IDS: ReadonlySet<AccessOperationId> = new Set([
  'media.getRecipe',
  'media.batchExport'
] as AccessOperationId[])

export interface MediaAssetContext {
  /** 受控导出目录（服务启动时 realpath 固定）；批量导出只能写在这里。 */
  exportRoot: string
}

function refuse(code: string, detail?: string): never {
  throw new DesktopAccessError(code, false, detail)
}

/** 参数摘要：走公共 recipeParams（已剔除密钥/二进制键），再解析成对象。 */
function safeParams(paramsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(recipeParams(paramsJson)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export async function runMediaAssetOperation(
  operationId: AccessOperationId,
  input: Record<string, unknown>,
  context: MediaAssetContext
): Promise<unknown> {
  const projectId = input.projectId as string
  if (!getProject(projectId)) refuse('NOT_FOUND', 'projectId')

  if (operationId === 'media.getRecipe') {
    const mediaId = input.mediaId as string
    // 媒体必须属于该项目：避免用别的项目的 mediaId 读出别人的谱系。
    const owned = listMedia(projectId).some((asset) => asset.id === mediaId)
    if (!owned) refuse('MEDIA_NOT_FOUND', mediaId)
    const recipe = getArtifactRecipe(projectId, mediaId)
    if (!recipe) return { projectId, mediaId, found: false, recipe: null }
    return {
      projectId,
      mediaId,
      found: true,
      recipe: {
        mediaId: recipe.mediaId,
        projectId: recipe.projectId,
        producerNodeId: recipe.producerNodeId,
        nodeType: recipe.nodeType,
        contractVersion: recipe.contractVersion,
        runId: recipe.runId,
        ...(recipe.modelKey ? { modelKey: recipe.modelKey } : {}),
        ...(recipe.providerId ? { providerId: recipe.providerId } : {}),
        inputMediaIds: recipe.inputMediaIds.slice(0, 200),
        ...(recipe.missingInputMediaIds
          ? { missingInputMediaIds: recipe.missingInputMediaIds.slice(0, 200) }
          : {}),
        // 注意：绝不放 fullPrompt（提示词正文）。
        params: safeParams(recipe.paramsJson),
        createdAt: recipe.createdAt
      }
    }
  }

  // media.batchExport
  const requested = Array.isArray(input.mediaIds) ? (input.mediaIds as string[]) : null
  const all = listMedia(projectId)
  const assets = requested
    ? all.filter((asset) => requested.includes(asset.id))
    : all
  if (requested && assets.length !== new Set(requested).size) {
    const missing = requested.filter((id) => !all.some((asset) => asset.id === id))
    refuse('MEDIA_NOT_FOUND', missing.slice(0, 5).join(','))
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const directoryName = `media-export-${stamp}`
  const targetDir = join(context.exportRoot, directoryName)
  // 不覆盖：同名子目录已存在就拒绝（由调用方换一次再试，避免静默覆盖上次导出）。
  if (existsSync(targetDir)) refuse('OUTPUT_EXISTS', directoryName)
  await mkdir(targetDir, { recursive: false })

  const files: Array<{ mediaId: string; fileName: string; byteSize: number }> = []
  const failures: Array<{ mediaId: string; reason: string }> = []
  for (const asset of assets) {
    const source = getMediaAbsPath(asset.path)
    if (!source) {
      failures.push({ mediaId: asset.id, reason: 'MISSING_FILE' })
      continue
    }
    const ext = extname(asset.path)
    const rawName = asset.name ? `${asset.name}${ext}` : basename(asset.path)
    const baseName = rawName.replace(/[\\/:*?"<>|]+/g, '-').trim() || `${asset.id}${ext}`
    const extIndex = baseName.lastIndexOf('.')
    const stem = extIndex > 0 ? baseName.slice(0, extIndex) : baseName
    const suffix = extIndex > 0 ? baseName.slice(extIndex) : ''
    let copied: { fileName: string; byteSize: number } | null = null
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const fileName = attempt === 0 ? `${stem}${suffix}` : `${stem} (${attempt})${suffix}`
      try {
        await copyFile(source, join(targetDir, fileName), fsConstants.COPYFILE_EXCL)
        const bytes = await readFile(join(targetDir, fileName))
        copied = { fileName, byteSize: bytes.length }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break
      }
    }
    if (copied) files.push({ mediaId: asset.id, ...copied })
    else failures.push({ mediaId: asset.id, reason: 'COPY_FAILED' })
  }
  return {
    projectId,
    directoryName,
    exported: files.length,
    failed: failures.length,
    files,
    failures
  }
}
